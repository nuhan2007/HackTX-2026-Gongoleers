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
export const NORMAL_TRIGGER: TriggerConfig = { threshold: 40, durationSec: 5, cooldownSec: 30 };

/**
 * Harder problems wait longer before the sprite appears (and before "finished" is decided): each level of difficulty above
 * the easiest adds this many seconds. The problem's difficulty (1-5) comes from the model's private solution.
 */
export const DEFAULT_COMPLEXITY_STEP_SEC = 5;
export const MAX_COMPLEXITY_STEP_SEC = 20;
export const DEFAULT_DIFFICULTY = 3;
export const MIN_DIFFICULTY = 1;
export const MAX_DIFFICULTY = 5;
/** base seconds, plus `stepSec` for each level of difficulty above 1. With no problem being followed, just the base. */
export function scaledWait(baseSec: number, difficulty: number | null | undefined, stepSec: number): number {
  if (difficulty === null || difficulty === undefined || !Number.isFinite(difficulty)) return baseSec;
  const d = Math.min(MAX_DIFFICULTY, Math.max(MIN_DIFFICULTY, Math.round(difficulty)));
  return baseSec + (d - 1) * Math.max(0, stepSec);
}

/**
 * While the student is writing, the model reads their work this often (if it changed since the last read). One read at a
 * time, so a slow answer just spaces the reads out.
 */
export const DEFAULT_REVIEW_SEC = 5;
export const MIN_REVIEW_SEC = 3;
export const MAX_REVIEW_SEC = 60;

/**
 * A line is "done" when the student has written something new and then stopped this long: the model reads it right then, so a mistake
 * is flagged a couple of seconds after the line is finished instead of at the next periodic read.
 */
export const LINE_SETTLE_MS = 900;
/** Pause reads need at least this much new writing (keystrokes plus a quarter of the pen/mouse events): a word, or a few strokes. */
export const LINE_MIN_INPUT = 3;
/** Pause reads of a chatty writer are never closer together than this. */
export const MIN_READ_GAP_MS = 1_500;
/**
 * A problem copied down wrongly is only called out once the student has finished writing it: the reading must be of a pause this long
 * (or the one after it must agree), because a half-written copy always differs from the whole problem.
 */
export const COPY_IDLE_MS = 2_500;
/** Readings in a row that must agree the copy is wrong and finished. */
export const COPY_READS_TO_FLAG = 2;

/** A hint shown on the sprite stays up at least this long even if the confusion score drops right away. */
export const MIN_HINT_SHOWN_MS = 20_000;
/** The congratulation stays up this long, then the sprite goes away by itself. */
export const CHEER_MS = 12_000;
/** After the student dismisses a mistake flagged while they were writing, the same kind of flag waits this long (a fixed mistake is gone sooner). */
export const REFLAG_AFTER_DISMISS_MS = 90_000;
/** A mistake found by a reading that couldn't read the handwriting clearly is only flagged once that many readings in a row agree. */
export const UNSURE_READS_TO_FLAG = 2;
/** A second hint within this long of the last one goes one level deeper. */
export const HINT_ESCALATE_MS = 5 * 60_000;

/**
 * Automatic problem tracking: once the student has stayed on a page that looks like a problem this long, myTA
 * works the problem out privately (one model call) so it can follow the work and check the answer later.
 */
export const AUTO_START_DWELL_MS = 12_000;
/** At most this many automatic starts per window, so flicking through pages can't run up calls. */
export const AUTO_START_BUDGET = { max: 6, windowMs: 10 * 60_000 };
/** A page the model said has no problem on it isn't asked about again for this long. */
export const NOT_A_PROBLEM_MS = 10 * 60_000;
/** The student must be on a different problem this long before myTA says they moved on. */
export const MOVED_ON_AFTER_MS = 2_000;

/**
 * Finished = no new work for this long while the confusion score is below the threshold the student set for the sprite. The two
 * rules share one number on purpose: at or above it the sprite is helping them, below it and still, they have finished.
 */
export const DEFAULT_FINISH_IDLE_SEC = 8;
export const MIN_FINISH_IDLE_SEC = 3;
export const MAX_FINISH_IDLE_SEC = 60;
/** The highest score that still counts as calm: one under the sprite's threshold. */
export const calmScore = (threshold: number): number => threshold - 1;

/** The quick model that reads the work, writes hints and judges them, and the stronger one that works the problem out once. */
export const DEFAULT_MODEL = 'gemini-3.8-flash';
export const DEFAULT_SOLVER_MODEL = 'gemini-4-argon';
export const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
export const LLM_CALLS_PER_MIN = 40;

/** How often the monitored tabs are captured and stored locally. Nothing leaves the device for this. */
export const DEFAULT_SNAPSHOT_SEC = 3;
export const MIN_SNAPSHOT_SEC = 2;
export const MAX_SNAPSHOT_SEC = 30;
/** Frames are downscaled to this width before they're stored or sent to the model. */
export const FRAME_MAX_WIDTH = 1400;
/** Frames kept per tab, and how long. Older ones are dropped. */
export const FRAMES_PER_TAB = 12;
export const FRAME_TTL_MS = 30 * 60_000;
/** Background work reviews skip when fewer than this many model calls are left in the minute. */
export const REVIEW_MIN_HEADROOM = 8;
/** After a rate-limit or key error, the monitor stops asking the model this long. */
export const REVIEW_BACKOFF_MS = 60_000;
/** The "check your work?" offer is withdrawn if ignored this long. */
export const CHECK_OFFER_TTL_MS = 90_000;
/** Don't offer a work check in the first seconds of a session (clicks while reading the problem aren't "moving on"). */
export const MIN_SESSION_BEFORE_CHECK_MS = 15_000;
/** Pages that are never captured: mail, sign-in pages, banking and password managers. */
export const NEVER_CAPTURE: RegExp[] = [
  /^https?:\/\/(mail\.google\.com|accounts\.google\.com|outlook\.(live|office|office365)\.com|login\.|signin\.|auth\.)/i,
  /^https?:\/\/[^/]*(paypal|venmo|chase|wellsfargo|bankofamerica|capitalone|citibank|1password|lastpass|bitwarden|dashlane)[^/]*\//i,
];

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
