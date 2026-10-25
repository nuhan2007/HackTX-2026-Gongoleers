import { describe, expect, it } from 'vitest';
import { initialEngineState, step, type EngineState } from '../src/background/confusionEngine';
import { FaceSmoother, toSignals, type RawFace } from '../src/shared/faceSignals';
import type { CalibrationBaseline, Signal } from '../src/shared/types';

const neutral: RawFace = { browFurrow: 0.1, browRaise: 0.1, squint: 0.2, lipPress: 0.1, headTilt: 3 };
const baseline: CalibrationBaseline = {
  mean: { ...neutral },
  std: { browFurrow: 0.02, browRaise: 0.02, squint: 0.02, lipPress: 0.02, headTilt: 1 },
  capturedAt: 0,
};
const furrowed = (v: number): RawFace => ({ ...neutral, browFurrow: v });

describe('FaceSmoother', () => {
  it('ignores a one-frame spike (blink, sneeze)', () => {
    const s = new FaceSmoother();
    for (let i = 0; i < 10; i++) s.push(neutral);
    const out = s.push(furrowed(0.9));
    expect(out.browFurrow).toBeCloseTo(0.1, 5);
  });

  it('follows a held expression gradually', () => {
    const s = new FaceSmoother();
    for (let i = 0; i < 10; i++) s.push(neutral);
    const trail: number[] = [];
    for (let i = 0; i < 15; i++) trail.push(s.push(furrowed(0.5)).browFurrow);
    // Rises monotonically, no jump on the first frames, close to the target after ~15s.
    for (let i = 1; i < trail.length; i++) expect(trail[i]).toBeGreaterThanOrEqual(trail[i - 1]);
    expect(trail[2]).toBeLessThan(0.25);
    expect(trail[14]).toBeGreaterThan(0.4);
  });
});

describe('toSignals', () => {
  it('needs a clear change before a feature counts', () => {
    // +0.01 above a calm baseline: inside the 0.03 σ floor × 0.8 → nothing.
    expect(toSignals(furrowed(0.11), baseline)).toEqual([]);
    // A mild furrow (+0.08 ≈ 2.7σ) already counts fully.
    const mild = toSignals(furrowed(0.18), baseline).find((s) => s.id === 'browFurrow');
    expect(mild?.value).toBe(1);
  });
});

describe('engine smoothing', () => {
  it('a flickering face signal barely moves the score', () => {
    let s: EngineState = initialEngineState();
    const scores: number[] = [];
    const furrow: Signal = { id: 'browFurrow', value: 1, reason: 'brow furrowed' };
    for (let i = 0; i < 120; i++) {
      // Face flips between "very furrowed" and neutral every second.
      const r = step(s, {
        now: i * 1000,
        page: { activity: [], idleMs: 0, dwellMs: 0, questionLabel: 'Q1' },
        tab: [],
        face: { signals: i % 2 ? [furrow] : [], facePresent: true, gazeAway: false },
      });
      s = r.state;
      scores.push(r.output.score);
    }
    const tail = scores.slice(-30);
    const swing = Math.max(...tail) - Math.min(...tail);
    expect(swing).toBeLessThanOrEqual(3);
    // The meter shown in the side panel is steady too.
    expect(s.channels.face).toBeGreaterThan(0.25);
    expect(s.channels.face).toBeLessThan(0.5);
  });

  it('the agreement bonus ramps in instead of jumping', () => {
    const scoreWith = (contentValue: number) => {
      let s = initialEngineState();
      let out = 0;
      for (let i = 0; i < 300; i++) {
        const r = step(s, {
          now: i * 1000,
          page: { activity: [{ id: 'rageClicks', value: contentValue, reason: 'x' }], idleMs: 0, dwellMs: 0, questionLabel: 'Q1' },
          tab: [],
          face: { signals: [{ id: 'browFurrow', value: 1, reason: 'y' }], facePresent: true, gazeAway: false },
        });
        s = r.state;
        out = r.output.score;
      }
      return out;
    };
    // Stepping the activity channel across the bonus ramp changes the score smoothly.
    const a = scoreWith(0.55);
    const b = scoreWith(0.6);
    expect(b - a).toBeLessThan(6);
  });
});
