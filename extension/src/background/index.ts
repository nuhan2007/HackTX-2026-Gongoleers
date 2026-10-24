// Service worker: routes messages, runs the engine tick, manages the offscreen camera doc.
// All long-lived state is in chrome.storage so an MV3 shutdown loses nothing important.
import { GeminiError } from '../ai/geminiClient';
import { FACE_STALE_MS, GEMINI_CALLS_PER_MIN, PAGE_STALE_MS } from '../shared/constants';
import { toSignals } from '../shared/faceSignals';
import type { Msg, PanelState } from '../shared/messages';
import { getSettings, onSettingsChanged, readiness, triggerConfig, updateSettings, type Settings } from '../shared/settings';
import type { EngineOutput, FaceReading, PageSignals, Signal } from '../shared/types';
import { step } from './confusionEngine';
import { EngineStore } from './engineStore';
import { LabelLogger } from './labelLogger';
import { getStats } from './metrics';
import { RateLimiter, RateLimitError } from './rateLimiter';
import { startTabTracker, tabSignals } from './tabTracker';
import { enterCooldown, forceConfused, stepTrigger } from './triggerMachine';
import * as tutor from './tutorService';
import { SerpError } from '../serp/youtube';

const OFFSCREEN_URL = 'src/offscreen/offscreen.html';
const SNOOZE_MS = 15 * 60_000;
const TRIGGER_MEMORY_MS = 10 * 60_000;

const store = new EngineStore(chrome.storage.session);
const logger = new LabelLogger();
const limiter = new RateLimiter(GEMINI_CALLS_PER_MIN);

let settings: Settings;
const settingsReady = getSettings().then((s) => (settings = s));

/** Latest signals per tab → frame. Only the active tab's frames feed the engine. */
const frames = new Map<number, Map<number, { signals: PageSignals; at: number }>>();
let face: { reading: FaceReading; at: number } | null = null;
let cameraError: string | null = null;
let activeTabId: number | null = null;
let lastOutput: EngineOutput = { score: 0, channels: { content: 0, activity: 0, face: 0 }, topContributors: [] };
let lastTickAt = 0;
let ticking = false;
// Starts at boot so a freshly woken worker waits for the existing camera doc to report in.
let lastOffscreenAttempt = Date.now();

// Small runtime flags that must survive restarts.
interface Runtime {
  lastFiredAt: number | null;
  sessionActive: string | null;
}
const RUNTIME_KEY = 'runtime';
let runtime: Runtime = { lastFiredAt: null, sessionActive: null };
const runtimeReady = chrome.storage.session.get(RUNTIME_KEY).then((r) => {
  if (r[RUNTIME_KEY]) runtime = r[RUNTIME_KEY] as Runtime;
});
async function setRuntime(patch: Partial<Runtime>) {
  runtime = { ...runtime, ...patch };
  await chrome.storage.session.set({ [RUNTIME_KEY]: runtime });
}

const cameraOk = () => !!face && Date.now() - face.at < FACE_STALE_MS * 2;
const geminiCtx = () => ({ apiKey: settings.geminiKey, model: settings.model, limiter });

// ---------------- offscreen camera ----------------

async function hasOffscreen(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] });
  return contexts.length > 0;
}

async function ensureOffscreen(): Promise<void> {
  const { ready } = readiness(settings);
  if (!ready || !settings.enabled) return closeOffscreen();
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
  const { ready } = readiness(settings);
  const [text, color, title] = !settings.enabled
    ? ['off', '#636e72', 'Gongo is off']
    : !ready
      ? ['!', '#e17055', 'Gongo: finish setup on the options page']
      : cameraOk()
        ? ['●', '#d63031', 'Gongo: camera on (processed on-device only)']
        : ['cam', '#e17055', `Gongo: camera unavailable${cameraError ? ` (${cameraError})` : ''}`];
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setTitle({ title });
}

// ---------------- engine tick ----------------

function mergedPage(tabId: number | null, now: number): PageSignals | null {
  const byFrame = tabId === null ? undefined : frames.get(tabId);
  if (!byFrame) return null;
  const fresh = [...byFrame.values()].filter((f) => now - f.at < PAGE_STALE_MS).map((f) => f.signals);
  if (!fresh.length) return null;
  // Strongest signal of each kind across frames; most recent input wins for the timers.
  const strongest = (lists: Signal[][]) => {
    const best = new Map<string, Signal>();
    for (const s of lists.flat()) if (!best.has(s.id) || best.get(s.id)!.value < s.value) best.set(s.id, s);
    return [...best.values()];
  };
  const withContent = fresh.find((f) => f.content.length) ?? fresh[0];
  return {
    content: strongest(fresh.map((f) => f.content)),
    activity: strongest(fresh.map((f) => f.activity)),
    idleMs: Math.min(...fresh.map((f) => f.idleMs)),
    dwellMs: Math.min(...fresh.map((f) => f.dwellMs)),
    questionLabel: withContent.questionLabel,
  };
}

async function showNudge(show: boolean, reasons: string[] = []) {
  if (activeTabId === null) return;
  chrome.tabs.sendMessage(activeTabId, { type: 'nudge', show, reasons } satisfies Msg, { frameId: 0 }).catch(() => {});
}

