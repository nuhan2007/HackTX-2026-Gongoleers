import type { CallOutcome, CallReason, GateState } from '../background/callGate';
import type { RawFace } from './faceSignals';
import type {
  AutoCheck,
  Box,
  CheckVerdict,
  EngineOutput,
  HintLevel,
  MistakeKind,
  PageSignals,
  Readability,
  SessionSummary,
  TimelinePoint,
  TriggerPhase,
  VideoMoment,
  WorkStatus,
} from './types';
import type { PageRole, RoleHints } from './pageRole';
import type { ProblemTraits } from './settings';

/**
 * What the sprite is showing. It is one character in one place (the tab where the student writes their work), and it says one
 * thing at a time:
 *   stuck      the confusion score stayed high: "taking a look…", then a hint, or a plain offer of one
 *   mistake    something in their work is off (a step, the answer, or the problem copied down differently): says where, never the answer
 *   cheer      they got it right
 *   check-work they seem to be moving on without having been checked
 *   hello      a greeting: once setup is done, and after the student picks a new character, so they can see it
 */
export type NudgeKind = 'stuck' | 'check-work' | 'mistake' | 'cheer' | 'hello';

/** Everything the sprite needs to draw itself. The words are chosen in the background, so they don't repeat from one nudge to the next. */
export interface SpriteContent {
  kind: NudgeKind;
  /** The heading, picked from a pool of phrasings. */
  title: string;
  /** The hint, or where the work went off track, or the congratulation. In words, and never the answer. */
  text?: string;
  /** For `stuck`: myTA is reading the student's work and the hint is on its way. */
  pending?: boolean;
  /** For `mistake`: what kind. */
  mistakeKind?: MistakeKind;
  /** For `mistake`: where on the work tab's screen it went wrong (0..1000 fractions), drawn over the page. */
  box?: Box | null;
  /** For `mistake`: id of the stored check, so "Show me where" can fetch the screen that was checked. */
  checkId?: number | null;
  hintLevel?: HintLevel;
  /** A short video on the idea behind the trouble, found with SerpApi. */
  video?: VideoMoment | null;
  videoState?: 'loading' | 'error';
  videoError?: string;
  /** Offer the "Watch a short clip" button. */
  canVideo?: boolean;
  /** What myTA noticed (the confusion signals), shown as chips on the offer. */
  reasons?: string[];
  /** The confusion score (0-100) when the sprite stepped in, for the little gauge. */
  score?: number;
  /** For `cheer`: how many problems the student has got right today, counting this one. */
  streak?: number;
  /** For `mistake`: the words are still being checked (they never reach the student unchecked); the flag and the box are already up. */
  checking?: boolean;
}

/** One attempt to start following a problem, for the side panel to show. */
export interface StartState {
  status: 'starting' | 'ready' | 'error';
  sessionId?: string;
  error?: string;
  /** False when the model couldn't find a problem on screen. */
  problemDetected?: boolean;
  at: number;
}

export interface WatchState {
  /** True while the screenshot loop is running for a problem being followed. */
  active: boolean;
  status: WorkStatus;
  lastCaptureAt: number | null;
  lastReviewAt: number | null;
  intervalSec: number;
  /** Why watching is paused (rate limit, bad key). */
  note: string | null;
  /** The student's own writing, as the model last read it, and how well it could read it. */
  read: string;
  readability: Readability | null;
}

/** Does myTA know which problem the student is on, and is it following it? */
export interface TrackingState {
  mode:
    | 'off' //          automatic tracking is switched off in settings
    | 'looking' //      waiting for the student to settle on a problem
    | 'noticed' //      a problem-looking page; starting once the student has stayed on it a moment
    | 'starting' //     working the problem out privately
    | 'following' //    has the problem, watching the work
    | 'not-a-problem' // the current page doesn't look like a problem
    | 'pick-one'; //     several questions on the page and none picked yet
  /** The problem's name as the page shows it, e.g. "Q4". */
  label: string | null;
  host: string | null;
  /** When following began. */
  since: number | null;
  /** While `noticed`: seconds on the page so far, out of the seconds needed. */
  noticedSec: number | null;
  needSec: number;
  /** Why tracking isn't running right now (no camera yet, snoozed, …). */
  note: string | null;
}

