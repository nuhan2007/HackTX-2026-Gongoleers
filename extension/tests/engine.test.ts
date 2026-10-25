import { describe, expect, it } from 'vitest';
import { initialEngineState, step, type EngineState } from '../src/background/confusionEngine';
import { EngineStore, type KV } from '../src/background/engineStore';
import { enterCooldown, initialTriggerState, stepTrigger, triggerProgress } from '../src/background/triggerMachine';
import { NORMAL_TRIGGER } from '../src/shared/constants';
import type { EngineInput, FaceReading, PageSignals, Signal } from '../src/shared/types';

const page = (over: Partial<PageSignals> = {}): PageSignals => ({
  content: [],
  activity: [],
  idleMs: 0,
  dwellMs: 0,
  questionLabel: 'Q4',
  ...over,
});
const incorrect: Signal = { id: 'incorrect', value: 1, reason: 'Incorrect ×2 on Q4' };
const furrow: Signal = { id: 'browFurrow', value: 1, reason: 'brow furrowed' };
const faceOn = (signals: Signal[] = []): FaceReading => ({ signals, facePresent: true, gazeAway: false });

function run(n: number, input: (t: number) => Omit<EngineInput, 'now'>, start = initialEngineState(), t0 = 0) {
  let s: EngineState = start;
  let out = step(s, { now: t0, ...input(t0) }).output;
  for (let i = 0; i < n; i++) {
    const now = t0 + i * 1000;
    const r = step(s, { now, ...input(now) });
    s = r.state;
    out = r.output;
  }
  return { state: s, output: out };
}

describe('confusionEngine fusion', () => {
  it('uses 0.5/0.3/0.2 weights when a face is visible', () => {
    const { output } = run(200, () => ({ page: page({ content: [incorrect] }), tab: [], face: faceOn() }));
    // content channel = 0.85, face = 0, activity = 0 → raw = 0.5 * 0.85
    expect(output.channels.content).toBeCloseTo(0.85);
    expect(Math.abs(output.score - 42.5)).toBeLessThanOrEqual(0.5);
  });

  it('spreads the face weight over content/activity when no face is present', () => {
    const { output } = run(200, () => ({
      page: page({ content: [incorrect] }),
      tab: [],
      face: { signals: [furrow], facePresent: false, gazeAway: false },
    }));
    // raw = (0.5 / 0.8) * 0.85; face signals ignored
    expect(output.channels.face).toBe(0);
    expect(output.score).toBeCloseTo(53, 0);
  });

  it('adds the agreement bonus when two channels are high', () => {
    const solo = run(200, () => ({ page: page({ content: [incorrect] }), tab: [], face: faceOn() })).output.score;
    const both = run(200, () => ({ page: page({ content: [incorrect] }), tab: [], face: faceOn([furrow]) })).output.score;
    // face channel 0.7 → +0.2*0.7 = 14 points, plus 10 bonus
    expect(both - solo).toBeCloseTo(24, 0);
  });

  it('smooths with EMA instead of jumping', () => {
    const { output } = run(2, () => ({ page: page({ content: [incorrect] }), tab: [], face: faceOn() }));
    expect(output.score).toBeLessThan(15);
  });

  it('names human-readable reasons in topContributors', () => {
    const { output } = run(5, () => ({ page: page({ content: [incorrect] }), tab: [], face: faceOn([furrow]) }));
    expect(output.topContributors[0]).toBe('Incorrect ×2 on Q4');
    expect(output.topContributors).toContain('brow furrowed');
  });

  it('pauses the idle timer while the student looks away (writing on paper)', () => {
    // 60s of no input: first 40s looking away, last 20s looking at the screen.
    const away = run(60, (t) => ({
      page: page({ idleMs: t }),
      tab: [],
      face: { signals: [], facePresent: true, gazeAway: t < 40_000 },
    }));
    const present = run(60, (t) => ({ page: page({ idleMs: t }), tab: [], face: faceOn() }));
    expect(away.output.topContributors.some((r) => r.startsWith('idle'))).toBe(false);
    expect(present.output.topContributors.some((r) => r.startsWith('idle'))).toBe(true);
    expect(away.output.score).toBeLessThan(present.output.score);
  });

  it('does not count gazeAway/faceAbsent as confusion', () => {
    const { output } = run(100, () => ({ page: page(), tab: [], face: { signals: [], facePresent: false, gazeAway: true } }));
    expect(output.score).toBe(0);
  });
});

describe('the sprite rule as the setup sliders set it', () => {
  const ctx = { enabled: true, snoozedUntil: 0 };

  it('the shipped defaults are a threshold of 40 held for 5 seconds, with a short rest after a nudge', () => {
    expect(NORMAL_TRIGGER).toEqual({ threshold: 40, durationSec: 5, cooldownSec: 30 });
  });

  it('with 5 seconds, fires on the fifth second at or above the threshold (and not on the fourth)', () => {
    let s = initialTriggerState();
    const fired: number[] = [];
    for (let i = 0; i < 10; i++) {
      const r = stepTrigger(s, 41, i * 1000, NORMAL_TRIGGER, ctx);
      s = r.state;
      if (r.fired) fired.push(i);
    }
    expect(fired).toEqual([5]);
  });

  it('a score of 30 against a threshold of 30 counts', () => {
    let s = initialTriggerState();
    let fired = false;
    for (let i = 0; i < 8; i++) {
      const r = stepTrigger(s, 30, i * 1000, { threshold: 30, durationSec: 5, cooldownSec: 30 }, ctx);
      s = r.state;
      fired ||= r.fired;
    }
    expect(fired).toBe(true);
  });

  it('can fire again after the rest, so the sprite keeps coming back for someone who stays confused', () => {
    let s = initialTriggerState();
    const fired: number[] = [];
    for (let i = 0; i < 100; i++) {
      const r = stepTrigger(s, 60, i * 1000, NORMAL_TRIGGER, ctx);
      s = r.state;
      if (r.fired) {
        fired.push(i);
        s = enterCooldown(s, i * 1000, NORMAL_TRIGGER); // they dismissed it
      }
    }
    expect(fired.length).toBeGreaterThanOrEqual(3);
    expect(fired[1] - fired[0]).toBe(30 + 5);
  });
});