async function tick(): Promise<void> {
  const now = Date.now();
  if (ticking || now - lastTickAt < 900) return;
  ticking = true;
  lastTickAt = now;
  try {
    await Promise.all([settingsReady, runtimeReady]);
    const { ready } = readiness(settings);
    if (!ready || !settings.enabled) return;
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
    const page = mergedPage(activeTabId, now);
    const { state: engine, output } = step(persisted.engine, {
      now,
      page,
      tab: tabSignals(now),
      face: face && now - face.at < FACE_STALE_MS ? face.reading : null,
    });
    const prevPhase = persisted.trigger.phase;
    const { state: trigger, fired } = stepTrigger(persisted.trigger, output.score, now, triggerConfig(settings), {
      enabled: !runtime.sessionActive,
      snoozedUntil: settings.snoozedUntil,
    });
    await store.save({ engine, trigger });
    lastOutput = output;

    if (fired) {
      await setRuntime({ lastFiredAt: now });
      await showNudge(true, output.topContributors);
    } else if (prevPhase === 'confused' && trigger.phase !== 'confused') {
      await showNudge(false);
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
  await store.save({ ...persisted, trigger: enterCooldown(persisted.trigger, Date.now(), triggerConfig(settings)) });
  if (snooze) await updateSettings({ snoozedUntil: Date.now() + SNOOZE_MS });
}

// ---------------- messages ----------------

function friendly(e: unknown): string {
  if (e instanceof GeminiError || e instanceof SerpError || e instanceof RateLimitError) return e.message;
  if (e instanceof Error) return e.message;
  return 'Something went wrong.';
}

async function panelState(): Promise<PanelState> {
  await Promise.all([settingsReady, runtimeReady]);
  const { ready, missing } = readiness(settings);
  const { engine, trigger } = await store.load();
  const recentTrigger = runtime.lastFiredAt && Date.now() - runtime.lastFiredAt < TRIGGER_MEMORY_MS ? runtime.lastFiredAt : null;
  return {
    ready,
    missing,
    enabled: settings.enabled,
    cameraOk: cameraOk(),
    cameraError,
    phase: trigger.phase,
    output: lastOutput,
    timeline: engine.timeline,
    devMode: settings.devMode,
    labelMode: settings.labelMode,
    triggeredAt: recentTrigger,
  };
}

function handle(msg: Msg, sender: chrome.runtime.MessageSender): Promise<unknown> | undefined {
  switch (msg.type) {
    case 'page-signals': {
      const tabId = sender.tab?.id;
      if (tabId === undefined) return;
      if (!frames.has(tabId)) frames.set(tabId, new Map());
      frames.get(tabId)!.set(sender.frameId ?? 0, { signals: msg.signals, at: Date.now() });
      if (activeTabId === null && sender.tab?.active) activeTabId = tabId;
      if (tabId === activeTabId) void tick();
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
      return acknowledgeNudge(msg.snooze);
    case 'get-state':
      return panelState();
    case 'force-trigger':
      return (async () => {
        if (!settings.devMode) return;
        const p = await store.load();
        await store.save({ ...p, trigger: forceConfused(p.trigger, Date.now()) });
        await setRuntime({ lastFiredAt: Date.now() });
        await showNudge(true, lastOutput.topContributors.length ? lastOutput.topContributors : ['(forced by dev mode)']);
      })();
    case 'capture-tab':
      return chrome.tabs
        .captureVisibleTab({ format: 'jpeg', quality: 90 })
        .then((dataUrl) => ({ image: dataUrl }))
        .catch((e) => ({ error: `Couldn't capture this tab: ${friendly(e)}` }));
    case 'page-context':
      return (async () => {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (!tab?.id) return null;
        return chrome.tabs.sendMessage(tab.id, { type: 'get-page-context' } satisfies Msg, { frameId: 0 }).catch(() => null);
      })();
    case 'start-session':
      return (async () => {
        await settingsReady;
        const r = await tutor.startSession(geminiCtx(), msg.image, msg.context, runtime.lastFiredAt && Date.now() - runtime.lastFiredAt < TRIGGER_MEMORY_MS ? runtime.lastFiredAt : null);
        if (r.sessionId) await setRuntime({ sessionActive: r.sessionId, lastFiredAt: null });
        await showNudge(false);
        return r;
      })();
    case 'tutor-turn':
      return tutor.tutorTurn(geminiCtx(), msg.sessionId, msg.action, msg.text);
    case 'check-understanding':
      return tutor.checkUnderstanding(geminiCtx(), msg.sessionId, msg.text);
    case 'find-video':
      return tutor.findVideo(geminiCtx(), settings.serpKey, msg.sessionId);
    case 'end-session':
      return (async () => {
        const summary = await tutor.endSession(msg.sessionId, msg.solved);
        await setRuntime({ sessionActive: null });
        await acknowledgeNudge(false);
        return summary;
      })();
    case 'get-stats':
      return getStats();
    case 'restart-camera':
      return closeOffscreen().then(ensureOffscreen);
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
    void acknowledgeNudge(false);
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
});
chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  if (tab?.id) activeTabId = tab.id;
});
chrome.tabs.onRemoved.addListener((tabId) => frames.delete(tabId));

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'label-stuck') return;
  await settingsReady;
  if (!settings.labelMode) return;
  await logger.label();
  await chrome.action.setBadgeText({ text: 'L' });
  setTimeout(() => void updateBadge(), 800);
});

onSettingsChanged(async (s) => {
  const wasEnabled = settings?.enabled;
  settings = s;
  await ensureOffscreen();
  if (wasEnabled && !s.enabled) await showNudge(false);
  await updateBadge();
});

async function boot() {
  await settingsReady;
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  activeTabId = tab?.id ?? null;
  await ensureOffscreen();
  await updateBadge();
}

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === 'install') await chrome.runtime.openOptionsPage();
});

startTabTracker();
void boot();
setInterval(() => void updateBadge(), 5000);
