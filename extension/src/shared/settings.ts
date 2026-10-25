import {
  calmScore,
  DEFAULT_COMPLEXITY_STEP_SEC,
  DEFAULT_FINISH_IDLE_SEC,
  DEFAULT_MODEL,
  DEFAULT_REVIEW_SEC,
  DEFAULT_SNAPSHOT_SEC,
  DEFAULT_SOLVER_MODEL,
  MAX_FINISH_IDLE_SEC,
  MAX_REVIEW_SEC,
  MAX_SNAPSHOT_SEC,
  MIN_FINISH_IDLE_SEC,
  MIN_REVIEW_SEC,
  MIN_SNAPSHOT_SEC,
  NORMAL_TRIGGER,
  scaledWait,
  type TriggerConfig,
} from './constants';
import type { CalibrationBaseline, Domain, WorkFormat } from './types';

export interface Settings {
  /** Which defaults this was saved under (see `migrate`). */
  settingsVersion: number;
  geminiKey: string;
  serpKey: string;
  /** The quick model: reads the work, writes hints, judges them. */
  model: string;
  /** The stronger model that works each problem out once (the answer key everything else is checked against). */
  solverModel: string;
  enabled: boolean;
  devMode: boolean; // shows "Force trigger"
  labelMode: boolean;
  threshold: number;
  durationSec: number;
  cooldownSec: number;
  /** How often the monitored tabs are captured and stored on this device. */
  snapshotSec: number;
  /** Seconds added to the sprite's wait (and to "finished") for each level of problem difficulty above the easiest. 0 = same wait for every problem. */
  complexityStepSec: number;
  /** Let myTA tune the waits and the reading pace to each problem (its difficulty, the subject, how the work looks), starting from the numbers above. */
  adaptive: boolean;
  /** While the student writes, the model reads their work every `reviewSec` seconds (when it changed), and right after each finished line. */
  continuousReview: boolean;
  reviewSec: number;
  /** When the sprite appears, it has already read the student's work and shows a hint on the spot. */
  autoHint: boolean;
  /** Whenever a reading of the student's work finds a mistake (a wrong step, or the problem copied down wrongly), the sprite says so right away. */
  flagMistakes: boolean;
  /** When the student gets the answer right, the sprite pops up to congratulate them. */
  celebrate: boolean;
  /** Notice the problem the student is on and work it out privately, without anyone asking. */
  autoTrack: boolean;
  /** When the student looks finished (idle for `finishIdleSec`, confusion low), check the answer and show the sprite if it's wrong. */
  autoCheck: boolean;
  finishIdleSec: number;
  cameraGranted: boolean;
  calibration: CalibrationBaseline | null;
  snoozedUntil: number;
}

const SETTINGS_VERSION = 3;

export const DEFAULT_SETTINGS: Settings = {
  settingsVersion: SETTINGS_VERSION,
  geminiKey: '',
  serpKey: '',
  model: DEFAULT_MODEL,
  solverModel: DEFAULT_SOLVER_MODEL,
  enabled: true,
  devMode: false,
  labelMode: false,
  ...NORMAL_TRIGGER,
  snapshotSec: DEFAULT_SNAPSHOT_SEC,
  complexityStepSec: DEFAULT_COMPLEXITY_STEP_SEC,
  adaptive: true,
  continuousReview: true,
  reviewSec: DEFAULT_REVIEW_SEC,
  autoHint: true,
  flagMistakes: true,
  celebrate: true,
  autoTrack: true,
  autoCheck: true,
  finishIdleSec: DEFAULT_FINISH_IDLE_SEC,
  cameraGranted: false,
  calibration: null,
  snoozedUntil: 0,
};

const KEY = 'settings';

/** The sprite numbers an untouched install used to have; saved settings that still equal them were never changed by the student. */
const OLD_DEFAULTS = { threshold: 60, durationSec: 45, cooldownSec: 180, finishIdleSec: 10 };

function migrate(stored: Partial<Settings> & { openaiKey?: string; demoMode?: boolean }): Settings {
  // `demoMode` used to silently replace the sliders with fixed numbers (so a threshold set in setup could be ignored). It's gone:
  // the numbers on the sliders are the numbers in force. `openaiKey` belonged to the OpenAI version; the key is for Gemini now.
  const { openaiKey: _old, demoMode: _demo, ...rest } = stored;
  if ((rest.settingsVersion ?? 1) < 2) {
    // One time: a value that still equals the old default was never touched, so it moves to the new default; anything the student set stays.
    for (const k of Object.keys(OLD_DEFAULTS) as (keyof typeof OLD_DEFAULTS)[]) if (rest[k] === OLD_DEFAULTS[k]) delete rest[k];
  }
  const merged = { ...DEFAULT_SETTINGS, ...rest, settingsVersion: SETTINGS_VERSION };
  // A model name from another provider can't work with Gemini.
  if (!/^gemini/i.test(merged.model)) merged.model = DEFAULT_MODEL;
  if (!/^gemini/i.test(merged.solverModel)) merged.solverModel = DEFAULT_SOLVER_MODEL;
  return merged;
}

export async function getSettings(): Promise<Settings> {
  const { [KEY]: stored } = await chrome.storage.local.get(KEY);
  return migrate(stored ?? {});
}

