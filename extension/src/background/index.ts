// Service worker: routes messages, runs the engine tick, manages the offscreen camera doc, and drives everything myTA does on
// its own: follows the problem, reads the student's work while they write, steps in with a hint when they are confused, flags
// a mistake the moment a reading finds one, checks the answer when they finish, and cheers when they get it right.
// All of it is said by ONE sprite, in ONE place: the tab where the student writes their work. There is no chat.
// All long-lived state is in chrome.storage so an MV3 shutdown loses nothing important.
import { LlmError, resetLearned, type CallRecord, type SendRecord } from '../ai/llmClient';
import { fingerprint, KEY_STATUS_STORAGE, listModelIds, pickFastModel, type KeyCheck, type KeyStatus } from '../ai/keyCheck';
import { FALLBACK_CHECK } from '../ai/prompts';
import { getSession, getWork, saveWork } from '../ai/sessionStore';
import {
  AUTO_START_DWELL_MS,
  CHEER_MS,
  CHECK_OFFER_TTL_MS,
  COPY_IDLE_MS,
  COPY_READS_TO_FLAG,
  FACE_STALE_MS,
  LLM_CALLS_PER_MIN,
  MIN_HINT_SHOWN_MS,
  MIN_SESSION_BEFORE_CHECK_MS,
  NOT_A_PROBLEM_MS,
  REFLAG_AFTER_DISMISS_MS,
  REVIEW_MIN_HEADROOM,
} from '../shared/constants';
import { toSignals } from '../shared/faceSignals';
import type {
  EyesState,
  FinishView,
  KeyHealth,
  Msg,
  NudgeKind,
  PageContext,
  PanelState,
  SentShot,
  SpriteContent,
  StartSessionResult,
  StartState,
  StatusPill,
  TrackingState,
  TriggerView,
} from '../shared/messages';
import { PhraseDeck } from '../shared/phrases';
import {
  finishConfig,
  firstCheckpointMs,
  getSettings,
  onSettingsChanged,
  readiness,
  reviewMs,
  snapshotMs,
  triggerConfig,
  tuningNote,
  updateSettings,
  type ProblemTraits,
  type Settings,
} from '../shared/settings';
import type { AutoCheck, EngineOutput, FaceReading, HintLevel, WorkCheckResult, WorkState } from '../shared/types';
import type { CallOutcome } from './callGate';
import { step } from './confusionEngine';
import { EngineStore } from './engineStore';
import { activeTab, capturable, thumbnail } from './frames';
import { createFrameStore } from './frameStore';
import { LabelLogger } from './labelLogger';
import { getStats } from './metrics';
import { Monitor, type ReviewJob } from './monitor';
import { mergePage, type TabReports } from './pageMerge';
import { displayLabel, isNumbered, labelOf, looksLikeProblem, problemKey, ProblemTracker, severalQuestions } from './problemTracker';
import { decideRead, wantsMessage as wantsReadMessage, type ReadFacts } from './readPolicy';
import { RateLimiter, RateLimitError } from './rateLimiter';
import { startTabTracker, tabSignals } from './tabTracker';
import { enterCooldown, forceConfused, stepTrigger, triggerProgress } from './triggerMachine';
import * as tutor from './tutorService';
import { SerpError } from '../serp/youtube';
import { fallbackQuestion } from '../leak/guard';

const OFFSCREEN_URL = 'src/offscreen/offscreen.html';
const SNOOZE_MS = 15 * 60_000;
const TRIGGER_MEMORY_MS = 10 * 60_000;
/** A message about the problem the student has just left stays up at least this long before the next problem is followed (which takes the sprite down). */
const SPRITE_READ_MS = 20_000;

const store = new EngineStore(chrome.storage.session);
const logger = new LabelLogger();
const limiter = new RateLimiter(LLM_CALLS_PER_MIN);
/** What the sprite says in its own words: a different phrasing every time. */
const phrases = new PhraseDeck();

let settings: Settings;
const settingsReady = getSettings().then((s) => (settings = s));

/** Latest signals per tab → frame. The active tab feeds the engine's activity; every tab's wrong-answer cues carry (see pageMerge). */
const frames: TabReports = new Map();
let face: { reading: FaceReading; at: number } | null = null;
let cameraError: string | null = null;
let activeTabId: number | null = null;
let lastOutput: EngineOutput = { score: 0, channels: { content: 0, activity: 0, face: 0 }, topContributors: [] };
let lastTickAt = 0;
/** When `lastOutput` was last computed: the monitor ignores a stale score. */
let lastScoreAt = 0;
let ticking = false;
// Starts at boot so a freshly woken worker waits for the existing camera doc to report in.
let lastOffscreenAttempt = Date.now();

// Small runtime flags that must survive restarts.
interface Runtime {
  lastFiredAt: number | null;
  /** The problem being followed, if any. While it runs, the screenshot loop watches `sessionTabId`. */
  sessionActive: string | null;
  sessionTabId: number | null;
  sessionUrl: string | null;
  /** Which problem it follows (page + question, see problemTracker) and its name as the page shows it. */
  sessionKey: string | null;
  sessionLabel: string | null;
  sessionStartedAt: number | null;
  /** Problems the student sent away or finished: myTA doesn't start following them again by itself. */
  declined: string[];
  /** The latest mistake or check myTA made by itself. */
  autoCheck: AutoCheck | null;
  /** How demanding the problem is (1-5): sets how long the sprite and the "finished" check wait. */
  sessionTraits: ProblemTraits | null;
  /** A fingerprint of the problem page's text when the session began, to tell a new problem from the same one. */
  sessionSig: string;
  /** What the sprite is saying right now (there is only ever one), the tab it is in, and when it appeared. */
  sprite: SpriteContent | null;
  spriteTab: number | null;
  spriteAt: number;
  /** The latest hint myTA showed on the sprite. */
  autoHint: { id: number; sessionId: string; message: string; level: HintLevel; at: number } | null;
  /** The tab where the student writes their work (not the problem tab), found automatically or pinned in the panel. */
  workTabId: number | null;
  workPinned: boolean;
  /** The latest attempt to start following a problem. */
  start: StartState | null;
  /** The "check your work?" offer currently on the sprite, if any. */
  checkOffer: { tabId: number; sessionId: string; at: number } | null;
  /** One offer per session. */
  offeredFor: string | null;
  /** Mistakes flagged on this problem; and the problem the student has been congratulated on (cleared when a mistake is flagged after it). */
  flagged: number;
  celebratedFor: string | null;
  /** The answer on this problem was right (stats). */
  solved: boolean;
  /** A mistake found while they wrote isn't flagged again before this time (the student dismissed it). */
  reflagAfter: number;
}
const RUNTIME_KEY = 'runtime';
const DEFAULT_RUNTIME: Runtime = {
  lastFiredAt: null,
  sessionActive: null,
  sessionTabId: null,
  sessionUrl: null,
  sessionKey: null,
  sessionLabel: null,
  sessionStartedAt: null,
  declined: [],
  autoCheck: null,
  sessionTraits: null,
  sessionSig: '',
  sprite: null,
  spriteTab: null,
  spriteAt: 0,
  autoHint: null,
  workTabId: null,
  workPinned: false,
  start: null,
  checkOffer: null,
  offeredFor: null,
  flagged: 0,
  celebratedFor: null,
  solved: false,
  reflagAfter: 0,
};
let runtime: Runtime = { ...DEFAULT_RUNTIME };
const runtimeReady = chrome.storage.session.get(RUNTIME_KEY).then((r) => {
  if (r[RUNTIME_KEY]) runtime = { ...DEFAULT_RUNTIME, ...(r[RUNTIME_KEY] as Partial<Runtime>) };
});
async function setRuntime(patch: Partial<Runtime>) {
  await runtimeReady; // never write defaults over what a previous worker persisted
  runtime = { ...runtime, ...patch };
  await chrome.storage.session.set({ [RUNTIME_KEY]: runtime });
}
const ready = () => Promise.all([settingsReady, runtimeReady]);

const cameraOk = () => !!face && Date.now() - face.at < FACE_STALE_MS * 2;
/** Every model call made, by kind: the numbers behind "is it really calling the API only when it needs to?". */
const CALLS_KEY = 'callStats';
const calls: EyesState['calls'] = { total: 0, byKind: {}, lastMs: null, promptTokens: 0, cachedTokens: 0 };
const callsReady = chrome.storage.session.get(CALLS_KEY).then((r) => {
  if (r[CALLS_KEY]) Object.assign(calls, r[CALLS_KEY]);
});
function noteCall(c: CallRecord) {
  calls.total++;
  calls.byKind[c.kind] = (calls.byKind[c.kind] ?? 0) + 1;
  calls.lastMs = c.ms;
  calls.promptTokens += c.promptTokens ?? 0;
  calls.cachedTokens += c.cachedTokens ?? 0;
  void callsReady.then(() => chrome.storage.session.set({ [CALLS_KEY]: calls }));
}

/** Small copies of the pictures behind the last few model calls, so the panel can show exactly what the model saw. */
const SENT_KEY = 'sentShots';
const SENT_MAX = 6;
let sentShots: SentShot[] = [];
const sentReady = chrome.storage.session.get(SENT_KEY).then((r) => {
  if (Array.isArray(r[SENT_KEY])) sentShots = r[SENT_KEY] as SentShot[];
});
async function noteSent(s: SendRecord) {
  try {
    const images = await Promise.all(s.images.map(async (i) => ({ caption: i.caption, thumb: await thumbnail(i.jpeg) })));
    await sentReady;
    sentShots = [{ at: Date.now(), kind: s.kind, images }, ...sentShots].slice(0, SENT_MAX);
    await chrome.storage.session.set({ [SENT_KEY]: sentShots });
  } catch {
    /* thumbnails are only a convenience */
  }
}
/**
 * The quick model isn't available to this key (the name in setup is out of date, or the key is for a different tier): look at what the key CAN
 * use, switch to the best quick model and remember it, so a wrong default never leaves the student without help. Tried once at a time.
 */
let healing: Promise<string | null> | null = null;
function healModel(missing: string): Promise<string | null> {
  healing ??= (async () => {
    const ids = await listModelIds(settings.geminiKey);
    const alt = ids ? pickFastModel(ids) : null;
    if (!alt || alt === missing) return null;
    monitor.logEvent(`The model "${missing}" isn't available to this key: using "${alt}" instead.`);
    await updateSettings({ model: alt });
    return alt;
  })().finally(() => {
    setTimeout(() => (healing = null), 30_000);
  });
  return healing;
}
const llmCtx = () => ({ apiKey: settings.geminiKey, model: settings.model, smartModel: settings.solverModel, limiter, onCall: noteCall, onSend: (s: SendRecord) => void noteSent(s), onModelMissing: healModel });
const triggerMemory = () => (runtime.lastFiredAt && Date.now() - runtime.lastFiredAt < TRIGGER_MEMORY_MS ? runtime.lastFiredAt : null);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------- screenshot loop ----------------

