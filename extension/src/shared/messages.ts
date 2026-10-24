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
  /** True when the backend thinks a prerequisite video would help. */
  suggestVideo: boolean;
  fallback: boolean;
}

export interface StartSessionResult extends TutorReply {
  sessionId: string;
  problemDetected: boolean;
}

export interface PageContext {
  selection: string;
  viewportText: string;
  url: string;
  title: string;
}

/** Every runtime message in the extension. `type` discriminates; responses are listed in `Responses`. */
export type Msg =
  // content → background
  | { type: 'page-signals'; signals: PageSignals }
  | { type: 'open-panel' }
  | { type: 'nudge-dismissed'; snooze: boolean }
  // offscreen → background
  | { type: 'face-reading'; facePresent: boolean; gazeAway: boolean; raw: RawFace | null }
  | { type: 'camera-status'; ok: boolean; error: string | null }
  // background → content
  | { type: 'nudge'; show: boolean; reasons: string[] }
  | { type: 'get-page-context' }
  // panel → background
  | { type: 'get-state' }
  | { type: 'force-trigger' }
  | { type: 'capture-tab' }
  | { type: 'page-context' }
  | {
      type: 'start-session';
      image: string; // base64 JPEG (no data: prefix)
      context: PageContext | null;
    }
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
  'capture-tab': { image: string } | { error: string };
  'page-context': PageContext | null;
  'get-page-context': PageContext;
  'start-session': StartSessionResult | { error: string };
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
