import type { Channel, SignalId } from './types';

/**
 * How much each channel can contribute on its own (0..1 of the score). Channels combine with
 * noisy-OR, so one strongly-lit channel can reach the threshold alone and two agreeing channels
 * reinforce each other. The face is capped lower on purpose (see README fairness note).
 */
export const CHANNEL_GAIN: Record<Channel, number> = { activity: 0.7, face: 0.55 };

/**
 * Per-signal weight inside its channel. Channels combine with noisy-OR
 * (1 - Π(1 - w·v)), so one strong cue can carry a channel on its own.
 */
export const SIGNAL_WEIGHTS: Record<SignalId, { channel: Channel; weight: number }> = {
  dwell: { channel: 'activity', weight: 0.6 },
  idle: { channel: 'activity', weight: 0.6 },
  rereading: { channel: 'activity', weight: 0.5 },
  erraticMouse: { channel: 'activity', weight: 0.35 },
  rageClicks: { channel: 'activity', weight: 0.6 },
  backspace: { channel: 'activity', weight: 0.45 },
  repeatedSelection: { channel: 'activity', weight: 0.4 },
  tabHopping: { channel: 'activity', weight: 0.5 },

  browFurrow: { channel: 'face', weight: 0.8 },
  browRaise: { channel: 'face', weight: 0.5 },
  squint: { channel: 'face', weight: 0.5 },
  lipPress: { channel: 'face', weight: 0.55 },
  headTilt: { channel: 'face', weight: 0.45 },
};

/** EMA smoothing per second for the final score (≈7s time constant). */
export const EMA_ALPHA_PER_SEC = 0.12;
/** EMA smoothing per second for each channel before fusion (≈3-4s), so the meters don't flicker. */
export const CHANNEL_ALPHA_PER_SEC = 0.25;

/** Idle ramps from 0 at IDLE_START to 1 at IDLE_START + IDLE_RAMP. */
export const IDLE_START_MS = 8_000;
export const IDLE_RAMP_MS = 30_000;
export const DWELL_START_MS = 30_000;
export const DWELL_RAMP_MS = 90_000;

/** A face reading older than this is treated as "no face info". */
export const FACE_STALE_MS = 3_000;
export const PAGE_STALE_MS = 3_000;

export const HYSTERESIS = 10;
export const TIMELINE_LENGTH = 180; // seconds of history kept for the side panel chart

export interface TriggerConfig {
  threshold: number;
  durationSec: number;
  cooldownSec: number;
}
export const NORMAL_TRIGGER: TriggerConfig = { threshold: 35, durationSec: 25, cooldownSec: 120 };
export const DEMO_TRIGGER: TriggerConfig = { threshold: 30, durationSec: 8, cooldownSec: 30 };

/** Face smoothing: median over the last N readings (spike rejection), then a slow EMA. */
export const FACE_MEDIAN_WINDOW = 5;
export const FACE_EMA_ALPHA = 0.3; // per 1s reading → ≈3s time constant

export const DEFAULT_MODEL = 'gpt-6-luna';
export const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
export const AI_CALLS_PER_MIN = 20;

/** Sites that count as "went looking for help" for the tab-hopping signal. */
export const HELP_SITE_PATTERNS = [
  /google\.[a-z.]+\/search/,
  /bing\.com\/search/,
  /duckduckgo\.com/,
  /chatgpt\.com|chat\.openai\.com/,
  /youtube\.com\/results/,
  /stackoverflow\.com/,
  /chegg\.com|coursehero\.com|quizlet\.com/,
];