async function pageContext(tabId: number | null): Promise<PageContext | null> {
  if (tabId === null) return null;
  return chrome.tabs.sendMessage(tabId, { type: 'get-page-context' } satisfies Msg, { frameId: 0 }).catch(() => null);
}

/** Is this problem still the one being followed, and is myTA allowed to say something about it? */
const following = (id: string) => runtime.sessionActive === id;

const monitor = new Monitor({
  store: createFrameStore(),
  intervalMs: () => snapshotMs(settings),
  // Snapshots are kept on this device only. Outside a session they are taken once myTA is set up, and not while snoozed.
  active: () => readiness(settings).ready && settings.enabled && Date.now() >= settings.snoozedUntil,
  session: () =>
    runtime.sessionActive && runtime.sessionTabId !== null
      ? { id: runtime.sessionActive, problemTabId: runtime.sessionTabId, workTabId: runtime.workTabId, workPinned: runtime.workPinned, startedAt: runtime.sessionStartedAt ?? Date.now() }
      : null,
  score: () => (Date.now() - lastScoreAt < 10_000 ? lastOutput.score : null),
  finish: () => finishConfig(settings, runtime.sessionTraits),
  progress: () => {
    const every = reviewMs(settings, runtime.sessionTraits);
    return every === null ? null : { everyMs: every };
  },
  gateConfig: () => {
    const first = firstCheckpointMs(settings, runtime.sessionTraits);
    return first === null ? {} : { firstCheckpointMs: first };
  },
  hasHeadroom: () => limiter.remaining() >= REVIEW_MIN_HEADROOM,
  review: async (job) => {
    // The two pages are asked at the same time. The work tab's own text only when it is a different tab from the problem (a page of canvas has none anyway).
    const [problemContext, workContext] = await Promise.all([pageContext(runtime.sessionTabId), job.separate ? pageContext(job.work.tabId) : Promise.resolve(null)]);
    const shots = { work: job.work.jpeg, problem: job.problem?.jpeg ?? null, problemContext, workContext, separateTabs: job.separate };
    // The student stopped, or the homework page just said the answer is wrong: either way it is a check of the answer,
    // and if it is wrong the sprite says where.
    if (job.reason === 'finished' || job.reason === 'wrong-answer') return finishCheck(job, shots);
    // Every other look is a reading. If it finds a mistake, or the finished answer, the sprite says so right away: the flag goes up
    // the moment the model has read the work, and the words follow once they have been through the leak guard.
    let r: tutor.ReadResult;
    // What the early notice put on the sprite has to finish going up before the checked words are put in, however quickly the guard answers.
    let earlyDone: Promise<void> = Promise.resolve();
    try {
      r = await tutor.observeWork(llmCtx(), job.sessionId, shots, job.detail, {
        wantMessage: wantsMessage(job.sessionId),
        idleMs: job.idleMs,
        copyReady: copyReads + 1 >= COPY_READS_TO_FLAG && (job.idleMs ?? 0) >= COPY_IDLE_MS,
        onEarly: (e) => {
          earlyDone = onEarlyRead(job, e).catch(() => undefined);
        },
      });
    } catch (e) {
      await earlyDone;
      await settleEarly(job.sessionId);
      throw e;
    }
    await earlyDone;
    await onRead(job, r);
    return tutor.outcomeOf(r.state.status);
  },
  onOutcome: (outcome) => noteOutcome(outcome),
  onSolvedByPage: () => void celebrate('page'),
  onWorkTab: (id) => void setRuntime({ workTabId: id }).then(relocateSprite),
});

/** Called from every page signal, panel poll and a timer; the monitor itself only acts once per snapshot interval. */
async function pumpMonitor(): Promise<void> {
  await ready();
  if (!settings.enabled) return;
  if (runtime.checkOffer && Date.now() - runtime.checkOffer.at > CHECK_OFFER_TTL_MS) {
    await clearCheckOffer();
    void refollowIfPageChanged('the offer to check expired', 10_000);
  }
  await monitor.pump().catch(() => {});
  void syncPills();
}

// ---------------- offscreen camera ----------------

async function hasOffscreen(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] });
  return contexts.length > 0;
}

async function ensureOffscreen(): Promise<void> {
  const { ready: setUp } = readiness(settings);
  if (!setUp || !settings.enabled) return closeOffscreen();
  if (await hasOffscreen()) return;
  lastOffscreenAttempt = Date.now();
  await chrome.offscreen
    .createDocument({
      url: OFFSCREEN_URL,
      reasons: [chrome.offscreen.Reason.USER_MEDIA],
      justification: 'On-device webcam confusion detection; frames never leave the device.',
    })
    .catch((e) => console.warn('offscreen create failed', e));
}

async function closeOffscreen(): Promise<void> {
  face = null;
  if (await hasOffscreen()) await chrome.offscreen.closeDocument().catch(() => {});
}

async function updateBadge(): Promise<void> {
  const { ready: setUp } = readiness(settings);
  const [text, color, title] = !settings.enabled
    ? ['off', '#636e72', 'myTA is off']
    : !setUp
      ? ['!', '#e17055', 'myTA: finish setup on the options page']
      : cameraOk()
        ? ['●', '#d63031', 'myTA: camera on (processed on-device only)']
        : ['cam', '#e17055', `myTA: camera unavailable${cameraError ? ` (${cameraError})` : ''}`];
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setTitle({ title });
}

// ---------------- the sprite: one character, one place ----------------

type NudgeMsg = Extract<Msg, { type: 'nudge' }>;

/**
 * Sends a sprite message to a page. A page that was open before the extension was installed or reloaded has no content script
 * yet; when showing, inject one and try again, so the sprite can never fail to appear just because of that.
 */
async function sendNudge(tabId: number, msg: NudgeMsg): Promise<boolean> {
  monitor.ownUiChanged(); // the sprite appearing or going away is a change on screen, but not the student's work
  try {
    await chrome.tabs.sendMessage(tabId, msg, { frameId: 0 });
    return true;
  } catch (e) {
    if (!msg.show || !/Receiving end does not exist/i.test(String((e as Error)?.message ?? e))) return !msg.show;
    // Only a normal web page is worth a note: an extension page or chrome:// tab was never going to have a sprite.
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab?.url || !/^(https?|file):/.test(tab.url)) return false;
    try {
      const files = (chrome.runtime.getManifest().content_scripts ?? []).flatMap((c) => c.js ?? []);
      await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files });
      await sleep(400);
      await chrome.tabs.sendMessage(tabId, msg, { frameId: 0 });
      return true;
    } catch {
      monitor.logEvent('I couldn\'t show the sprite on that page (Chrome blocks extensions there).');
      return false;
    }
  }
}

/**
 * The one place the sprite lives: the tab where the student writes their work. Before myTA has found that tab (or when they
 * work on the problem page itself) it is the problem's own tab.
 */
function spriteTabId(): number | null {
  return runtime.workTabId ?? runtime.sessionTabId ?? activeTabId;
}

let lastSpritePushAt = 0;

/** Puts the sprite up (replacing whatever it was saying) in the work tab, and takes it down from any other tab it was in. */
async function showSprite(content: SpriteContent): Promise<void> {
  await ready();
  const tab = spriteTabId();
  if (tab === null) return;
  const prev = runtime.spriteTab;
  const prevKind = runtime.sprite?.kind;
  await setRuntime({ sprite: content, spriteTab: tab, spriteAt: Date.now() });
  lastSpritePushAt = Date.now();
  if (prev !== null && prev !== tab && prevKind) await sendNudge(prev, { type: 'nudge', show: false, kind: prevKind });
  const delivered = await sendNudge(tab, { type: 'nudge', show: true, kind: content.kind, content });
  // The work tab can't show a sprite (a PDF viewer, a chrome:// page): the page the student is actually on can, so they are never left without it.
  if (!delivered && activeTabId !== null && activeTabId !== tab) {
    await setRuntime({ spriteTab: activeTabId });
    await sendNudge(activeTabId, { type: 'nudge', show: true, kind: content.kind, content });
  }
}

/** Changes what the sprite is saying without making it reappear (a hint arrives, a clip is found). Does nothing if it has moved on to something else. */
async function updateSprite(kind: NudgeKind, patch: Partial<SpriteContent>): Promise<boolean> {
  await ready();
  const cur = runtime.sprite;
  const tab = runtime.spriteTab;
  if (!cur || cur.kind !== kind || tab === null) return false;
  const next = { ...cur, ...patch };
  // The words arriving is when a hint appears to the student: it stays up long enough to be read from then, not from when "reading your work" showed.
  const wordsArrive = patch.text !== undefined && !cur.text;
  await setRuntime({ sprite: next, ...(wordsArrive ? { spriteAt: Date.now() } : {}) });
  lastSpritePushAt = Date.now();
  await sendNudge(tab, { type: 'nudge', show: true, kind, content: next });
  return true;
}

/** Takes the sprite down (only if it is saying `kind`, when given). */
async function hideSprite(kind?: NudgeKind): Promise<void> {
  await ready();
  const cur = runtime.sprite;
  if (!cur || (kind && cur.kind !== kind)) return;
  const tab = runtime.spriteTab;
  await setRuntime({ sprite: null, spriteTab: null });
  if (tab !== null) await sendNudge(tab, { type: 'nudge', show: false, kind: cur.kind });
}

/** The work tab was found (or changed) while the sprite was up: move it there, so it never stays behind in the other tab. */
async function relocateSprite(): Promise<void> {
  const cur = runtime.sprite;
  if (!cur) return;
  const tab = spriteTabId();
  if (tab === null || tab === runtime.spriteTab) return;
  const at = runtime.spriteAt;
  await showSprite(cur);
  await setRuntime({ spriteAt: at });
}

/** Setup is done and the student hasn't been greeted yet: the greeting waits for a page it can appear on (not the setup page itself). */
let welcomePending = false;

async function maybeWelcome(): Promise<void> {
  if (!welcomePending) return;
  await ready();
  if (!readiness(settings).ready || activeTabId === null) return;
  const t = await chrome.tabs.get(activeTabId).catch(() => null);
  if (!t?.url || !/^(https?|file):/.test(t.url)) return;
  welcomePending = false;
  await chrome.storage.local.set({ welcomed: true });
  await sayHello(true);
}

