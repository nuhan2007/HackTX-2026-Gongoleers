import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { calmScore, DEFAULT_COMPLEXITY_STEP_SEC, scaledWait } from '../src/shared/constants';
import { DEFAULT_SETTINGS, finishConfig, firstCheckpointMs, getSettings, readiness, reviewMs, triggerConfig, tuningNote, type Settings } from '../src/shared/settings';

const settings = (over: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, ...over });

describe('harder problems wait longer', () => {
  it('adds the step for each level of difficulty above the easiest', () => {
    expect([1, 2, 3, 4, 5].map((d) => scaledWait(5, d, 5))).toEqual([5, 10, 15, 20, 25]);
  });

  it('is just the base with no problem being followed, or with the step set to zero', () => {
    expect(scaledWait(5, null, 5)).toBe(5);
    expect(scaledWait(5, undefined, 5)).toBe(5);
    expect(scaledWait(5, 5, 0)).toBe(5);
  });

  it('clamps a difficulty the model got wrong', () => {
    expect(scaledWait(5, 9, 5)).toBe(25);
    expect(scaledWait(5, -3, 5)).toBe(5);
    expect(scaledWait(5, 2.6, 5)).toBe(15);
  });

  it('shapes the sprite rule: the slider plus the step, per problem', () => {
    const s = settings({ threshold: 30, durationSec: 5, complexityStepSec: 5, cooldownSec: 20 });
    expect(triggerConfig(s)).toEqual({ threshold: 30, durationSec: 5, cooldownSec: 20 });
    expect(triggerConfig(s, 1).durationSec).toBe(5);
    expect(triggerConfig(s, 4).durationSec).toBe(20);
  });

  it('applies to when the student counts as finished too (a harder problem has longer thinking pauses)', () => {
    const s = settings({ finishIdleSec: 8, complexityStepSec: 5 });
    expect(finishConfig(s)!.idleMs).toBe(8000);
    expect(finishConfig(s, 3)!.idleMs).toBe(18_000);
  });

  it('is on by default', () => {
    expect(DEFAULT_COMPLEXITY_STEP_SEC).toBeGreaterThan(0);
    expect(DEFAULT_SETTINGS.complexityStepSec).toBe(DEFAULT_COMPLEXITY_STEP_SEC);
  });
});

describe('finished means calm: below the threshold the sprite uses', () => {
  it('is one under the threshold, so the two rules never both apply', () => {
    expect(calmScore(30)).toBe(29);
    expect(finishConfig(settings({ threshold: 40 }))!.calmBelow).toBe(39);
    expect(finishConfig(settings({ threshold: 25 }))!.calmBelow).toBe(24);
  });

  it('is off when automatic checking is switched off', () => {
    expect(finishConfig(settings({ autoCheck: false }))).toBeNull();
  });
});

describe('reading the work as it is written', () => {
  it('is every few seconds, clamped to something sensible, and off when switched off', () => {
    expect(reviewMs(settings({ reviewSec: 5 }))).toBe(5000);
    expect(reviewMs(settings({ reviewSec: 1 }))).toBe(3000);
    expect(reviewMs(settings({ reviewSec: 600 }))).toBe(60_000);
    expect(reviewMs(settings({ continuousReview: false }))).toBeNull();
  });

  it('defaults to every 5 seconds', () => {
    expect(reviewMs(DEFAULT_SETTINGS)).toBe(5000);
  });
});

