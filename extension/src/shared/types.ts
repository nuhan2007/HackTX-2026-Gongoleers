import type { RoleHints } from './pageRole';

// One measured cue. `value` is 0..1; `reason` is what the timeline and the model see.
export interface Signal {
  id: SignalId;
  value: number;
  reason: string;
}

export type ContentSignalId = 'incorrect' | 'resubmits' | 'repeatedError' | 'editResubmit';
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
export type SignalId = ContentSignalId | ActivitySignalId | FaceSignalId | TimerSignalId;

export type Channel = 'content' | 'activity' | 'face';

/** What a content script reports each second for its frame. */
export interface PageSignals {
  content: Signal[];
  activity: Signal[];
  /** ms since the last keyboard/mouse/scroll input in this frame. */
  idleMs: number;
  /** ms on the current question without new progress (new input resets it). */
  dwellMs: number;
  /** Human label for the current question, e.g. "Q4". */
  questionLabel: string;
  /** Running totals for this page (they only grow until it reloads); the monitor works with their differences. */
  stats?: PageStats;
  /** What the page looks like (a canvas and drawing tools, or answer boxes and a Check button); sent by the top frame every few seconds. */
  role?: RoleHints;
}

export interface PageStats {
  /** Times the page newly said an answer was wrong. */
  incorrectTotal: number;
  /** Times the page newly said an answer was correct. */
  correctTotal?: number;
  submitTotal: number;
  /** Typed characters and deletes. */
  keyTotal: number;
  /** Mouse presses and drag movement (drawing, selecting). */
  pointerTotal: number;
  scrollY: number;
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

/** The kind of problem, so myTA can adapt how it reads the work, what it watches for and how patient it is. */
export type Domain = 'algebra' | 'calculus' | 'geometry' | 'statistics' | 'physics' | 'circuits' | 'chemistry' | 'linear_algebra' | 'programming' | 'logic' | 'other';

/** What the student's work is likely to look like on screen. */
export type WorkFormat = 'equations' | 'diagram' | 'code' | 'text' | 'mixed';

/** One milestone on the way to the answer (private: a value here is as secret as the final answer). */
export interface Checkpoint {
  label: string;
  expected: string;
}

export interface SolverResult {
  problemText: string;
  finalAnswer: string;
  keySteps: string[];
  conceptTags: string[];
  misconceptions: string[];
  answerKeyPhrases: string[];
  problemDetected: boolean;
  /** 1 (one quick step) to 5 (long and hard) for a typical student. Sets how long myTA waits before stepping in. */
  difficulty?: number;
  /** What kind of problem it is ("node voltage analysis"), and the broad subject area. */
  problemKind?: string;
  domain?: Domain;
  /** What the student's work will look like: equations, a diagram they annotate, code, prose, or a mix. */
  workFormat?: WorkFormat;
  /** Everything given in a figure or table (components and values of a circuit, a graph's data...) in words, so the figure doesn't have to be re-read every time. */
  givens?: string;
  /** Milestones on the way to the answer, in order: how a half-finished solution is judged. */
  checkpoints?: Checkpoint[];
  /** How sure the answer key is. When low, a student's different answer isn't called wrong without finding the actual slip. */
  keyConfidence?: 'high' | 'medium' | 'low';
  /** How long a typical student needs for this problem, in minutes. */
  expectedMinutes?: number;
}

export interface ChatMessage {
  role: 'tutor' | 'student';
  text: string;
  t: number;
}

/** `auto`: myTA noticed the student was stuck and is offering a hint on the sprite. `another`: they pressed "Another hint". */
export type TutorAction = 'auto' | 'another';

// ---- Work watching ----

/** What the periodic screenshot review last concluded about the student's work. */
export type WorkStatus = 'unknown' | 'no_work' | 'on_track' | 'possible_mistake' | 'solved' | 'different_problem';

/** How well the model could read what the student has written: the answer to "can it actually see my work?". */
export type Readability = 'clear' | 'hard_to_read' | 'nothing_written';

/** Private per-session notes. `observation` may name the mistake, so it never goes to the UI. */
export interface WorkState {
  status: WorkStatus;
  observation: string;
  reviewedAt: number;
  /** The student's own writing as the model read it ("" when nothing was written or it must not be echoed). Safe to show them. */
  read?: string;
  readability?: Readability;
  /** The student copied the problem onto their work and it differs from the real one. */
  copiedWrong?: boolean;
  /** Whether they have finished writing the problem down, started it, or not copied it at all. */
  copyState?: CopyState;
}

/** How far the student is with copying the problem onto their work. A copy can only be called wrong once it is `complete`. */
export type CopyState = 'not_copied' | 'in_progress' | 'complete';

/** [ymin, xmin, ymax, xmax], each 0..1000 (the bounding-box convention vision models use). */
export type Box = [number, number, number, number];

export type CheckVerdict = 'correct' | 'mistake' | 'incomplete' | 'unclear';

/** What kind of mistake: a wrong step in the working, a wrong final answer, or the problem copied down differently from how it is given. */
export type MistakeKind = 'step' | 'answer' | 'copy';

export interface WorkCheckResult {
  verdict: CheckVerdict;
  message: string;
  /** Where on `image` the work went wrong (mistakes only). */
  box: Box | null;
  fallback: boolean;
  read?: string;
  readability?: Readability;
  /** The screens show a different problem than the one that was solved (the page moved on without anything in its address saying so). */
  differentProblem?: boolean;
  /** What kind of mistake it is, for `verdict: 'mistake'`. */
  kind?: MistakeKind;
}

/**
 * The result of a check myTA made by itself when the student looked finished. Small on purpose (it rides along in the
 * panel's once-a-second state); the picture that was checked is fetched separately.
 */
export interface AutoCheck {
  id: number;
  sessionId: string;
  at: number;
  verdict: CheckVerdict;
  /** What the student is told. Passed the same leak guard as every tutor message. */
  message: string;
  box: Box | null;
  /** Why myTA looked, e.g. "idle for 10 s and calm (score 22)", or "reading along". */
  why: string;
  /** For a mistake: which kind. */
  kind: MistakeKind;
  /** Where it came from: a reading while they wrote, the check when they stopped, or the homework page itself saying "wrong". */
  origin: 'read' | 'check' | 'page';
}

export interface TutorTurn {
  replyAssessment: ReplyAssessment;
  hintLevel: HintLevel;
  message: string;
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
  /**
   * Where the moment came from: the video's own chapters, Gemini watching the video, or only the search result's text
   * (`metadata`, the least precise). `cache` is a moment found earlier.
   */
  source: 'chapters' | 'video' | 'metadata' | 'cache';
  /** Trusted practice links, added when the student keeps getting stuck on this concept. */
  practice?: { title: string; link: string; site: string }[];
  /** Length of the whole video in seconds, when known. */
  lengthSec?: number;
  /** The video's thumbnail as a data URL (fetched by the background, so a page's strict CSP can't block it). Never cached. */
  thumb?: string;
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
