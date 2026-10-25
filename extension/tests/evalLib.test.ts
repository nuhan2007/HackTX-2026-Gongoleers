import { describe, expect, it } from 'vitest';
import type { LabelLog } from '../src/background/labelLogger';
import { evaluate, replayTriggers } from '../tools/evalLib';

function log(scores: number[], labelsAtSec: number[]): LabelLog {
  return {
    sessionStart: 0,
    ticks: scores.map((score, i) => ({ t: i * 1000, score, channels: { activity: 0, face: 0 }, signals: {}, fired: false })),
    labels: labelsAtSec.map((s) => s * 1000),
  };
}

describe('evalLib', () => {
  // Stuck from 100s to 200s; the student pressed the key at 150s.
  const scores = Array.from({ length: 300 }, (_, i) => (i >= 100 && i < 200 ? 80 : 20));
  const l = log(scores, [150]);

  it('replays the trigger machine over recorded scores', () => {
    expect(replayTriggers(l, { threshold: 60, durationSec: 30, cooldownSec: 60 })).toEqual([130_000]);
  });

  it('computes precision, recall and lead time', () => {
    const r = evaluate([l], 60, 30);
    expect(r.precision).toBe(1);
    expect(r.recall).toBe(1);
    expect(r.medianLeadSec).toBe(20);
  });

  it('counts a trigger with no nearby label as a false positive', () => {
    const noisy = log(Array.from({ length: 300 }, (_, i) => ((i >= 100 && i < 200) || (i >= 250 && i < 290) ? 80 : 20)), [150]);
    const r = evaluate([noisy], 60, 30);
    expect(r.triggers).toBe(2);
    expect(r.precision).toBe(0.5);
  });

  it('misses a label when the duration is too long', () => {
    expect(evaluate([l], 60, 120).recall).toBe(0);
  });
});