/** When the sprite will appear: the rule in the student's own terms, with the timer's current position. */
export interface TriggerView {
  threshold: number;
  /** The wait in force: the slider's value plus the extra time for this problem's difficulty. */
  durationSec: number;
  /** How myTA adapted to the problem being followed, in words ("node voltage analysis · difficulty 4 · steps in after 20s…"). Empty when it didn't. */
  tuning: string;
  /** The slider's value, the problem's difficulty (1-5, null with nothing being followed), and the seconds that difficulty adds. */
  baseSec: number;
  difficulty: number | null;
  extraSec: number;
  /** Seconds the score has been at or above the threshold, or null while it is below. */
  aboveSec: number | null;
  cooldownLeftSec: number;
  /** Why the sprite isn't going to appear right now, if so. */
  paused: 'off' | 'snoozed' | 'no-camera' | null;
}

/** When myTA counts the student as finished and checks their answer. */
export interface FinishView {
  enabled: boolean;
  idleSec: number;
  /** The score must be at or below this. */
  calmBelow: number;
  /** New work since the last check, so there is something to check. */
  hasWork: boolean;
  /** Seconds since the student last wrote or typed anything on the work screen. */
  idleForSec: number | null;
}

/** The small status myTA keeps on the page it is watching: what it is following, and what it can read. */
export interface StatusPill {
  text: string;
  tone: 'info' | 'ok' | 'warn';
}

/** One tab the monitor is keeping an eye on. */
export interface TabView {
  tabId: number;
  role: 'problem' | 'work' | 'other';
  title: string;
  host: string;
  /** When the latest snapshot of it was taken. */
  at: number;
  /** Snapshots of it stored on this device. */
  stored: number;
  /** What kind of page myTA thinks this is from the indicators below (may differ from the role it was given when pinned by hand). */
  looksLike: PageRole;
  /** 0..1: how sure of that. */
  confidence: number;
  /** The indicators behind it: the site, the page's structure, what the student does there. */
  why: string[];
}

export interface LogLine {
  t: number;
  text: string;
}

/** What myTA sees and how often it asks the model: the numbers behind "is this working?". */
export interface EyesState {
  /** Snapshots taken since the browser started, and how many are stored on this device right now. */
  captures: number;
  storedFrames: number;
  storedBytes: number;
  tabs: TabView[];
  /** The tab being watched as the student's work tab, if one was found or pinned (it may not have a snapshot yet). */
  workTabId: number | null;
  /** True when the work tab was pinned by hand (auto-detection leaves it alone). */
  workPinned: boolean;
  intervalSec: number;
  /** Model calls the monitor decided to make (reviews) versus every call made, with the kinds. */
  reviews: number;
  calls: { total: number; byKind: Record<string, number>; lastMs: number | null; promptTokens: number; cachedTokens: number };
  gate: GateState | null;
  last: { at: number; reason: CallReason; detail: string; outcome: CallOutcome | 'running' } | null;
  log: LogLine[];
}

/** One model call's pictures, as small thumbnails: "what did it actually see?" */
export interface SentShot {
  at: number;
  kind: string;
  images: { caption: string; thumb: string }[];
}

export interface KeyHealth {
  state: 'ok' | 'bad' | 'untested';
  detail: string;
}

export interface PanelState {
  ready: boolean;
  missing: string[];
  enabled: boolean;
  cameraOk: boolean;
  cameraError: string | null;
  phase: TriggerPhase;
  output: EngineOutput;
  timeline: TimelinePoint[];
  devMode: boolean;
  labelMode: boolean;
  sessionId: string | null;
  start: StartState | null;
  watch: WatchState;
  keys: { gemini: KeyHealth; serp: KeyHealth };
  eyes: EyesState;
  tracking: TrackingState;
  trigger: TriggerView;
  finish: FinishView;
  /** The latest mistake or check myTA flagged; the panel fetches the details (and the picture) once per id. */
  autoCheck: { id: number; sessionId: string; verdict: CheckVerdict; kind: MistakeKind; origin: AutoCheck['origin']; at: number } | null;
  /** The latest hint myTA showed on the sprite. */
  autoHint: { id: number; sessionId: string; message: string; level: HintLevel; at: number } | null;
  /** What the sprite is saying right now, if anything. */
  sprite: { kind: NudgeKind; title: string; text: string; at: number } | null;
  /** How many mistakes have been flagged on this problem, and whether the student has been congratulated on it. */
  flagged: number;
  celebrated: boolean;
  /** How often the model reads the student's work while they write, in seconds (null = off). */
  reviewSec: number | null;
}