/** How long a greeting stays up before the sprite goes back to waiting. */
const HELLO_MS = 9000;

/**
 * The sprite says hello on the page the student is looking at: once when setup is finished, and whenever they pick a new character in setup,
 * so they can see it right away. Never over something it is already saying (a hint, a mistake), and it goes away by itself.
 */
async function sayHello(welcome = false): Promise<void> {
  await ready();
  if (runtime.sprite && runtime.sprite.kind !== 'hello') return;
  // The page the student is on; from the setup page (which has no sprite), the ordinary page in front in any other window.
  const current = activeTabId === null ? null : await chrome.tabs.get(activeTabId).catch(() => null);
  const t = current?.url && /^(https?|file):/.test(current.url) ? current : (await chrome.tabs.query({ active: true })).find((x) => capturable(x));
  if (!t?.id) return;
  const tab = t.id;
  const prev = runtime.spriteTab;
  const prevKind = runtime.sprite?.kind;
  await setRuntime({ sprite: { kind: 'hello', title: phrases.next('hello'), text: welcome ? phrases.next('helloLine') : "Here I am. I'll look like this on every page now." }, spriteTab: tab, spriteAt: Date.now() });
  lastSpritePushAt = Date.now();
  if (prev !== null && prev !== tab && prevKind) await sendNudge(prev, { type: 'nudge', show: false, kind: prevKind });
  await sendNudge(tab, { type: 'nudge', show: true, kind: 'hello', content: runtime.sprite! });
  const at = runtime.spriteAt;
  setTimeout(() => {
    if (runtime.spriteAt === at) void hideSprite('hello');
  }, HELLO_MS);
}

// ---------------- engine tick ----------------

async function tick(): Promise<void> {
  const now = Date.now();
  if (ticking || now - lastTickAt < 900) return;
  ticking = true;
  lastTickAt = now;
  try {
    await ready();
    const { ready: setUp } = readiness(settings);
    if (!setUp || !settings.enabled) return;
    // The camera is mandatory: without it, tracking pauses (and we try to bring it back).
    if (!cameraOk()) {
      if (now - lastOffscreenAttempt > 15_000) {
        lastOffscreenAttempt = now;
        if (await hasOffscreen()) await closeOffscreen();
        await ensureOffscreen();
      }
      return;
    }

    const persisted = await store.load();
    const page = mergePage(frames, activeTabId, now);
    const { state: engine, output } = step(persisted.engine, {
      now,
      page,
      tab: tabSignals(now),
      face: face && now - face.at < FACE_STALE_MS ? face.reading : null,
    });
    const prevPhase = persisted.trigger.phase;
    // The one rule: the score at or above the threshold for the wait (the slider, plus a little more for a harder problem).
    const cfg = triggerConfig(settings, runtime.sessionTraits);
    const { state: trigger, fired } = stepTrigger(persisted.trigger, output.score, now, cfg, { enabled: true, snoozedUntil: settings.snoozedUntil });
    await store.save({ engine, trigger });
    lastOutput = output;
    lastScoreAt = now;

    if (fired) {
      await setRuntime({ lastFiredAt: now });
      if (runtime.sessionActive && runtime.celebratedFor === runtime.sessionActive) {
        // They already got this one right: nothing left to be stuck on.
        monitor.logEvent('The confusion score stayed high, but this problem is already solved, so the sprite stays away.');
        await acknowledgeNudge(false);
      } else {
        monitor.logEvent(`The confusion score stayed at ${cfg.threshold}+ long enough (now ${output.score}): the sprite is stepping in.`);
        void helpNudge(output.topContributors);
      }
    } else if (prevPhase === 'confused' && trigger.phase !== 'confused') {
      hideStuckSoon();
    }

    // A nudge that waited for a message about their work to be read: offer it now, if they are still stuck.
    if (pendingNudge && !fired) {
      const p = pendingNudge;
      if (now - p.at > PENDING_NUDGE_MS || output.score < cfg.threshold - 10) pendingNudge = null;
      else if (!runtime.sprite && now - p.at > 2000 && output.score >= cfg.threshold) {
        pendingNudge = null;
        monitor.logEvent(`You are still stuck (score ${output.score}): the sprite offers a hint now.`);
        void helpNudge(p.reasons);
      }
    }

    if (settings.labelMode) {
      const signals: Record<string, number> = {};
      for (const s of [...(page?.content ?? []), ...(page?.activity ?? []), ...(face?.reading.signals ?? [])])
        signals[s.id] = Math.round(s.value * 100) / 100;
      logger.tick({ t: now, score: output.score, channels: output.channels, signals, fired });
    }
  } finally {
    ticking = false;
  }
}

async function acknowledgeNudge(snooze: boolean) {
  const persisted = await store.load();
  await store.save({ ...persisted, trigger: enterCooldown(persisted.trigger, Date.now(), triggerConfig(settings, runtime.sessionTraits)) });
  if (snooze) await updateSettings({ snoozedUntil: Date.now() + SNOOZE_MS });
}

// ---- the sprite steps in with a hint: it has already read the student's work ----

let hinting = false;
/** A nudge that had to wait because something more useful was on the sprite (a mistake, a cheer); it is offered once that is gone, if they are still stuck. */
let pendingNudge: { reasons: string[]; at: number } | null = null;
const PENDING_NUDGE_MS = 3 * 60_000;
/** How far the general guiding questions (used when no hint can be written) have got: they get a little more pointed each time. */
let genericLevel = 0;

function genericQuestion(escalate: boolean): string {
  genericLevel = Math.min(3, escalate ? genericLevel + 1 : Math.max(1, genericLevel));
  return fallbackQuestion(genericLevel as HintLevel, Date.now() + genericLevel);
}

/**
 * The confusion score stayed high long enough. The sprite ALWAYS appears at once, before anything slow (following the problem, reading the work,
 * writing the hint) has happened; if myTA is following the problem it reads the student's work right now and the sprite turns into a short hint
 * about where to look (never the answer). "Another hint" calls this again and goes one level deeper. A hint that finds a missing prerequisite also
 * brings a short video on it (SerpApi). If no hint can be written (the page isn't a problem myTA can follow, the model is unreachable), the sprite
 * still has something to say: a general guiding question that needs no model.
 */
async function helpNudge(reasons: string[], escalate = false): Promise<void> {
  if (hinting) {
    // A hint is still being worked out (or its call is slow): this nudge is kept and offered afterwards if they are still stuck, never lost.
    if (!escalate) pendingNudge = { reasons, at: Date.now() };
    return;
  }
  hinting = true;
  // A call that never comes back must not keep the sprite from ever appearing again.
  const watchdog = setTimeout(() => (hinting = false), 150_000);
  try {
    await ready();
    const cur = runtime.sprite?.kind;
    // Where their work went wrong, or a congratulation, or the offer to check, is already up: that is the help, so don't cover it. It comes
    // after, if they are still stuck.
    if (cur === 'mistake' || cur === 'cheer' || cur === 'check-work') {
      pendingNudge = { reasons, at: Date.now() };
      monitor.logEvent('The confusion score is high, but a message about your work is on the sprite: a hint comes after you have read it, if you are still stuck.');
      return;
    }
    // Already helping with a hint they are reading: don't start over on top of it (unless they asked for another).
    if (cur === 'stuck' && !escalate) return;
    pendingNudge = null;

    const score = lastOutput.score;
    const wantHint = settings.autoHint;
    // First, the sprite itself: it is on screen before any of the slow parts.
    await showSprite({ kind: 'stuck', title: phrases.next(wantHint ? 'pending' : 'offer'), pending: wantHint, reasons, score, canVideo: true });
    if (!wantHint) return;
    let id = runtime.sessionActive;
    try {
      // Confused, but not following anything yet? Start following this page if it is a problem.
      id = id ?? (await followForHint());
      if (!id) {
        monitor.logEvent("The confusion score stayed high, but myTA isn't following a problem on this page, so the sprite asks a general question.");
        await updateSprite('stuck', { pending: false, title: phrases.next('hint'), text: genericQuestion(escalate), canVideo: false });
        return;
      }
      await monitor.snapshotNow();
      const f = monitor.forTutor();
      const noticed = reasons.length ? `the confusion signals were: ${reasons.join('; ')}` : 'their confusion score has stayed high';
      const h = await tutor.proactiveHint(llmCtx(), id, { work: f.work?.jpeg, problem: f.problem?.jpeg }, noticed, escalate);
      if (!following(id) || runtime.sprite?.kind !== 'stuck') {
        // They moved on, dismissed it, or something more important replaced it. If "reading your work" is still up it belongs to the problem
        // they left: take it down, and offer help on the new problem if they are still stuck.
        if (runtime.sprite?.kind === 'stuck' && runtime.sprite.pending) {
          await hideSprite('stuck');
          pendingNudge = { reasons, at: Date.now() };
        }
        return;
      }
      await setRuntime({ autoHint: { id: Date.now(), sessionId: id, message: h.message, level: h.hintLevel, at: Date.now() } });
      monitor.logEvent(`Showed a level ${h.hintLevel} hint on the sprite.`);
      await updateSprite('stuck', { pending: false, title: phrases.next('hint'), text: h.message, hintLevel: h.hintLevel, canVideo: true });
      if (h.missingPrerequisite) {
        monitor.logEvent(`The hint noticed a missing idea (${h.missingPrerequisite}): looking for a short video on it.`);
        void offerVideo(h.missingPrerequisite);
      }
    } catch (e) {
      // Couldn't write a hint (rate limit, bad key): the sprite never sits on "taking a look…", it asks a general question instead.
      monitor.logEvent(`Couldn't write a hint: ${friendly(e)}`);
      await updateSprite('stuck', { pending: false, title: phrases.next('hint'), text: genericQuestion(escalate), canVideo: !!id });
    }
  } finally {
    clearTimeout(watchdog);
    hinting = false;
  }
}

/**
 * The score stayed high while nothing is being followed: start following the page the student is on, if it is a problem (the same
 * checks as the automatic start, without its waiting). Returns the new session, or null when this isn't a page myTA can follow.
 */
async function followForHint(): Promise<string | null> {
  if (!settings.autoTrack) return null; // they asked to start things by hand
  const tab = await activeTab();
  if (!capturable(tab)) return null;
  const ctx = await pageContext(tab.id);
  if (!ctx || !looksLikeProblem(ctx)) return null;
  const key = problemKey(ctx.url, ctx.question);
  if (key && !isNumbered(key) && severalQuestions(ctx.viewportText)) return null;
  monitor.logEvent(`Confused on ${displayLabel(ctx)}: following it now.`);
  const r = await beginSession({ tabId: tab.id, context: ctx });
  return 'sessionId' in r && r.sessionId ? r.sessionId : null;
}

