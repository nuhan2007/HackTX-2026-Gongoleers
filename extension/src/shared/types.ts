// One measured cue. `value` is 0..1; `reason` is what the timeline and the tutor model see.
export interface Signal {
  id: SignalId;
  value: number;
  reason: string;
}

export type ActivitySignalId =
  | 'rereading'
  | 'erraticMouse'
  | 'rageClicks'
  | 'backspace'
  | 'repeatedSelection'
  | 'tabHopping';
export type FaceSignalId = 'browFurrow' | 'browRaise' | 'squint' | 'lipPress' | 'headTilt';
// Idle and dwell are computed by the engine from raw timers so they can be paused.
export type TimerSignalId = 'idle' | 'dwell';
export type SignalId = ActivitySignalId | FaceSignalId | TimerSignalId;

export type Channel = 'activity' | 'face';

/** What a content script reports each second for its frame. */
export interface PageSignals {
  activity: Signal[];
  /** ms since the last keyboard/mouse/scroll input in this frame. */
  idleMs: number;
  /** ms on the current question without new progress (new input resets it). */
  dwellMs: number;
  /** Human label for the current question, e.g. "Q4". */
  questionLabel: string;
}

export interface FaceReading {
  signals: Signal[];
  facePresent: boolean;
  gazeAway: boolean;
}

export interface EngineInput {
  now: number;
  page: PageSignals | null;
  tab: Signal[]; // tab-hopping, from the background tab tracker
  face: FaceReading | null; // null = no recent reading from the camera
}

export interface EngineOutput {
  score: number; // 0..100
  channels: Record<Channel, number>;
  topContributors: string[];
}

export interface CalibrationBaseline {
  mean: Record<string, number>;
  std: Record<string, number>;
  capturedAt: number;
}

export type TriggerPhase = 'idle' | 'rising' | 'confused' | 'cooldown';

export interface TimelinePoint {
  t: number;
  score: number;
  reasons: string[];
}

// ---- Tutor ----

export type ReplyAssessment = 'correct' | 'partial' | 'misconception' | 'dont_know' | 'none';
export type HintLevel = 1 | 2 | 3;

export interface SolverResult {
  problemText: string;
  finalAnswer: string;
  keySteps: string[];
  conceptTags: string[];
  misconceptions: string[];
  answerKeyPhrases: string[];
  problemDetected: boolean;
  /** What the student has typed/drawn/submitted so far and where it seems to go wrong. */
  studentWork: string;
}

export interface ChatMessage {
  role: 'tutor' | 'student';
  text: string;
  t: number;
}

export type TutorAction = 'reply' | 'different_hint' | 'dont_know';

export interface TutorTurn {
  replyAssessment: ReplyAssessment;
  hintLevel: HintLevel;
  message: string;
  /** 2-3 short "try this next" actions; never the answer. */
  suggestions: string[];
  missingPrerequisite: string;
}

export interface VideoMoment {
  videoId: string;
  title: string;
  channel: string;
  start: number; // seconds
  end: number;
  why: string;
  concept: string;
  source: 'metadata' | 'cache';
  /** Trusted practice links, added when the student keeps getting stuck on this concept. */
  practice?: { title: string; link: string; site: string }[];
}

export interface SessionSummary {
  id: string;
  startedAt: number;
  triggeredAt: number | null;
  endedAt: number;
  solved: boolean;
  timeToUnstuckSec: number | null;
  concepts: string[];
  videosWatched: string[];
  turns: number;
  url: string;
}
