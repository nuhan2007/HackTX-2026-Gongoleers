import type { Channel, SignalId } from './types';

/** Fusion weights per channel. The face channel is weighted lowest on purpose (see README fairness note). */
export const CHANNEL_WEIGHTS: Record<Channel, number> = { content: 0.5, activity: 0.3, face: 0.2 };

/**
 * Per-signal weight inside its channel. Channels combine with noisy-OR
 * (1 - Π(1 - w·v)), so one strong cue can carry a channel on its own.
 */
export const SIGNAL_WEIGHTS: Record<SignalId, { channel: Channel; weight: number }> = {
  incorrect: { channel: 'content', weight: 0.85 },
  resubmits: { channel: 'content', weight: 0.6 },
  repeatedError: { channel: 'content', weight: 0.8 },
  editResubmit: { channel: 'content', weight: 0.5 },
  dwell: { channel: 'content', weight: 0.6 },

  idle: { channel: 'activity', weight: 0.55 },
  rereading: { channel: 'activity', weight: 0.5 },
  erraticMouse: { channel: 'activity', weight: 0.35 },
  rageClicks: { channel: 'activity', weight: 0.6 },
  backspace: { channel: 'activity', weight: 0.45 },
  repeatedSelection: { channel: 'activity', weight: 0.4 },
  tabHopping: { channel: 'activity', weight: 0.5 },

  browFurrow: { channel: 'face', weight: 0.7 },
  browRaise: { channel: 'face', weight: 0.4 },
  squint: { channel: 'face', weight: 0.4 },
  lipPress: { channel: 'face', weight: 0.45 },
  headTilt: { channel: 'face', weight: 0.35 },
};

/** EMA smoothing factor per second. */
export const EMA_ALPHA_PER_SEC = 0.15;
/** Added (0..1 scale) when ≥2 channels are above AGREEMENT_LEVEL at once. */
export const AGREEMENT_BONUS = 0.1;
export const AGREEMENT_LEVEL = 0.5;

/** Idle ramps from 0 at IDLE_START to 1 at IDLE_START + IDLE_RAMP. */
export const IDLE_START_MS = 20_000;
export const IDLE_RAMP_MS = 60_000;
export const DWELL_START_MS = 60_000;
export const DWELL_RAMP_MS = 180_000;

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
export const NORMAL_TRIGGER: TriggerConfig = { threshold: 60, durationSec: 45, cooldownSec: 180 };
export const DEMO_TRIGGER: TriggerConfig = { threshold: 50, durationSec: 10, cooldownSec: 30 };

export const DEFAULT_MODEL = 'gemini-3.8-flash';
export const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
export const GEMINI_CALLS_PER_MIN = 20;

/** Sites that count as "went looking for help" for the tab-hopping signal. */
export const HELP_SITE_PATTERNS = [
  /google\.[a-z.]+\/search/,
  /bing\.com\/search/,
  /duckduckgo\.com/,
  /chatgpt\.com|chat\.openai\.com/,
  /gemini\.google\.com/,
  /youtube\.com\/results/,
  /stackoverflow\.com/,
  /chegg\.com|coursehero\.com|quizlet\.com/,
];
