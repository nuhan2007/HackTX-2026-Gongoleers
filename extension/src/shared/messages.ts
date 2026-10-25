import type { RawFace } from './faceSignals';
import type {
  EngineOutput,
  HintLevel,
  PageSignals,
  ReplyAssessment,
  SessionSummary,
  TimelinePoint,
  TriggerPhase,
  TutorAction,
  VideoMoment,
} from './types';

export interface PanelState {
  ready: boolean;
  missing: string[];
  enabled: boolean;
  cameraOk: boolean;
  cameraError: string | null;
  /** False when no content script on the tab being watched has reported in (owl can't show there). */
  pageVisible: boolean;
  phase: TriggerPhase;
  output: EngineOutput;
  timeline: TimelinePoint[];
  devMode: boolean;
  labelMode: boolean;
  /** Set while a nudge is waiting; the panel uses it to time-stamp the session. */
  triggeredAt: number | null;
}

export interface TutorReply {
  message: string;
  hintLevel: HintLevel;
  replyAssessment: ReplyAssessment;
  /** 2-3 concrete "try this next" actions (never the answer). */
  suggestions: string[];
  /** True when the backend thinks a prerequisite video would help. */
  suggestVideo: boolean;
  fallback: boolean;
}

export interface StartSessionResult extends TutorReply {
  sessionId: string;
  problemDetected: boolean;
}

/** What one frame of the tab shows: read when the student asks for help. */
export interface PageContext {
  url: string;
  title: string;
  selection: string;
  viewportText: string;
  /** Source TeX of rendered math (KaTeX/MathJax/alt text). */
  math: string[];
  /** Visible answer fields and what's in them. */
  fields: { label: string; value: string }[];
  /** Recent typing, submissions, feedback and drawing activity. */
  workLog: string[];
  /** base64 JPEG snapshots of visible canvases (handwriting, whiteboards). */
  drawings: string[];
}

export type HelpStage = 'looking' | 'reading' | 'thinking';

/** Every runtime message in the extension. `type` discriminates; responses are listed in `Responses`. */
export type Msg =
  // content → background
  | { type: 'page-signals'; signals: PageSignals }
  | { type: 'start-help' }
  | { type: 'nudge-dismissed'; snooze: boolean }
  // offscreen → background
  | { type: 'face-reading'; facePresent: boolean; gazeAway: boolean; raw: RawFace | null }
  | { type: 'camera-status'; ok: boolean; error: string | null }
  // background → content
  | { type: 'nudge'; show: boolean; reasons: string[] }
  | { type: 'get-page-context' }
  | { type: 'help-progress'; stage: HelpStage }
  // panel → background
  | { type: 'get-state' }
  | { type: 'force-trigger' }
  | { type: 'tutor-turn'; sessionId: string; action: TutorAction; text: string }
  | { type: 'check-understanding'; sessionId: string; text: string }
  | { type: 'find-video'; sessionId: string }
  | { type: 'end-session'; sessionId: string; solved: boolean }
  | { type: 'get-stats' }
  // options → background
  | { type: 'restart-camera' }
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
  'start-help': StartSessionResult | { error: string };
  'tutor-turn': TutorReply | { error: string };
  'check-understanding': { understood: boolean; feedback: string } | { error: string };
  'find-video': VideoMoment | { error: string };
  'end-session': SessionSummary | null;
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