/** The score came back down. A hint that has only just appeared stays up long enough to be read. */
function hideStuckSoon(): void {
  const at = runtime.spriteAt;
  const wait = Math.max(0, at + MIN_HINT_SHOWN_MS - Date.now());
  setTimeout(() => {
    const c = runtime.sprite;
    // Not while they are still reading a hint they just asked for, or a clip is on its way or on screen.
    if (runtime.spriteAt === at && c?.kind === 'stuck' && !c.pending && !c.video && c.videoState !== 'loading') void hideSprite('stuck');
  }, wait);
}

// ---- a short video on the idea behind the trouble (SerpApi + the model), shown on the sprite ----

/** Finds a clip on the missing idea and shows it on the sprite. One at a time; nothing happens if the sprite has moved on. */
async function offerVideo(prereq = ''): Promise<void> {
  await ready();
  const id = runtime.sessionActive;
  const cur = runtime.sprite;
  if (!id || !cur || (cur.kind !== 'stuck' && cur.kind !== 'mistake') || cur.video || cur.videoState === 'loading') return;
  const kind = cur.kind;
  await updateSprite(kind, { videoState: 'loading', videoError: undefined });
  try {
    const found = await tutor.findVideo(llmCtx(), settings.serpKey, id, prereq);
    if (!following(id)) return;
    const v = { ...found, thumb: await videoThumb(found.videoId) };
    monitor.logEvent(`Found a short clip on ${v.concept}: ${v.title} (starts at ${Math.floor(v.start / 60)}:${String(v.start % 60).padStart(2, '0')}).`);
    await updateSprite(kind, { video: v, videoState: undefined, videoError: undefined, canVideo: false });
  } catch (e) {
    monitor.logEvent(`Couldn't find a clip: ${friendly(e)}`);
    await updateSprite(kind, { videoState: 'error', videoError: friendly(e) });
  }
}

/**
 * The video's thumbnail as a data URL. The sprite lives inside other sites' pages, whose security policies often block images from
 * elsewhere, so the picture is fetched here and handed over as data. Undefined when it can't be had (the card works without it).
 */