describe('triggerMachine', () => {
  const ctx = { enabled: true, snoozedUntil: 0 };
  const cfg = { threshold: 60, durationSec: 45, cooldownSec: 180 }; // pinned here: these tests are about the rule, not the defaults

  function drive(scores: number[], s = initialTriggerState(), t0 = 0) {
    let fired = -1;
    scores.forEach((score, i) => {
      const r = stepTrigger(s, score, t0 + i * 1000, cfg, ctx);
      s = r.state;
      if (r.fired && fired < 0) fired = i;
    });
    return { s, fired };
  }

  it('fires after the score stays above threshold for durationSec', () => {
    const { fired, s } = drive(Array(60).fill(70));
    expect(fired).toBe(45);
    expect(s.phase).toBe('confused');
  });

  it('starts the count when the score reaches the threshold, and at exactly the threshold', () => {
    expect(drive([10, 20, ...Array(60).fill(60)]).fired).toBe(2 + 45);
  });

  it('starts over if the score drops below the threshold, even briefly', () => {
    // 40 s above (not enough), one tick at 59, then the count starts again from zero.
    expect(drive([...Array(40).fill(70), 59, ...Array(40).fill(70)]).fired).toBe(-1);
    expect(drive([...Array(40).fill(70), 59, ...Array(50).fill(70)]).fired).toBe(40 + 1 + 45);
  });

  it('keeps the sprite up through a small dip, and hides it only once the score is clearly lower', () => {
    let { s } = drive(Array(46).fill(70));
    expect(s.phase).toBe('confused');
    expect(stepTrigger(s, 55, 50_000, cfg, ctx).state.phase).toBe('confused');
    expect(stepTrigger(s, 45, 50_000, cfg, ctx).state.phase).toBe('cooldown');
  });

  it('reports how long the score has been above the threshold', () => {
    const { s } = drive(Array(20).fill(70)); // ticks at t = 0..19 s
    expect(triggerProgress(s, 19_000).aboveSec).toBe(19);
    expect(triggerProgress(initialTriggerState(), 19_000).aboveSec).toBeNull();
  });

  it('does not fire again during cooldown', () => {
    let { s } = drive(Array(46).fill(70));
    s = enterCooldown(s, 46_000, cfg);
    const after = drive(Array(170).fill(90), s, 47_000);
    expect(after.fired).toBe(-1);
    expect(after.s.phase).toBe('cooldown');
    const later = drive(Array(60).fill(90), after.s, 47_000 + 180_000);
    expect(later.fired).toBe(45);
  });

  it('honors snooze and the off switch', () => {
    let s = initialTriggerState();
    for (let i = 0; i < 100; i++) s = stepTrigger(s, 90, i * 1000, cfg, { enabled: false, snoozedUntil: 0 }).state;
    expect(s.phase).toBe('idle');
    for (let i = 0; i < 100; i++) s = stepTrigger(s, 90, i * 1000, cfg, { enabled: true, snoozedUntil: 1e9 }).state;
    expect(s.phase).toBe('idle');
  });
});

describe('engineStore', () => {
  class FakeKV implements KV {
    data: Record<string, unknown> = {};
    async get(key: string) {
      // Round-trip through JSON like chrome.storage does.
      return key in this.data ? { [key]: JSON.parse(JSON.stringify(this.data[key])) } : {};
    }
    async set(items: Record<string, unknown>) {
      Object.assign(this.data, JSON.parse(JSON.stringify(items)));
    }
  }

  it('state survives a simulated service-worker restart', async () => {
    const kv = new FakeKV();
    const store = new EngineStore(kv);
    let { engine, trigger } = await store.load();
    const input = (now: number): EngineInput => ({ now, page: page({ content: [incorrect] }), tab: [], face: faceOn([furrow]) });

    for (let i = 0; i < 30; i++) {
      const r = step(engine, input(i * 1000));
      engine = r.state;
      trigger = stepTrigger(trigger, r.output.score, i * 1000, { threshold: 30, durationSec: 45, cooldownSec: 180 }, ctxOn).state;
      await store.save({ engine, trigger });
    }

    // "Restart": a brand-new store instance reading the same storage.
    const revived = await new EngineStore(kv).load();
    expect(revived).toEqual({ engine, trigger });
    expect(revived.trigger.phase).toBe('rising');

    // Continuing from revived state matches continuing from the in-memory state.
    const a = step(engine, input(30_000)).output.score;
    const b = step(revived.engine, input(30_000)).output.score;
    expect(b).toBe(a);
  });
});
const ctxOn = { enabled: true, snoozedUntil: 0 };