export interface StartSessionResult {
  sessionId: string;
  problemDetected: boolean;
  /** Why no problem was found, when `problemDetected` is false. */
  message: string;
  /** 1-5: how demanding the problem is. Sets how long the sprite waits before stepping in. */
  difficulty?: number;
  /** What kind of problem it is, so the waits and the reading pace can be adapted to it. */
  traits?: ProblemTraits;
}

export interface PageContext {
  selection: string;
  viewportText: string;
  url: string;
  title: string;
  /** Label of the question the student last touched, e.g. "Q4". */
  question?: string;
  /** How many answer fields (text boxes, choices, an editable area) are visible: a page with none is rarely a problem. */
  fields?: number;
  /** What the page looks like (a board, or a homework page), for telling the problem tab from the work tab. */
  roleHints?: RoleHints;
}

/** Every runtime message in the extension. `type` discriminates; responses are listed in `Responses`. */
export type Msg =
  // content → background
  | { type: 'page-signals'; signals: PageSignals }
  /** The status pill was clicked: open the side panel (the one place with the settings and the Live tab). */
  | { type: 'open-panel' }
  | { type: 'nudge-dismissed'; snooze: boolean; kind?: NudgeKind }
  /** "Another hint" on the sprite: read the work again and go one level deeper. */
  | { type: 'hint-request' }
  /** "Watch a short clip" on the sprite: find a video on the idea behind the trouble (SerpApi) and show it there. */
  | { type: 'video-request' }
  /** The sprite's clip button: open the video at the moment that was picked. The background builds the address itself. */
  | { type: 'open-video'; videoId: string; start: number }
  /** "Check my work" on the sprite's offer. */
  | { type: 'check-now' }
  | { type: 'move-on'; reason: string }
  // offscreen → background
  | { type: 'face-reading'; facePresent: boolean; gazeAway: boolean; raw: RawFace | null }
  | { type: 'camera-status'; ok: boolean; error: string | null }
  // background → content
  | { type: 'nudge'; show: boolean; kind: NudgeKind; content?: SpriteContent }
  | { type: 'status'; pill: StatusPill | null; toast?: { id: number; text: string } }
  | { type: 'get-page-context' }
  // panel → background
  | { type: 'get-state' }
  | { type: 'force-trigger' }
  /** Follow the problem on the tab the student is looking at, right now (the automatic way needs no click). */
  | { type: 'start-session' }
  /** Use the tab the student is looking at as their work tab (or stop using it, if it is already the work tab). */
  | { type: 'pin-work-tab' }
  | { type: 'unpin-work-tab' }
  | { type: 'clear-snapshots' }
  | { type: 'get-sent' }
  | { type: 'get-auto-check'; id: number }
  | { type: 'get-stats' }
  // options → background
  | { type: 'restart-camera' }
  /** The student just chose a new character (or finished setup): let it say hello on the page they are looking at. */
  | { type: 'say-hello' }
  | { type: 'export-label-log' }
  | { type: 'export-video-cache' };

export interface Stats {
  sessions: SessionSummary[];
  medianTimeToUnstuckSec: number | null;
  solvedRate: number | null;
  eval: EvalResults;
}

export interface EvalResults {
  trigger?: { precision: number; recall: number; medianLeadSec: number; sessions: number; threshold: number; durationSec: number; generatedAt: string };
  leak?: { problems: number; turns: number; leakRate: number; preGuardLeakRate: number; generatedAt: string };
}

export interface Responses {
  'get-state': PanelState;
  'get-page-context': PageContext;
  'start-session': StartSessionResult | { error: string };
  'pin-work-tab': { ok: true; host: string } | { error: string };
  'get-sent': SentShot[];
  /** The check myTA made, with the exact picture it checked (a data URL), or null if it has been replaced. */
  'get-auto-check': (AutoCheck & { image: string | null }) | null;
  'get-stats': Stats;
  'export-label-log': unknown;
  'export-video-cache': unknown;
}

export type ResponseOf<M extends Msg> = M['type'] extends keyof Responses ? Responses[M['type']] : void;

export function send<M extends Msg>(msg: M): Promise<ResponseOf<M>> {
  return chrome.runtime.sendMessage(msg);
}

export function sendToTab<M extends Msg>(tabId: number, msg: M, frameId = 0): Promise<ResponseOf<M>> {
  return chrome.tabs.sendMessage(tabId, msg, { frameId });
}

export function isError(r: unknown): r is { error: string } {
  return typeof r === 'object' && r !== null && 'error' in r;
}