async function videoThumb(videoId: string): Promise<string | undefined> {
  try {
    const res = await fetch(`https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return undefined;
    const bytes = new Uint8Array(await res.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return `data:image/jpeg;base64,${btoa(bin)}`;
  } catch {
    return undefined;
  }
}

/** Opens a video in a small window beside the work (the address is built here from the id, never taken from the page). */
async function openVideo(videoId: string, start: number): Promise<void> {
  if (!/^[\w-]{11}$/.test(videoId)) return;
  const url = `https://www.youtube.com/watch?v=${videoId}&t=${Math.max(0, Math.floor(Number(start) || 0))}s`;
  await chrome.windows.create({ url, type: 'popup', width: 900, height: 620 }).catch(() => chrome.tabs.create({ url }));
}

// ---------------- following a problem ----------------

function friendly(e: unknown): string {
  if (e instanceof LlmError || e instanceof SerpError || e instanceof RateLimitError) return e.message;
  if (e instanceof Error) return e.message;
  return 'Something went wrong.';
}

/** Starts run one at a time, so a click in the panel and the automatic path for the same problem can't race each other. */
let serial: Promise<unknown> = Promise.resolve();
function inOrder<T>(fn: () => Promise<T>): Promise<T> {
  const run = serial.then(fn);
  serial = run.catch(() => undefined);
  return run;
}

interface BeginArg {
  tabId?: number;
  context?: PageContext | null;
  /** Solve again even though the page and question look the same (a site that swapped the problem without changing either). */
  force?: boolean;
}

/**
 * Starts following a problem with no manual steps: capture the tab, read the page, have the model solve the problem
 * privately. If myTA is already following this very problem, nothing happens.
 */
function beginSession(arg: BeginArg = {}) {
  return inOrder(() => doBegin(arg));
}

/** A session is over. One that never needed a hint (and wasn't solved) leaves no summary behind: myTA just followed along. */
async function retire(id: string): Promise<void> {
  if (runtime.solved || (await tutor.worthSummary(id))) await tutor.endSession(id, runtime.solved);
  else await tutor.discardSession(id);
}

/** What the monitor of the previous problem was holding: forgotten with it. */
let unsureMistakeReads = 0;

/** Forgets the problem myTA was following (its notes are already gone). `decline` keeps it from being picked up again by itself. */
async function clearSession(decline: boolean): Promise<void> {
  await clearCheckOffer();
  await hideSprite();
  pendingNudge = null;
  genericLevel = 0;
  monitor.reset();
  tracker.sessionChanged();
  unsureMistakeReads = 0;
  copyReads = 0;
  early = null;
  await setRuntime({
    sessionActive: null,
    sessionTabId: null,
    sessionUrl: null,
    sessionKey: null,
    sessionLabel: null,
    sessionStartedAt: null,
    sessionTraits: null,
    sessionSig: '',
    autoHint: null,
    declined: decline && runtime.sessionKey ? [...runtime.declined, runtime.sessionKey].slice(-20) : runtime.declined,
    autoCheck: null,
    workTabId: null,
    workPinned: false,
    start: null,
    offeredFor: null,
    flagged: 0,
    celebratedFor: null,
    solved: false,
    reflagAfter: 0,
  });
}

async function doBegin({ tabId, context, force = false }: BeginArg): Promise<StartSessionResult | { error: string }> {
  await ready();
  try {
    const tab = tabId !== undefined ? await chrome.tabs.get(tabId) : await activeTab();
    const ctx = context === undefined ? await pageContext(tab?.id ?? null) : context;
    const key = problemKey(ctx?.url ?? tab?.url, ctx?.question);

    // Already following this very problem: no second solve.
    if (!force && key && key === runtime.sessionKey && tab?.id === runtime.sessionTabId && runtime.sessionActive && (await getSession(runtime.sessionActive))) {
      return { sessionId: runtime.sessionActive, problemDetected: true, message: '' };
    }

    await setRuntime({ start: { status: 'starting', at: Date.now() } });
    const cap = tab ? await monitor.capture(tab) : null;
    if (!cap) {
      throw new Error('I can\'t see this page. Chrome blocks extensions on pages like chrome:// and the Web Store. Open your problem in a normal tab and try again.');
    }

    const prior = runtime.sessionActive;
    // `force` means the page may have swapped the problem under the same address and question label: the remembered solution can't be trusted.
    const r = await tutor.startSession(llmCtx(), cap.frame.jpeg, ctx, triggerMemory(), force);
    if (!r.sessionId) {
      await setRuntime({ start: { status: 'error', error: r.message, problemDetected: false, at: Date.now() } });
      return r;
    }
    // The board the student writes on carries over to the next problem on the same page; it is only forgotten if that tab is gone.
    const keepWork = prior && runtime.workTabId !== null && runtime.workTabId !== tab?.id;
    const workTabId = keepWork ? runtime.workTabId : null;
    const workPinned = keepWork ? runtime.workPinned : false;
    if (prior) await retire(prior); // the student moved on to a new problem
    // What the sprite is saying was about the problem they left, so it goes: unless it is the "reading your work" sprite that is waiting for this
    // very problem to be worked out (the hint follows as soon as it is).
    const leaving = runtime.sprite;
    if (!(leaving?.kind === 'stuck' && leaving.pending)) {
      await hideSprite();
      // A hint they were still reading is taken down by the system, not by them: if they are still stuck on the next problem, the nudge comes again.
      if (leaving?.kind === 'stuck' && prior) pendingNudge = { reasons: leaving.reasons ?? [], at: Date.now() };
      else pendingNudge = null;
    }
    genericLevel = 0;
    monitor.reset();
    tracker.sessionChanged();
    unsureMistakeReads = 0;
  copyReads = 0;
  early = null;
    await setRuntime({
      sessionActive: r.sessionId,
      workTabId,
      workPinned,
      sessionTabId: tab?.id ?? null,
      sessionUrl: tab?.url ?? null,
      sessionKey: key,
      sessionLabel: ctx ? displayLabel(ctx) : null,
      sessionTraits: r.traits ?? (r.difficulty ? { difficulty: r.difficulty } : null),
      sessionSig: pageSignature(ctx),
      autoHint: null,
      sessionStartedAt: Date.now(),
      lastFiredAt: runtime.lastFiredAt,
      checkOffer: null,
      offeredFor: null,
      autoCheck: null,
      flagged: 0,
      celebratedFor: null,
      solved: false,
      reflagAfter: 0,
      start: { status: 'ready', sessionId: r.sessionId, problemDetected: true, at: Date.now() },
    });
    return r;
  } catch (e) {
    const error = friendly(e);
    await setRuntime({ start: { status: 'error', error, at: Date.now() } });
    return { error };
  }
}

// ---- a site that swaps the problem without changing its address ----

/** A fingerprint of what the problem page says (not what the student typed in it), to tell whether the page really changed. */
function pageSignature(ctx: PageContext | null): string {
  if (!ctx) return '';
  const text = ctx.viewportText.replace(/\[student input:[^\]]*\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 600);
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return String(h);
}

let differentStreak = 0;
let lastRefollowAt = 0;

/**
 * If the problem page now shows something other than the problem being followed, follow the new one (solving it again, quietly).
 * Many sites (Khan Academy among them) put the next problem at the same address with no question label, so nothing in the
 * address says it changed: the page's own text does. Rate-limited, and only when the text really is different, so a work
 * screen that merely looks different can't make it re-solve the same problem over and over.
 */
async function refollowIfPageChanged(why: string, minGapMs: number): Promise<void> {
  await ready();
  const tabId = runtime.sessionTabId;
  if (tabId === null || !runtime.sessionActive || !settings.autoTrack || runtime.checkOffer || Date.now() - lastRefollowAt < minGapMs) return;
  const ctx = await pageContext(tabId);
  if (!ctx || pageSignature(ctx) === runtime.sessionSig) return;
  // What the sprite just said is about the problem they have left (where it went wrong, or what the check found). Following the next
  // problem takes the sprite down, so give them time to read it first, then follow.
  const sp = runtime.sprite;
  const aboutOld = !!sp && (sp.kind === 'mistake' || (sp.kind === 'stuck' && !sp.pending && !!sp.text));
  const age = Date.now() - runtime.spriteAt;
  if (aboutOld && age < SPRITE_READ_MS) {
    setTimeout(() => void refollowIfPageChanged(why, 0), SPRITE_READ_MS - age + 300);
    return;
  }
  differentStreak = 0;
  lastRefollowAt = Date.now();
  monitor.logEvent(`The problem page shows something new (${why}): following the new problem.`);
  toast('That looks like a new problem. Following it now…');
  await beginSession({ tabId, context: ctx, force: true });
}

/**
 * What each look found. The model can tell a new problem from the one it solved, because it is comparing the screen with the
 * answer key: two looks in a row saying "this is a different problem" means check whether the page really changed.
 */
function noteOutcome(outcome: CallOutcome): void {
  if (outcome !== 'different') {
    differentStreak = 0;
    return;
  }
  differentStreak++;
  if (differentStreak >= 2) void refollowIfPageChanged('the model says so', 60_000);
}

// ---- following problems on its own ----

const tracker = new ProblemTracker();
let tracking = false;
let autoStarting = false;

/**
 * Called as pages report in. When the student has stayed on a page that looks like a problem for a few seconds, myTA
 * starts following it (one model call to work it out privately); when they move to another problem, it notices that too.
 */
async function trackProblem(): Promise<void> {
  if (tracking) return;
  tracking = true;
  try {
    await ready();
    if (!settings.enabled || !readiness(settings).ready || Date.now() < settings.snoozedUntil) return;
    const now = Date.now();
    const session = runtime.sessionActive ? { key: runtime.sessionKey, tabId: runtime.sessionTabId } : null;
    const canStart = settings.autoTrack && !autoStarting && !runtime.checkOffer && !monitor.isFrozen && limiter.remaining() >= REVIEW_MIN_HEADROOM;
    const d = tracker.decide({ now, focusedTabId: activeTabId, canStart, session, declined: (k) => runtime.declined.includes(k) });
    if (d.kind === 'start') void autoStart(d.tabId, d.key);
    else if (d.kind === 'moved') await movedOn(d.key);
    else if (d.kind === 'back') await cameBack();
    else if (d.kind === 'refine') {
      // Same problem: the page just started naming the question the student is on.
      await setRuntime({ sessionKey: d.key, sessionLabel: labelOf(d.key) });
      monitor.logEvent(`You're working on ${labelOf(d.key)}.`);
    }
  } finally {
    tracking = false;
  }
}

async function autoStart(tabId: number, key: string): Promise<void> {
  autoStarting = true;
  try {
    const ctx = await pageContext(tabId);
    if (!ctx) return void tracker.reject(key, Date.now(), 30_000); // a page myTA can't read (no content script yet, a PDF)
    if (problemKey(ctx.url, ctx.question) !== key) return; // the student moved on while this was starting
    if (!looksLikeProblem(ctx)) return void tracker.reject(key, Date.now(), NOT_A_PROBLEM_MS);
    // Several questions on screen and none picked yet: wait until they click into one rather than guess which they are on.
    // (The key changes as soon as they do, so this doesn't hold anything up.)
    if (!isNumbered(key) && severalQuestions(ctx.viewportText)) return void tracker.reject(key, Date.now(), 60_000, 'several');
    const label = displayLabel(ctx);
    tracker.started(Date.now());
    monitor.logEvent(`Noticed ${label}: working it out privately.`);
    toast(`Noticed ${label}. Working it out privately…`);
    const r = await beginSession({ tabId, context: ctx });
    if ('error' in r) {
      tracker.reject(key, Date.now(), 2 * 60_000);
      monitor.logEvent(`Couldn't start following ${label}: ${r.error}`);
    } else if (!r.sessionId) {
      tracker.reject(key, Date.now(), NOT_A_PROBLEM_MS);
      monitor.logEvent(`${label} doesn't look like a problem to me.`);
    } else {
      monitor.logEvent(`Following ${label}.`);
      toast(`Following ${label}. ${settings.autoCheck ? "I'll check your answer when you finish." : "I'll watch your work."}`);
    }
  } finally {
    autoStarting = false;
  }
}

/** The tab myTA is following now shows a different problem. Quiet looks stop until it settles; the next problem is followed after a moment. */
async function movedOn(key: string): Promise<void> {
  const id = runtime.sessionActive;
  if (!id) return;
  const w = await getWork(id);
  if (w.status !== 'different_problem') await saveWork(id, { ...w, status: 'different_problem' });
  // Long enough for the new problem to be picked up (a few seconds on it), short enough that nothing stays blocked if it isn't.
  monitor.suspendLooks(20_000);
  const label = labelOf(key) || 'a different problem';
  monitor.logEvent(`You moved to ${label}.`);
  toast(settings.autoTrack ? `You've moved on to ${label}. I'll follow it once you settle on it.` : `You're on ${label} now.`);
}

async function cameBack(): Promise<void> {
  const id = runtime.sessionActive;
  if (!id) return;
  const w = await getWork(id);
  if (w.status === 'different_problem') await saveWork(id, { ...w, status: 'unknown' });
  monitor.resumeLooks();
  monitor.logEvent(`Back on ${runtime.sessionLabel ?? 'the problem'}.`);
}

// ---- what myTA says in a corner of the pages it is watching (status only: the sprite is the character) ----

const TOAST_MS = 8000;
let toastNow: { id: number; text: string; until: number } | null = null;
/** True once the toast's time is up and the pages have taken it down (taking it down is a change on screen too). */
let toastGone = true;
let lastPillsAt = 0;
const pillsSent = new Map<number, { json: string; at: number }>();

/** A line that appears on the page the student is looking at for a few seconds: what myTA just noticed or did. */
function toast(text: string): void {
  toastNow = { id: Date.now(), text, until: Date.now() + TOAST_MS };
  toastGone = false;
  lastPillsAt = 0;
  void syncPills();
}

/** The small status on the problem tab: which problem myTA is following, and whether it can read the student's work. */
function pillFor(label: string, work: WorkState, note: string | null): StatusPill {
  const base = `myTA · following ${label}`;
  // A failing model call (bad key, rate limit) must never be silent: reading stops until it works again, so say so on the page.
  if (note) return { text: `myTA · can't read your work right now: ${note.length > 70 ? `${note.slice(0, 67)}…` : note}`, tone: 'warn' };
  if (work.status === 'different_problem') return { text: `myTA · you've moved on from ${label}`, tone: 'info' };
  switch (work.readability) {
    case 'clear':
      return { text: `${base} · I can read your work`, tone: 'ok' };
    case 'hard_to_read':
      return { text: `${base} · your work is hard to read`, tone: 'warn' };
    case 'nothing_written':
      return { text: `${base} · waiting for your work`, tone: 'info' };
    default:
      return { text: base, tone: 'info' };
  }
}

/** Keeps the pill (and a fresh toast) on the tabs myTA is watching. Cheap to call often; it sends changes at once and the rest every few seconds. */
async function syncPills(): Promise<void> {
  const now = Date.now();
  if (now - lastPillsAt < 1000) return;
  lastPillsAt = now;
  await ready();
  const want = new Map<number, StatusPill>();
  const id = runtime.sessionActive;
  if (id && runtime.sessionTabId !== null && settings.enabled) {
    const work = await getWork(id);
    want.set(runtime.sessionTabId, pillFor(runtime.sessionLabel ?? 'this problem', work, monitor.note));
    if (runtime.workTabId !== null && runtime.workTabId !== runtime.sessionTabId) {
      want.set(runtime.workTabId, { text: 'myTA · reading this tab as your work', tone: 'info' });
    }
  }
  const t = toastNow && toastNow.until > now ? { id: toastNow.id, text: toastNow.text } : undefined;
  if (!t && !toastGone) {
    toastGone = true;
    monitor.ownUiChanged(now);
  }
  const targets = new Set<number>([...want.keys(), ...pillsSent.keys()]);
  if (t && activeTabId !== null) targets.add(activeTabId);
  for (const tabId of targets) {
    const pill = want.get(tabId) ?? null;
    const shown = t && (want.has(tabId) || tabId === activeTabId) ? t : undefined;
    const json = JSON.stringify({ pill, toast: shown });
    const before = pillsSent.get(tabId);
    if (!pill && !shown && !before) continue;
    if (before && before.json === json && now - before.at < 5000) continue;
    if (before?.json !== json) monitor.ownUiChanged(now); // a new pill, text or toast on screen
    if (pill || shown) pillsSent.set(tabId, { json, at: now });
    else pillsSent.delete(tabId);
    chrome.tabs.sendMessage(tabId, { type: 'status', pill, toast: shown } satisfies Msg, { frameId: 0 }).catch(() => {});
  }
}

// ---------------- mistakes, checks and cheers ----------------

const AUTO_IMAGE_KEY = 'autoCheckImage';
const pickOf = (list: string[]) => list[Date.now() % list.length];

/**
 * A mistake was found: by a reading while they wrote, by the check when they stopped, or because the homework page said "wrong".
 * The sprite says where it went off (the message has been through the leak guard and never says what the answer is), draws a box
 * on their work, and keeps the screen it checked so "Show me where" can show it. It replaces a hint that is up.
 * With `checking`, the flag and the box go up right away and the words follow (see `onEarlyRead`).
 */
async function showMistake(a: AutoCheck, jpeg: string | null, { checking = false }: { checking?: boolean } = {}): Promise<void> {
  await setRuntime({ autoCheck: a, flagged: runtime.flagged + 1, celebratedFor: null, solved: false });
  await showSprite({
    kind: 'mistake',
    title: phrases.next(a.kind === 'copy' ? 'copy' : 'mistake'),
    text: checking ? undefined : a.message,
    checking,
    mistakeKind: a.kind,
    box: a.box,
    checkId: a.id,
    canVideo: !checking,
  });
  await acknowledgeNudge(false);
  // The picture behind "Show me where" is kept after the sprite is up, so it can never hold the flag back.
  const image = jpeg ? await thumbnail(jpeg, 900).catch(() => null) : null;
  await chrome.storage.session.set({ [AUTO_IMAGE_KEY]: { id: a.id, image } });
}

/** Does a reading of the work need a message ready (a mistake to flag, or a finished answer to cheer)? Saves the extra guard call when nothing could be shown. */
function wantsMessage(id: string): boolean {
  return wantsReadMessage({
    sprite: runtime.sprite?.kind ?? null,
    now: Date.now(),
    reflagAfter: runtime.reflagAfter,
    flagMistakes: settings.flagMistakes,
    celebrate: settings.celebrate,
    celebrated: runtime.celebratedFor === id,
  });
}

/** Readings in a row that said the problem was copied wrongly (and that the copy is finished): a copy is only called out once two agree. */
let copyReads = 0;
/** What an early flag put on the sprite for the reading that is still being checked (see `onEarlyRead`). */
let early: { sessionId: string; kind: 'mistake' | 'cheer'; id: number } | null = null;

function readFacts(job: ReviewJob, status: WorkState['status'], readability: WorkState['readability'], mistakeStreak: number, copyWrong: boolean, copyStreak: number): ReadFacts {
  return {
    status,
    readability,
    mistakeStreak,
    copyWrong,
    copyStreak,
    idleMs: job.idleMs,
    sprite: runtime.sprite?.kind ?? null,
    spriteOrigin: runtime.autoCheck?.origin ?? null,
    now: Date.now(),
    reflagAfter: runtime.reflagAfter,
    flagMistakes: settings.flagMistakes,
    celebrated: runtime.celebratedFor === job.sessionId,
  };
}

/**
 * The model has just read the student's work, and the words for the student are still going through the leak guard (one more model
 * call). The flag does not wait for it: a mistake goes up on the sprite, with the red box, the moment the reading is in, and a correct
 * answer is cheered the moment it is seen. The words follow in `onRead`. (A wrongly copied problem is slower on purpose: see readPolicy.)
 */
async function onEarlyRead(job: ReviewJob, e: tutor.EarlyRead): Promise<void> {
  await ready();
  if (!following(job.sessionId) || e.differentProblem) return;
  if (e.status === 'possible_mistake' && !e.copiedWrong) {
    if (decideRead(readFacts(job, e.status, e.readability, unsureMistakeReads + 1, false, 0)) !== 'flag') return;
    const a: AutoCheck = { id: Date.now(), sessionId: job.sessionId, at: Date.now(), verdict: 'mistake', message: '', box: e.box, why: 'reading along', kind: e.kind, origin: 'read' };
    early = { sessionId: job.sessionId, kind: 'mistake', id: a.id };
    monitor.logEvent('Spotted a mistake: flagging it on the sprite now; the words follow once they have been checked.');
    await showMistake(a, job.work.jpeg, { checking: true });
    // The checked words usually follow within a couple of seconds; if the model is slow, say something rather than leave the sprite waiting.
    setTimeout(() => {
      if (runtime.sprite?.kind === 'mistake' && runtime.sprite.checking && runtime.autoCheck?.id === a.id) {
        const message = pickOf(FALLBACK_CHECK.mistake);
        void setRuntime({ autoCheck: { ...runtime.autoCheck, message } }).then(() => updateSprite('mistake', { text: message, checking: false, canVideo: true }));
      }
    }, 12_000);
  } else if (e.status === 'solved' && settings.celebrate) {
    if (decideRead(readFacts(job, e.status, e.readability, 0, false, 0)) !== 'cheer') return;
    early = { sessionId: job.sessionId, kind: 'cheer', id: Date.now() };
    await celebrate('read');
  }
}

/** A reading failed after it had put something on the sprite: say it in words that need no model. */
async function settleEarly(sessionId: string): Promise<void> {
  const e = early;
  early = null;
  if (!e || e.sessionId !== sessionId || runtime.sprite?.kind !== 'mistake' || !runtime.sprite.checking) return;
  await updateSprite('mistake', { text: pickOf(FALLBACK_CHECK.mistake), checking: false, canVideo: true });
}

/**
 * Every reading of the student's work ends here (see readPolicy for the rules). A mistake found is flagged on the sprite at once,
 * including a problem that was copied down differently from how it is written on the homework page (once they have finished writing
 * it). A finished, correct answer is cheered. A mistake that has since been fixed takes its message down.
 */
async function onRead(job: ReviewJob, r: tutor.ReadResult): Promise<void> {
  await ready();
  const mine = early && early.sessionId === job.sessionId ? early : null;
  early = null;
  const status = r.state.status;

  if (!following(job.sessionId) || r.differentProblem) {
    if (mine?.kind === 'mistake') await hideSprite('mistake');
    return;
  }

  unsureMistakeReads = status === 'possible_mistake' ? unsureMistakeReads + 1 : 0;
  copyReads = r.copiedWrong ? copyReads + 1 : 0;
  if (status === 'possible_mistake') monitor.logEvent(r.copiedWrong ? 'This reading found that the problem was copied differently.' : 'This reading found a mistake.');

  // The flag or cheer already up was this very reading's: put the checked words in, or take it back if the reading changed its mind.
  if (mine?.kind === 'mistake') {
    if (status === 'possible_mistake' && !r.copiedWrong && runtime.autoCheck?.id === mine.id) {
      const message = r.message || pickOf(FALLBACK_CHECK.mistake);
      await setRuntime({ autoCheck: { ...runtime.autoCheck, message, kind: r.kind, box: r.box ?? runtime.autoCheck.box } });
      await updateSprite('mistake', { text: message, checking: false, canVideo: true, box: r.box ?? runtime.sprite?.box ?? null, mistakeKind: r.kind });
      monitor.logEvent('Flagged a mistake on the sprite.');
      return;
    }
    await hideSprite('mistake');
    await setRuntime({ flagged: Math.max(0, runtime.flagged - 1), autoCheck: null });
  } else if (mine?.kind === 'cheer') {
    if (status === 'solved' && r.message && runtime.sprite?.kind === 'cheer') await updateSprite('cheer', { text: r.message });
    return;
  }

  const action = decideRead(readFacts(job, status, r.state.readability, unsureMistakeReads, r.copiedWrong, copyReads));
  if (action === 'flag') {
    const kind = r.copiedWrong ? 'copy' : r.kind;
    const message = r.message || pickOf(FALLBACK_CHECK[kind === 'copy' ? 'copy' : 'mistake']);
    const a: AutoCheck = { id: Date.now(), sessionId: job.sessionId, at: Date.now(), verdict: 'mistake', message, box: r.box, why: 'reading along', kind, origin: 'read' };
    monitor.logEvent(`Flagged a mistake on the sprite${kind === 'copy' ? ' (the problem was copied differently)' : ''}.`);
    await showMistake(a, job.work.jpeg);
  } else if (action === 'settle') {
    // It looks like the problem was copied wrongly, but a half-written copy always does: look again once they have stopped writing.
    monitor.logEvent('The copy of the problem differs, but you may still be writing it: I will look again when you stop.');
    monitor.requestSettledRead();
  } else if (action === 'cheer') {
    await celebrate('read', r.message);
  } else if (action === 'clear') {
    // They fixed what the sprite pointed out: take the message down.
    monitor.logEvent('The mistake that was flagged is fixed: taking the message down.');
    await hideSprite('mistake');
  }
}

/** How many problems the student has got right today (kept on this device), counting this one: the cheer says it. */
async function bumpSolvedToday(): Promise<number> {
  const day = new Date().toLocaleDateString('en-CA');
  const { solvedToday } = (await chrome.storage.local.get('solvedToday')) as { solvedToday?: { day: string; n: number } };
  const n = solvedToday?.day === day ? solvedToday.n + 1 : 1;
  await chrome.storage.local.set({ solvedToday: { day, n } });
  return n;
}

/**
 * The student got it right (the homework page said so, a reading saw the correct final answer, or the check confirmed it): the
 * sprite pops up right away to congratulate them, in different words each time, and goes away by itself. Once per problem.
 */
async function celebrate(source: 'page' | 'read' | 'check', message?: string): Promise<void> {
  await ready();
  const id = runtime.sessionActive;
  if (!id || !settings.enabled || runtime.celebratedFor === id) return;
  const solvedCheck: AutoCheck = {
    id: Date.now(),
    sessionId: id,
    at: Date.now(),
    verdict: 'correct',
    message: message ?? '',
    box: null,
    why: source === 'page' ? 'the homework page said it is correct' : source === 'check' ? 'checked when you finished' : 'reading along',
    kind: 'step',
    origin: source === 'page' ? 'page' : source === 'read' ? 'read' : 'check',
  };
  await setRuntime({ celebratedFor: id, solved: true, autoCheck: solvedCheck });
  await clearCheckOffer();
  monitor.logEvent(source === 'page' ? 'The page says your answer is correct.' : 'Your answer is correct.');
  if (!settings.celebrate) {
    toast('✓ That\'s correct. Nice work!');
    return;
  }
  const streak = await bumpSolvedToday();
  await showSprite({ kind: 'cheer', title: phrases.next('cheer'), text: message?.trim() || phrases.next('cheerLine'), streak });
  const at = runtime.spriteAt;
  setTimeout(() => {
    if (runtime.spriteAt === at) void hideSprite('cheer');
  }, CHEER_MS);
}

interface CheckInfo {
  origin: 'page' | 'check';
  /** Why myTA looked ("idle for 10 s and calm", "the page said the answer is wrong"). */
  why: string;
  /** The work screen that was checked. */
  jpeg: string | null;
  /** The student asked for this check (the sprite's offer), so even "not finished" and "couldn't read it" get an answer. */
  manual?: boolean;
}

/** What a check of the answer found, shown on the sprite. Returns what it means for the call gate. */
async function handleCheck(sessionId: string, r: WorkCheckResult, info: CheckInfo): Promise<CallOutcome> {
  // The screens show another problem than the one that was solved: nothing to tell the student about this answer.
  if (r.differentProblem) return 'different';
  const byPage = info.origin === 'page';
  // The page has the last word: if it says the answer is wrong, "it looks right" is not a verdict worth showing.
  const verdict = byPage && r.verdict === 'correct' ? 'unclear' : r.verdict;
  if (!following(sessionId)) return tutor.outcomeOfVerdict(verdict); // they moved to another problem meanwhile
  const a: AutoCheck = { id: Date.now(), sessionId, at: Date.now(), verdict, message: r.message, box: r.box, why: info.why, kind: r.kind ?? 'step', origin: info.origin };
  if (verdict === 'mistake') {
    await showMistake(a, info.jpeg);
  } else if (verdict === 'correct') {
    await celebrate('check', r.message);
  } else {
    await setRuntime({ autoCheck: a });
    if (info.manual) {
      await showSprite({ kind: 'stuck', title: phrases.next('hint'), text: r.message, canVideo: true });
    } else if (verdict === 'unclear' && !byPage) {
      toast('I couldn\'t read enough of your work to check it. Try writing a little larger, or use "Set my work tab" in myTA.');
    } else if (verdict === 'incomplete' && !byPage && settings.autoHint && !runtime.sprite) {
      // They stopped partway: what is written is fine so far, but it isn't finished. That is the moment a nudge helps, so the sprite
      // offers one (read from their work, never the answer) instead of staying silent.
      void helpNudge(['you stopped before the problem was finished']);
    }
  }
  return tutor.outcomeOfVerdict(verdict);
}

/**
 * myTA took a snapshot and now checks the answer against its private key, because the student stopped writing and looks calm,
 * or because the homework page just said the answer is wrong. A mistake brings the sprite up at once with where it went off
 * track; a correct answer is cheered.
 */
async function finishCheck(job: ReviewJob, shots: tutor.WorkShots): Promise<CallOutcome> {
  const byPage = job.reason === 'wrong-answer';
  const why = byPage
    ? 'the homework page just said the student\'s answer is wrong: find where their work or the answer they entered goes off track'
    : `the student stopped working (${job.detail}), so they are probably finished`;
  const r = await tutor.checkWork(llmCtx(), job.sessionId, shots, why);
  return handleCheck(job.sessionId, r, { origin: byPage ? 'page' : 'check', why: job.detail, jpeg: job.work.jpeg });
}

// ---- "check your work?" when the student moves on ----

let offering = false;
let checkingNow = false;

/**
 * The student looks done with this problem (clicked Next, switched question, or navigated away): hold the
 * frame of their finished work and offer, on the sprite, to check it.
 * `fresh` grabs a screenshot right now, which is only possible while the old page is still showing.
 */
async function offerWorkCheck(tabId: number, fresh: boolean): Promise<void> {
  await ready();
  const id = runtime.sessionActive;
  if (offering || !id || tabId !== runtime.sessionTabId || runtime.offeredFor === id || runtime.checkOffer) return;
  if (Date.now() - (runtime.sessionStartedAt ?? 0) < MIN_SESSION_BEFORE_CHECK_MS) return;
  if (monitor.checkedSinceLastWork()) return; // myTA already checked this answer when the student stopped, and they haven't written more
  if (runtime.celebratedFor === id) return; // they got it right: nothing to check
  if (runtime.sprite) return; // the sprite is already saying something (a hint, where a mistake is): don't cover it, and don't hold the next problem up for an offer nobody sees
  offering = true;
  try {
    if ((await getWork(id)).status === 'no_work') return; // nothing on screen to check
    if (!(await monitor.freeze(fresh))) return;
    await setRuntime({ offeredFor: id, checkOffer: { tabId, sessionId: id, at: Date.now() } });
    await pushCheckOffer();
  } finally {
    offering = false;
  }
}

async function pushCheckOffer(): Promise<void> {
  if (!runtime.checkOffer || runtime.sprite) return; // something more useful is already up
  await showSprite({ kind: 'check-work', title: phrases.next('checkOffer') });
}

async function clearCheckOffer(): Promise<void> {
  const o = runtime.checkOffer;
  monitor.unfreeze();
  if (!o) return;
  await setRuntime({ checkOffer: null });
  await hideSprite('check-work');
}

/** "Check my work" on the sprite's offer: check the frozen screen, and say what it found on the sprite. */
async function checkNow(): Promise<void> {
  await ready();
  const id = runtime.sessionActive;
  if (!id || checkingNow) return;
  checkingNow = true;
  try {
    const moved = monitor.isFrozen; // the page has moved on, so its text isn't the work's context
    await showSprite({ kind: 'stuck', title: phrases.next('checking'), pending: true });
    const f = await monitor.finalFrames();
    if (!f) {
      await hideSprite('stuck');
      toast('I couldn\'t see your work just now. Switch to the tab you were working in and try again.');
      return;
    }
    const problemContext = moved ? null : await pageContext(runtime.sessionTabId);
    const workContext = !moved && f.problem ? await pageContext(f.work.tabId) : null;
    const r = await tutor.checkWork(llmCtx(), id, { work: f.work.jpeg, problem: f.problem?.jpeg ?? null, problemContext, workContext });
    monitor.noteCheck(); // the student asked: myTA won't check this same work again by itself
    await handleCheck(id, r, { origin: 'check', why: 'you asked', jpeg: f.work.jpeg, manual: true });
  } catch (e) {
    await hideSprite('stuck');
    toast(`I couldn't check that: ${friendly(e)}`);
  } finally {
    checkingNow = false;
    // Whatever the check ended in, "checking…" does not stay up (a result replaces it; a check with nothing to show takes it down).
    if (runtime.sprite?.kind === 'stuck' && runtime.sprite.pending) await hideSprite('stuck');
    await clearCheckOffer();
    // Moving on to the next problem waits a few seconds, so what the check found is on screen first.
    void sleep(6000).then(() => refollowIfPageChanged('the check is done', 10_000));
  }
}

const withoutHash = (url: string) => url.split('#')[0];

// ---------------- messages ----------------

function keyHealth(check: KeyCheck | undefined, key: string): KeyHealth {
  if (!key) return { state: 'bad', detail: 'No key entered.' };
  if (!check || check.fingerprint !== fingerprint(key)) return { state: 'untested', detail: 'Not tested yet. Open setup and press "Test keys".' };
  return { state: check.ok ? 'ok' : 'bad', detail: check.detail };
}

const hostOf = (url: string | null): string | null => {
  try {
    return url ? new URL(url).hostname.replace(/^www\./, '') : null;
  } catch {
    return null;
  }
};

/** Does myTA know which problem the student is on, and is it following it? In words the panel can show. */
function trackingState(now: number, work: WorkState | null): TrackingState {
  const needSec = Math.round(AUTO_START_DWELL_MS / 1000);
  const cand = tracker.candidate({ now, focusedTabId: activeTabId });
  const base: TrackingState = { mode: 'looking', label: null, host: null, since: null, noticedSec: null, needSec, note: null };
  const starting = runtime.start?.status === 'starting' && now - runtime.start.at < 90_000;
  if (runtime.sessionActive && !starting) {
    return {
      ...base,
      mode: 'following',
      label: runtime.sessionLabel,
      host: hostOf(runtime.sessionUrl),
      since: runtime.sessionStartedAt,
      note: work?.status === 'different_problem' ? 'You seem to be on a different problem now.' : null,
    };
  }
  if (starting) return { ...base, mode: 'starting', label: cand ? labelOf(cand.key) || null : null };
  if (!settings.autoTrack) return { ...base, mode: 'off', note: 'Automatic tracking is off in settings. Use "Follow this page" in the panel.' };
  if (!settings.enabled) return { ...base, mode: 'off', note: 'myTA is paused.' };
  if (settings.snoozedUntil > now) return { ...base, mode: 'off', note: 'Snoozed.' };
  const why = cand ? tracker.rejectedWhy(cand.key, now) : null;
  if (why === 'several') return { ...base, mode: 'pick-one' };
  if (why) return { ...base, mode: 'not-a-problem' };
  if (cand && cand.forMs >= 1000) return { ...base, mode: 'noticed', noticedSec: Math.floor(cand.forMs / 1000) };
  return base;
}

async function panelState(): Promise<PanelState> {
  await ready();
  void pumpMonitor();
  void trackProblem();
  const { ready: setUp, missing } = readiness(settings);
  const { engine, trigger } = await store.load();
  const sessionId = runtime.sessionActive;
  const work = sessionId ? await getWork(sessionId) : null;
  const { [KEY_STATUS_STORAGE]: keyStatus } = (await chrome.storage.local.get(KEY_STATUS_STORAGE)) as { [KEY_STATUS_STORAGE]?: KeyStatus };
  await callsReady;
  const m = await monitor.stats();
  const now = Date.now();
  const cfg = triggerConfig(settings, runtime.sessionTraits);
  const base = triggerConfig(settings);
  const prog = triggerProgress(trigger, now);
  const fin = finishConfig(settings, runtime.sessionTraits);
  const triggerView: TriggerView = {
    threshold: cfg.threshold,
    durationSec: cfg.durationSec,
    baseSec: base.durationSec,
    difficulty: runtime.sessionActive ? (runtime.sessionTraits?.difficulty ?? null) : null,
    tuning: runtime.sessionActive ? tuningNote(settings, runtime.sessionTraits) : '',
    extraSec: cfg.durationSec - base.durationSec,
    aboveSec: prog.aboveSec,
    cooldownLeftSec: prog.cooldownLeftSec,
    paused: !settings.enabled ? 'off' : settings.snoozedUntil > now ? 'snoozed' : !cameraOk() ? 'no-camera' : null,
  };
  const finishView: FinishView = {
    enabled: !!fin,
    idleSec: Math.round((fin?.idleMs ?? settings.finishIdleSec * 1000) / 1000),
    calmBelow: fin?.calmBelow ?? 0,
    hasWork: !!m.gate?.finishWork,
    idleForSec: m.gate?.idleSec ?? null,
  };
  const a = runtime.autoCheck;
  const sp = runtime.sprite;
  return {
    ready: setUp,
    missing,
    enabled: settings.enabled,
    cameraOk: cameraOk(),
    cameraError,
    phase: trigger.phase,
    output: lastOutput,
    timeline: engine.timeline,
    devMode: settings.devMode,
    labelMode: settings.labelMode,
    sessionId,
    start: runtime.start,
    watch: {
      active: !!sessionId,
      status: work?.status ?? 'unknown',
      lastCaptureAt: monitor.lastCaptureAt,
      lastReviewAt: work?.reviewedAt || null,
      intervalSec: snapshotMs(settings) / 1000,
      note: monitor.note,
      read: work?.read ?? '',
      readability: work?.readability ?? null,
    },
    tracking: trackingState(now, work),
    trigger: triggerView,
    finish: finishView,
    autoCheck: a ? { id: a.id, sessionId: a.sessionId, verdict: a.verdict, kind: a.kind, origin: a.origin, at: a.at } : null,
    autoHint: runtime.autoHint,
    sprite: sp ? { kind: sp.kind, title: sp.title, text: sp.text ?? '', at: runtime.spriteAt } : null,
    flagged: runtime.flagged,
    celebrated: !!sessionId && runtime.celebratedFor === sessionId,
    reviewSec: reviewMs(settings) === null ? null : Math.round(reviewMs(settings)! / 1000),
    keys: { gemini: keyHealth(keyStatus?.gemini, settings.geminiKey), serp: keyHealth(keyStatus?.serp, settings.serpKey) },
    eyes: {
      captures: m.captures,
      storedFrames: m.storedFrames,
      storedBytes: m.storedBytes,
      tabs: m.tabs,
      workTabId: runtime.workTabId,
      workPinned: runtime.workPinned,
      intervalSec: snapshotMs(settings) / 1000,
      reviews: m.reviews,
      calls: { ...calls, byKind: { ...calls.byKind } },
      gate: m.gate,
      last: m.last,
      log: m.log,
    },
  };
}

function handle(msg: Msg, sender: chrome.runtime.MessageSender): Promise<unknown> | undefined {
  switch (msg.type) {
    case 'page-signals': {
      const tabId = sender.tab?.id;
      if (tabId === undefined) return;
      const top = (sender.frameId ?? 0) === 0;
      if (!frames.has(tabId)) frames.set(tabId, new Map());
      frames.get(tabId)!.set(sender.frameId ?? 0, { signals: msg.signals, at: Date.now() });
      if (msg.signals.stats) monitor.noteDom(tabId, sender.frameId ?? 0, msg.signals.stats);
      if (top && msg.signals.role) monitor.noteRole(tabId, msg.signals.role);
      if (activeTabId === null && sender.tab?.active) activeTabId = tabId;
      if (welcomePending && tabId === activeTabId) void maybeWelcome();
      if (tabId === activeTabId) void tick();
      if (top) tracker.observe(tabId, problemKey(sender.tab?.url, msg.signals.questionLabel), Date.now());
      void pumpMonitor();
      void trackProblem();
      // The sprite survives a page load: re-show it once the new page's content script is up.
      if (top && runtime.sprite && tabId === runtime.spriteTab && Date.now() - lastSpritePushAt > 2500) {
        lastSpritePushAt = Date.now();
        void sendNudge(tabId, { type: 'nudge', show: true, kind: runtime.sprite.kind, content: runtime.sprite });
      }
      return;
    }
    case 'face-reading':
      face = {
        reading: {
          facePresent: msg.facePresent,
          gazeAway: msg.gazeAway,
          signals: msg.raw && settings?.calibration ? toSignals(msg.raw, settings.calibration) : [],
        },
        at: Date.now(),
      };
      cameraError = null;
      void tick();
      return;
    case 'camera-status':
      cameraError = msg.ok ? null : msg.error;
      if (!msg.ok) face = null;
      void updateBadge();
      return;
    case 'nudge-dismissed':
      return (async () => {
        await ready();
        if (msg.kind === 'check-work') {
          await clearCheckOffer();
          void refollowIfPageChanged('you skipped the check', 10_000);
        } else if (msg.kind === 'mistake') {
          // They've seen it: the same kind of flag waits a while rather than nagging while they work on the fix.
          await setRuntime({ reflagAfter: Date.now() + REFLAG_AFTER_DISMISS_MS });
          await hideSprite('mistake');
        } else if (msg.kind === 'cheer') {
          await hideSprite('cheer');
        } else if (msg.kind === 'hello') {
          await hideSprite('hello');
        } else {
          await hideSprite('stuck');
          await acknowledgeNudge(msg.snooze);
        }
      })();
    case 'hint-request':
      // "Another hint" on the sprite: read the work again and go one level deeper.
      void helpNudge(lastOutput.topContributors, true);
      return;
    case 'video-request':
      void offerVideo();
      return;
    case 'open-video':
      void openVideo(msg.videoId, msg.start);
      return;
    case 'check-now':
      void checkNow();
      return;
    case 'move-on': {
      const tabId = sender.tab?.id;
      if (tabId !== undefined) {
        void (async () => {
          await offerWorkCheck(tabId, true);
          // "Next question" on a site that keeps the same address: once the page has had a moment to change, follow the new problem
          // (unless the "check your work?" offer is up, which needs the old one; it is retried when the offer is answered).
          if (tabId === runtime.sessionTabId) {
            await sleep(2500);
            await refollowIfPageChanged('you moved on', 10_000);
          }
        })();
      }
      return;
    }
    case 'get-state':
      return panelState();
    case 'force-trigger':
      return (async () => {
        if (!settings.devMode) return;
        const p = await store.load();
        await store.save({ ...p, trigger: forceConfused(p.trigger, Date.now()) });
        await setRuntime({ lastFiredAt: Date.now() });
        await helpNudge(lastOutput.topContributors.length ? lastOutput.topContributors : ['(forced by dev mode)']);
      })();
    case 'start-session':
      return beginSession({ force: true });
    case 'pin-work-tab':
      return (async () => {
        await runtimeReady;
        if (!runtime.sessionActive) return { error: 'Open a problem first, so myTA is following one.' };
        const tab = await activeTab();
        if (!capturable(tab)) return { error: 'Switch to the tab where you write your work, then press this again.' };
        if (tab.id === runtime.sessionTabId) return { error: 'That is the problem tab. Switch to the tab where you write your work, then press this again.' };
        await setRuntime({ workTabId: tab.id, workPinned: true });
        await relocateSprite();
        return { ok: true as const, host: new URL(tab.url).hostname.replace(/^www\./, '') };
      })();
    case 'unpin-work-tab':
      return setRuntime({ workTabId: null, workPinned: false });
    case 'clear-snapshots':
      sentShots = [];
      void chrome.storage.session.remove(SENT_KEY);
      return monitor.clear();
    case 'get-sent':
      return sentReady.then(() => sentShots);
    case 'get-auto-check':
      return (async () => {
        await runtimeReady;
        const a = runtime.autoCheck;
        if (!a || a.id !== msg.id) return null;
        const { [AUTO_IMAGE_KEY]: img } = (await chrome.storage.session.get(AUTO_IMAGE_KEY)) as { [AUTO_IMAGE_KEY]?: { id: number; image: string | null } };
        return { ...a, image: img?.id === a.id ? img.image : null };
      })();
    case 'get-stats':
      return getStats();
    case 'restart-camera':
      return closeOffscreen().then(ensureOffscreen);
    case 'say-hello':
      void sayHello();
      return;
    case 'export-label-log':
      return logger.export();
    case 'export-video-cache':
      return tutor.exportVideoCache();
    default:
      return;
  }
}

chrome.runtime.onMessage.addListener((msg: Msg, sender, reply) => {
  if (msg.type === 'open-panel') {
    // sidePanel.open must run synchronously inside the click's user gesture.
    const tabId = sender.tab?.id;
    if (tabId === undefined) return false;
    chrome.sidePanel
      .open({ tabId })
      .then(() => reply(true))
      .catch(() => reply(false));
    return true;
  }
  const p = handle(msg, sender);
  if (!p) return false;
  p.then(reply, (e) => reply({ error: friendly(e) }));
  return true;
});

// ---------------- lifecycle ----------------

chrome.tabs.onActivated.addListener(({ tabId }) => {
  activeTabId = tabId;
  void maybeWelcome();
});
chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  if (tab?.id) activeTabId = tab.id;
});
chrome.tabs.onRemoved.addListener(async (tabId) => {
  frames.delete(tabId);
  monitor.forgetTab(tabId);
  tracker.forget(tabId);
  pillsSent.delete(tabId);
  await runtimeReady;
  if (tabId === runtime.spriteTab) await setRuntime({ sprite: null, spriteTab: null });
  if (tabId === runtime.workTabId) {
    await setRuntime({ workTabId: null, workPinned: false });
  }
  // The problem's own tab was closed: nothing left to follow.
  const id = runtime.sessionActive;
  if (id && tabId === runtime.sessionTabId && !runtime.checkOffer) {
    await retire(id);
    await clearSession(false);
  }
});