export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}

export function onSettingsChanged(cb: (s: Settings) => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[KEY]) cb(migrate((changes[KEY].newValue ?? {}) as Partial<Settings>));
  });
}

/** What myTA knows about the problem being followed that changes how patient and how attentive it is. A bare number is the difficulty. */
export interface ProblemTraits {
  difficulty?: number | null;
  domain?: Domain | null;
  workFormat?: WorkFormat | null;
  /** Minutes a typical student needs. */
  expectedMinutes?: number | null;
  problemKind?: string | null;
}

export const traitsOf = (t?: number | ProblemTraits | null): ProblemTraits => (typeof t === 'number' ? { difficulty: t } : (t ?? {}));

/** Work that is drawn or annotated (a circuit, a graph, a geometry figure) has longer pauses and costs more to read than equations typed in a row. */
const slowWork = (t: ProblemTraits): boolean => t.workFormat === 'diagram' || t.workFormat === 'mixed';

/** Extra seconds before the sprite steps in, because the pauses on this kind of work are longer. */
const ADAPT_DIAGRAM_WAIT_SEC = 5;

/**
 * The sprite rule in force: the score at or above `threshold` for `durationSec` in a row. The threshold is always the slider's value.
 * The wait is the slider's value plus `complexityStepSec` for each level of difficulty of the problem being followed (1-5), plus a few
 * seconds more for work that is drawn or annotated, so harder problems get more time before the sprite pops up.
 */
export function triggerConfig(s: Settings, traits?: number | ProblemTraits | null): TriggerConfig {
  const t = traitsOf(traits);
  const extra = s.adaptive && slowWork(t) ? ADAPT_DIAGRAM_WAIT_SEC : 0;
  return { threshold: s.threshold, durationSec: scaledWait(s.durationSec, t.difficulty, s.complexityStepSec) + extra, cooldownSec: s.cooldownSec };
}

/** The model's reading cadence while the student writes, or null when continuous reading is off. Slower for work that is a drawing. */
export function reviewMs(s: Settings, traits?: number | ProblemTraits | null): number | null {
  if (!s.continuousReview) return null;
  const base = Math.min(MAX_REVIEW_SEC, Math.max(MIN_REVIEW_SEC, s.reviewSec || DEFAULT_REVIEW_SEC));
  const factor = s.adaptive && slowWork(traitsOf(traits)) ? 1.5 : 1;
  return Math.round(base * factor * 1000);
}

export function snapshotMs(s: Settings): number {
  return Math.min(MAX_SNAPSHOT_SEC, Math.max(MIN_SNAPSHOT_SEC, s.snapshotSec || DEFAULT_SNAPSHOT_SEC)) * 1000;
}

/** When the student counts as finished, or null while automatic checking is off. */
export function finishConfig(s: Settings, traits?: number | ProblemTraits | null): { idleMs: number; calmBelow: number } | null {
  if (!s.autoCheck) return null;
  const t = traitsOf(traits);
  const base = Math.min(MAX_FINISH_IDLE_SEC, Math.max(MIN_FINISH_IDLE_SEC, s.finishIdleSec || DEFAULT_FINISH_IDLE_SEC));
  // A harder problem has longer thinking pauses that aren't "finished", so it waits longer too (and drawing a diagram has longer ones still).
  const sec = scaledWait(base, t.difficulty, s.complexityStepSec) * (s.adaptive && slowWork(t) ? 1.5 : 1);
  return { idleMs: Math.round(sec * 1000), calmBelow: calmScore(triggerConfig(s).threshold) };
}

/** When the "a while on this problem" check comes first: half the time a typical student needs, within reason. */
export function firstCheckpointMs(s: Settings, traits?: number | ProblemTraits | null): number | null {
  const mins = traitsOf(traits).expectedMinutes;
  if (!s.adaptive || !mins || !Number.isFinite(mins)) return null;
  return Math.round(Math.min(240_000, Math.max(45_000, mins * 30_000)));
}

/** One line for the panel: how myTA has adapted to this problem. Empty when nothing was adapted. */
export function tuningNote(s: Settings, traits?: number | ProblemTraits | null): string {
  const t = traitsOf(traits);
  if (!s.adaptive || t.difficulty == null) return '';
  const trig = triggerConfig(s, t);
  const read = reviewMs(s, t);
  const kind = t.problemKind || (t.domain && t.domain !== 'other' ? t.domain.replace('_', ' ') : '');
  return [
    kind && `${kind}`,
    `difficulty ${t.difficulty}`,
    `steps in after ${trig.durationSec}s above ${trig.threshold}`,
    read !== null && `reads every ${Math.round(read / 1000)}s`,
    t.expectedMinutes ? `about ${t.expectedMinutes} min expected` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Tracking only runs once onboarding is complete: both keys plus a granted, calibrated camera. */
export function readiness(s: Settings): { ready: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!s.geminiKey) missing.push('Gemini API key');
  if (!s.serpKey) missing.push('SerpApi key');
  if (!s.cameraGranted) missing.push('camera access');
  if (!s.calibration) missing.push('camera calibration');
  return { ready: missing.length === 0, missing };
}