describe('saved settings', () => {
  let stored: Record<string, unknown>;
  beforeEach(() => {
    stored = {};
    vi.stubGlobal('chrome', { storage: { local: { get: async () => ({ settings: stored }), set: async () => {} } } });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('moves values that were never changed from the old defaults to the new ones, once', async () => {
    stored = { threshold: 60, durationSec: 45, cooldownSec: 180, finishIdleSec: 10 };
    const s = await getSettings();
    expect(s).toMatchObject({ threshold: 40, durationSec: 5, cooldownSec: 30, finishIdleSec: 8, settingsVersion: 3 });
  });

  it('leaves what the student set alone', async () => {
    stored = { threshold: 30, durationSec: 12, cooldownSec: 60, finishIdleSec: 4 };
    const s = await getSettings();
    expect(s).toMatchObject({ threshold: 30, durationSec: 12, cooldownSec: 60, finishIdleSec: 4 });
  });

  it('does not touch settings saved under the new defaults, even when they equal the old numbers', async () => {
    stored = { settingsVersion: 2, threshold: 60, durationSec: 45 };
    const s = await getSettings();
    expect(s).toMatchObject({ threshold: 60, durationSec: 45 });
  });

  it('forgets the old demo mode, which used to replace the sliders without saying so', async () => {
    stored = { demoMode: true, threshold: 30, durationSec: 5 };
    const s = await getSettings();
    expect(s).not.toHaveProperty('demoMode');
    expect(triggerConfig(s)).toMatchObject({ threshold: 30, durationSec: 5 });
  });

  it('fills in the new options for a student who saved settings before they existed', async () => {
    stored = { geminiKey: 'k', threshold: 33 };
    const s = await getSettings();
    expect(s).toMatchObject({ geminiKey: 'k', threshold: 33, continuousReview: true, autoHint: true, autoTrack: true, autoCheck: true, adaptive: true });
  });

  it('drops the OpenAI key and model name of the old version, and falls back to the Gemini models', async () => {
    stored = { openaiKey: 'sk-old', model: 'gpt-6-luna', solverModel: 'gpt-6-sol', threshold: 33 };
    const s = await getSettings();
    expect(s).not.toHaveProperty('openaiKey');
    expect(s).toMatchObject({ model: 'gemini-3.8-flash', solverModel: 'gemini-4-argon', threshold: 33, geminiKey: '' });
  });

  it('keeps a Gemini model the student chose', async () => {
    stored = { model: 'gemini-3.6-flash', solverModel: 'gemini-3.1-pro-preview' };
    const s = await getSettings();
    expect(s).toMatchObject({ model: 'gemini-3.6-flash', solverModel: 'gemini-3.1-pro-preview' });
  });
});

describe('myTA adapts to the problem it is following', () => {
  const circuit = { difficulty: 4, domain: 'circuits' as const, workFormat: 'mixed' as const, expectedMinutes: 12, problemKind: 'node voltage analysis' };
  const algebra = { difficulty: 4, domain: 'algebra' as const, workFormat: 'equations' as const, expectedMinutes: 3 };
  const s = settings({ threshold: 40, durationSec: 5, complexityStepSec: 5, reviewSec: 5, finishIdleSec: 8 });

  it('never moves the threshold: the slider is what the score is compared with', () => {
    expect(triggerConfig(s, circuit).threshold).toBe(40);
    expect(triggerConfig(s, algebra).threshold).toBe(40);
    expect(finishConfig(s, circuit)!.calmBelow).toBe(39);
  });

  it('waits a little longer before stepping in on work that is drawn or annotated (a circuit), as well as for the difficulty', () => {
    expect(triggerConfig(s, algebra).durationSec).toBe(20);
    expect(triggerConfig(s, circuit).durationSec).toBe(25);
    expect(triggerConfig(s, { ...circuit, workFormat: 'diagram' }).durationSec).toBe(25);
  });

  it('reads a drawn solution less often, and counts it finished after a longer pause', () => {
    expect(reviewMs(s, algebra)).toBe(5000);
    expect(reviewMs(s, circuit)).toBe(7500);
    expect(finishConfig(s, algebra)!.idleMs).toBe(23_000);
    expect(finishConfig(s, circuit)!.idleMs).toBe(34_500);
  });

  it('puts the first "a while on this problem" look at half the time a typical student needs, within limits', () => {
    expect(firstCheckpointMs(s, { expectedMinutes: 5 })).toBe(150_000);
    expect(firstCheckpointMs(s, circuit)).toBe(240_000); // 12 minutes expected: capped
    expect(firstCheckpointMs(s, algebra)).toBe(90_000);
    expect(firstCheckpointMs(s, { expectedMinutes: 1 })).toBe(45_000);
    expect(firstCheckpointMs(s, { expectedMinutes: 60 })).toBe(240_000);
    expect(firstCheckpointMs(s, { difficulty: 3 })).toBeNull();
  });

  it('does none of it with adapting switched off: just the sliders and the per-level step', () => {
    const off = settings({ ...s, adaptive: false });
    expect(triggerConfig(off, circuit).durationSec).toBe(20);
    expect(reviewMs(off, circuit)).toBe(5000);
    expect(finishConfig(off, circuit)!.idleMs).toBe(23_000);
    expect(firstCheckpointMs(off, circuit)).toBeNull();
    expect(tuningNote(off, circuit)).toBe('');
  });

  it('says in words what it did, for the panel', () => {
    const note = tuningNote(s, circuit);
    expect(note).toContain('node voltage analysis');
    expect(note).toContain('difficulty 4');
    expect(note).toContain('steps in after 25s above 40');
    expect(note).toContain('reads every 8s');
    expect(note).toContain('about 12 min');
    expect(tuningNote(s, null)).toBe('');
  });

  it('a bare number is still just the difficulty', () => {
    expect(triggerConfig(s, 4).durationSec).toBe(20);
  });
});

describe('what has to be set up', () => {
  it('needs the Gemini key, the SerpApi key and the camera', () => {
    expect(readiness(DEFAULT_SETTINGS).missing).toEqual(['Gemini API key', 'SerpApi key', 'camera access', 'camera calibration']);
  });
});