// Navigating the session's tab to a different page (full load or single-page-app route) means they moved on.
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (!info.url) return;
  await runtimeReady;
  if (tabId !== runtime.sessionTabId || !runtime.sessionUrl || withoutHash(info.url) === withoutHash(runtime.sessionUrl)) return;
  void offerWorkCheck(tabId, false);
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'label-stuck') return;
  await settingsReady;
  if (!settings.labelMode) return;
  await logger.label();
  await chrome.action.setBadgeText({ text: 'L' });
  setTimeout(() => void updateBadge(), 800);
});

onSettingsChanged(async (s) => {
  const wasReady = !!settings && readiness(settings).ready;
  const wasEnabled = settings?.enabled;
  const wasSnoozed = (settings?.snoozedUntil ?? 0) > Date.now();
  if (settings && settings.geminiKey !== s.geminiKey) resetLearned(); // what was learned about the API belonged to the other key
  if (settings && (settings.geminiKey !== s.geminiKey || settings.model !== s.model || settings.solverModel !== s.solverModel)) monitor.retryNow(); // a fixed key shouldn't wait out a pause
  settings = s;
  await ensureOffscreen();
  // Setup just became complete: say hello, once, so they see that myTA is up and what it looks like (on the first ordinary web page they are on).
  if (!wasReady && readiness(s).ready) {
    const { welcomed } = (await chrome.storage.local.get('welcomed')) as { welcomed?: boolean };
    if (!welcomed) {
      welcomePending = true;
      void maybeWelcome();
    }
  }
  // Turning myTA off or snoozing it means "stop watching": forget every stored snapshot.
  if ((wasEnabled && !s.enabled) || (!wasSnoozed && s.snoozedUntil > Date.now())) await monitor.clear();
  if (wasEnabled && !s.enabled) await hideSprite();
  await updateBadge();
});

