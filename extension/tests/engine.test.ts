import { describe, expect, it } from 'vitest';
import { initialEngineState, step, type EngineState } from '../src/background/confusionEngine';
import { EngineStore, type KV } from '../src/background/engineStore';
import { enterCooldown, initialTriggerState, stepTrigger } from '../src/background/triggerMachine';
import { NORMAL_TRIGGER } from '../src/shared/constants';
import type { EngineInput, FaceReading, PageSignals, Signal } from '../src/shared/types';

const page = (over: Partial<PageSignals> = {}): PageSignals => ({
  activity: [],
  idleMs: 0,
  dwellMs: 0,
  questionLabel: 'Q4',
  ...over,
});
const rage: Signal = { id: 'rageClicks', value: 1, reason: 'rapid repeated clicks' };
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
  it('uses activity/face gains when a face is visible', () => {
    const { output } = run(200, () => ({ page: page({ activity: [rage] }), tab: [], face: faceOn() }));
    // activity channel = 0.6 (rageClicks weight), face = 0 → raw = 0.7 * 0.6
    expect(output.channels.activity).toBeCloseTo(0.6);
    expect(Math.abs(output.score - 42)).toBeLessThanOrEqual(0.5);
  });

  it('ignores the face when none is visible', () => {
    const { output } = run(200, () => ({
      page: page({ activity: [rage] }),
      tab: [],
      face: { signals: [furrow], facePresent: false, gazeAway: false },
    }));
    // face signals are ignored and don't drag the score down → same as the face-on, no-expression case
    expect(output.channels.face).toBe(0);
    expect(output.score).toBeCloseTo(42, 0);
  });

  it('two agreeing channels reinforce each other', () => {
    const solo = run(200, () => ({ page: page({ activity: [rage] }), tab: [], face: faceOn() })).output.score;
    const both = run(200, () => ({ page: page({ activity: [rage] }), tab: [], face: faceOn([furrow]) })).output.score;
    // noisy-OR: 1 - (1-0.42)(1-0.55*0.8) = 67.5 vs 42
    expect(Math.abs(both - solo - 25.5)).toBeLessThanOrEqual(1);
  });

  it('smooths with EMA instead of jumping', () => {
    const { output } = run(2, () => ({ page: page({ activity: [rage] }), tab: [], face: faceOn() }));
    expect(output.score).toBeLessThan(15);
  });

  it('names human-readable reasons in topContributors', () => {
    const { output } = run(5, () => ({ page: page({ activity: [rage] }), tab: [], face: faceOn([furrow]) }));
    expect(output.topContributors[0]).toBe('brow furrowed');
    expect(output.topContributors).toContain('rapid repeated clicks');
    expect(output.topContributors).toContain('brow furrowed');
  });

  it('pauses the idle timer while the student looks away (writing on paper)', () => {
    // 60s of no input: first 56s looking away, last 4s looking at the screen.
    const away = run(60, (t) => ({
      page: page({ idleMs: t }),
      tab: [],
      face: { signals: [], facePresent: true, gazeAway: t < 56_000 },
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

describe('triggerMachine', () => {
  const ctx = { enabled: true, snoozedUntil: 0 };
  // Explicit so the tests don't move when the defaults are retuned.
  const cfg = { threshold: 60, durationSec: 45, cooldownSec: 180 };

  it('defaults to a low threshold that a single strong channel can reach', () => {
    expect(NORMAL_TRIGGER.threshold).toBe(35);
  });

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

  it('keeps the timer through small dips (hysteresis)', () => {
    const scores = [...Array(20).fill(70), ...Array(5).fill(55), ...Array(30).fill(70)];
    expect(drive(scores).fired).toBe(45);
  });

  it('resets on a big dip', () => {
    const scores = [...Array(20).fill(70), 40, ...Array(30).fill(70)];
    expect(drive(scores).fired).toBe(-1);
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
    const input = (now: number): EngineInput => ({ now, page: page({ activity: [rage] }), tab: [], face: faceOn([furrow]) });

    for (let i = 0; i < 30; i++) {
      const r = step(engine, input(i * 1000));
      engine = r.state;
      trigger = stepTrigger(trigger, r.output.score, i * 1000, { ...NORMAL_TRIGGER, threshold: 30, durationSec: 60 }, ctxOn).state;
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