async function boot() {
  await settingsReady;
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  activeTabId = tab?.id ?? null;
  await ensureOffscreen();
  await updateBadge();
  const { welcomed } = (await chrome.storage.local.get('welcomed')) as { welcomed?: boolean };
  welcomePending = !welcomed && readiness(settings).ready;
  void maybeWelcome();
}

/**
 * Content scripts only load into pages opened after the extension was installed or reloaded, and a reload
 * orphans the ones already running. Without this, every open tab stays dead (no page signals, so the score
 * is face-only, and no sprite) until the student refreshes it. Injecting here makes tabs work straight away.
 */
async function injectIntoOpenTabs(): Promise<void> {
  const files = (chrome.runtime.getManifest().content_scripts ?? []).flatMap((c) => c.js ?? []);
  if (!files.length) return;
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  await Promise.all(
    tabs
      .filter((t) => t.id !== undefined && !t.discarded)
      .map((t) => chrome.scripting.executeScript({ target: { tabId: t.id!, allFrames: true }, files }).catch(() => {})),
  );
}

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === 'install') await chrome.runtime.openOptionsPage();
  if (reason === 'install' || reason === 'update') await injectIntoOpenTabs();
});

startTabTracker();
void boot();
setInterval(() => void updateBadge(), 5000);
// Keeps snapshots flowing on pages without a content script (Chrome's PDF viewer); the monitor paces itself.
setInterval(() => void pumpMonitor(), 1000);
setInterval(() => void trackProblem(), 1000);
