// The eyes of the extension. Every few seconds it captures the tabs that matter and keeps the snapshots
// on this device (frameStore). It watches two tabs: the PROBLEM tab (where the session started) and the
// WORK tab (where the student writes their solution), which it finds by who is typing and which the
// student can pin by hand. Taking snapshots costs nothing; the call gate decides when one is worth a
// model call, from the confusion score, time on the problem, wrong answers on the homework page, and
// how much new work has appeared on screen.
import { LlmError } from '../ai/llmClient';
import { REVIEW_BACKOFF_MS } from '../shared/constants';
import { CallGate, DEFAULT_GATE, type CallOutcome, type CallReason, type GateConfig, type GateState } from './callGate';
import { changedFraction, isChange, type Gray } from './frameDiff';
import { activeTab, captureTab, capturable, type Frame } from './frames';
import type { FrameStore, StoreStats } from './frameStore';
import type { LogLine, TabView } from '../shared/messages';
import { RateLimitError } from './rateLimiter';
import { POINTER_WEIGHT, TabRoles } from './tabRoles';
import type { RoleHints } from '../shared/pageRole';

/** Running totals each content script reports; the monitor works with their differences. */
export interface DomStats {
  incorrectTotal: number;
  /** Times the page newly said an answer was correct. */
  correctTotal?: number;
  submitTotal: number;
  keyTotal: number;
  pointerTotal: number;
  scrollY: number;
}

export interface MonitorSession {
  id: string;
  problemTabId: number;
  workTabId: number | null;
  /** A pin from the panel: auto-detection leaves it alone. */
  workPinned: boolean;
  startedAt: number;
}

export interface ReviewJob {
  sessionId: string;
  reason: CallReason;
  detail: string;
  /** The tab where the student's work is (the problem tab itself when they work on the problem page). */
  work: Frame;
  /**
   * The problem tab's screenshot, when the work is in a different tab AND the problem tab changed since the model last saw it
   * (a read every few seconds doesn't re-send an unchanged problem page).
   */
  problem: Frame | null;
  /** The work is in a different tab from the problem. When `problem` is null in that case, the model has already seen it. */
  separate: boolean;
  /** How long the student had been still when the snapshot was taken (null before they have written anything). */
  idleMs: number | null;
}

export interface MonitorDeps {
  store: FrameStore;
  intervalMs(): number;
  /** May the monitor capture while no session runs? (myTA on and set up, and not snoozed.) */
  active(): boolean;
  session(): MonitorSession | null;
  /** The latest confusion score, or null when there is no fresh one. */
  score(): number | null;
  /** When to count the student as finished (idle this long with the score this low), or null with automatic checking off. */
  finish?(): { idleMs: number; calmBelow: number } | null;
  /** How often to read the student's work while they write, or null with continuous reading off. */
  progress?(): { everyMs: number } | null;
  /** Per-problem changes to the call gate's numbers (when the first "a while on this problem" look comes), once a session starts. */
  gateConfig?(): Partial<GateConfig>;
  hasHeadroom(): boolean;
  /** Makes the model call and says what it found. */
  review(job: ReviewJob): Promise<CallOutcome>;
  /** Every finished look, for the background to act on (for example, the screens showing a different problem). */
  onOutcome?(outcome: CallOutcome, job: ReviewJob): void;
  /** The homework page itself said the answer is correct. */
  onSolvedByPage?(): void;
  /** The auto-detected work tab changed. */
  onWorkTab(tabId: number | null): void;
}

/** What the monitor itself knows; the background adds the call counters before sending it to the panel. */
export interface MonitorStats {
  captures: number;
  storedFrames: number;
  storedBytes: number;
  reviews: number;
  tabs: TabView[];
  gate: GateState | null;
  note: string | null;
  last: { at: number; reason: CallReason; detail: string; outcome: CallOutcome | 'running' } | null;
  log: LogLine[];
}

/** Even an unchanged screen is stored this often, so a long pause still leaves a recent frame. */
const KEEPALIVE_MS = 30_000;
/** A change this large is a page load or a scroll, not the student writing. */
const NOT_WORK = 0.6;
const LOG_MAX = 40;
/** How often the call gate is consulted while a session runs. */
const DECIDE_MS = 200;
/** Once the student has been still this long after writing, the work tab is captured, so the picture is ready when the line settles. */
const PRECAPTURE_IDLE_MS = 450;

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url.slice(0, 40);
  }
};

export class Monitor {
  /** Latest frame (and its gray image) per tab, in memory; the store has the history. */
  private latest = new Map<number, { frame: Frame; gray: Gray }>();
  private lastStoredAt = new Map<number, number>();
  private dom = new Map<number, DomStats>();
  /** Each tab's typing + drawing total as of the last tick, to turn the running total into "input since then". */
  private inputAtTick = new Map<number, number>();
  private domFrames = new Map<number, Map<number, DomStats>>();
  private scrolledAt = new Map<number, number>();
  private roles = new TabRoles();
  private gate: CallGate | null = null;
  private gateFor: string | null = null;
  private frozen: { work: Frame; problem: Frame | null } | null = null;
  /** The gray image of each tab as the model last saw it, so an unchanged screen isn't attached again. */
  private attached = new Map<number, Gray>();
  private attachedFor: string | null = null;

  private pendingIncorrect = 0;
  private pendingCorrect = 0;
  private ticking = false;
  /** When the tabs were last captured, and when the call gate was last consulted. */
  private lastTickAt = 0;
  private lastDecideAt = 0;
  private pausedUntil = 0;
  private suspendedUntil = 0;
  private ownUiUntil = 0;
  /** The `lastWriteAt` the work tab was last captured for early, so one line is captured once. */
  private preCapturedFor = 0;
  private wakeTimer: number | undefined;
  /** Wake-ups in a row that did not lead to a look. */
  private wakeMisses = 0;
  /** The clock the last pump ran on, and when (real time) it did, so a timer can carry on from it (a test runs on a made-up clock). */
  private pumpedAt: { now: number; real: number } | null = null;
  private captures = 0;
  private reviews = 0;
  /** When the model last finished reading the student's work. */
  lookedAt: number | null = null;
  private last: MonitorStats['last'] = null;
  private logLines: LogLine[] = [];
  note: string | null = null;

  constructor(private deps: MonitorDeps) {}

  private log(text: string, now = Date.now()) {
    this.logLines.push({ t: now, text });
    if (this.logLines.length > LOG_MAX) this.logLines.shift();
  }

  /** The background adds its own events (a problem noticed, a session started) to the same log the panel shows. */
  logEvent(text: string): void {
    this.log(text);
  }

  /** Don't ask the model anything for a while (snapshots carry on): the student has just moved to a different problem. */
  suspendLooks(ms: number): void {
    this.suspendedUntil = Date.now() + ms;
  }

  /** …and they came back to the problem. */
  resumeLooks(): void {
    this.suspendedUntil = 0;
  }

  /** The student changed something that may have been why calls were failing (the key, the model): try again at once. */
  retryNow(): void {
    this.pausedUntil = 0;
    this.note = null;
  }

  /**
   * myTA's own toast, status pill or sprite just appeared, changed or went away. That shows up in the snapshots as a change on
   * the screen, but it is not the student's work: ignore pixel changes for the next couple of snapshots. (Typing and drawing are
   * counted from their input events, which this doesn't touch.)
   */
  ownUiChanged(now = Date.now()): void {
    this.ownUiUntil = Math.max(this.ownUiUntil, now + 2 * this.deps.intervalMs() + 500);
  }

  /** The student asked for a check themselves: the same work isn't checked again by myTA until there is more of it. */
  noteCheck(): void {
    this.gate?.noteCheck();
  }

  /** A reading thinks the problem was copied wrongly but the student may still be writing it: read again once they are still. */
  requestSettledRead(): void {
    this.gate?.requestSettledRead();
  }

  /** How long the student has been still, in ms (null before they have written anything on this problem). */
  idleMs(now = Date.now()): number | null {
    return this.gate?.idleMs(now) ?? null;
  }

  /** The answer was checked and nothing worth checking has been written since. */
  checkedSinceLastWork(): boolean {
    return this.gate?.checkedSinceLastWork() ?? false;
  }

  // ---------------- signals from the content scripts ----------------

  /**
   * Each frame's running totals, once a second. A tab's totals are the sum over its frames (typing in Google Docs
   * happens inside an iframe). Feeds work-tab detection and the wrong-answer trigger.
   */
  noteDom(tabId: number, frameId: number, s: DomStats, now = Date.now()): void {
    let frames = this.domFrames.get(tabId);
    if (!frames) this.domFrames.set(tabId, (frames = new Map()));
    frames.set(frameId, s);
    const total: DomStats = { incorrectTotal: 0, correctTotal: 0, submitTotal: 0, keyTotal: 0, pointerTotal: 0, scrollY: frames.get(0)?.scrollY ?? s.scrollY };
    for (const f of frames.values()) {
      total.incorrectTotal += f.incorrectTotal;
      total.correctTotal! += f.correctTotal ?? 0;
      total.submitTotal += f.submitTotal;
      total.keyTotal += f.keyTotal;
      total.pointerTotal += f.pointerTotal;
    }
    const prev = this.dom.get(tabId);
    this.dom.set(tabId, total);
    this.roles.record(tabId, now, total.keyTotal, total.pointerTotal);
    if (prev && Math.abs(total.scrollY - prev.scrollY) > 5) this.scrolledAt.set(tabId, now);
    const session = this.deps.session();
    if (session && tabId === session.problemTabId && prev && total.incorrectTotal > prev.incorrectTotal) {
      this.pendingIncorrect += total.incorrectTotal - prev.incorrectTotal;
      this.log('The homework page said the answer was wrong.', now);
    }
    if (session && tabId === session.problemTabId && prev && (total.correctTotal ?? 0) > (prev.correctTotal ?? 0)) {
      this.pendingCorrect += (total.correctTotal ?? 0) - (prev.correctTotal ?? 0);
      this.log('The homework page said the answer was correct.', now);
    }
  }

  /** What a tab's page looks like (a canvas and drawing tools, or answer boxes and a Check button): one more indicator of which tab is the work. */
  noteRole(tabId: number, hints: RoleHints, now = Date.now()): void {
    this.roles.recordHints(tabId, hints, now);
  }

  forgetTab(tabId: number): void {
    this.latest.delete(tabId);
    this.lastStoredAt.delete(tabId);
    this.dom.delete(tabId);
    this.domFrames.delete(tabId);
    this.inputAtTick.delete(tabId);
    this.scrolledAt.delete(tabId);
    this.attached.delete(tabId);
    this.roles.forget(tabId);
    void this.deps.store.dropTab(tabId).catch(() => {});
  }

  // ---------------- capturing ----------------

  /** Captures one tab now, keeps it as the latest, and stores it if it changed. */
  async capture(tab: chrome.tabs.Tab | undefined, now = Date.now()): Promise<{ frame: Frame; gray: Gray; workChange: number } | null> {
    if (!capturable(tab)) return null;
    const before = this.latest.get(tab.id);
    // A different page in the same tab is a fresh baseline, and the first frame of anything isn't "work".
    const samePage = before && before.frame.url === tab.url;
    const cap = await captureTab(tab, samePage ? before.gray : null);
    if (!cap) return null;
    this.captures++;
    this.latest.set(tab.id, cap);
    if (!before || isChange(cap.frame.changed) || now - (this.lastStoredAt.get(tab.id) ?? 0) > KEEPALIVE_MS) {
      this.lastStoredAt.set(tab.id, now);
      void this.deps.store.put(cap.frame).catch(() => {});
    }
    const scrolling = now - (this.scrolledAt.get(tab.id) ?? 0) < 2 * this.deps.intervalMs();
    const workChange = !samePage || scrolling || cap.frame.changed > NOT_WORK ? 0 : cap.frame.changed;
    return { ...cap, workChange };
  }

  /** The tabs to capture: the active tab of the focused window, plus the windows the problem and work tabs are in. */
  private async targets(session: MonitorSession | null): Promise<chrome.tabs.Tab[]> {
    const focused = await activeTab();
    const windows = new Map<number, chrome.tabs.Tab | undefined>();
    if (focused) windows.set(focused.windowId, focused);
    if (session) {
      for (const id of [session.problemTabId, session.workTabId]) {
        if (id === null) continue;
        try {
          const t = await chrome.tabs.get(id);
          if (!windows.has(t.windowId)) windows.set(t.windowId, await activeTab(t.windowId));
        } catch {
          /* tab is gone */
        }
      }
    }
    return [...windows.values()].filter((t): t is chrome.tabs.Tab => capturable(t));
  }

  // ---------------- the loop ----------------

  /**
   * Cheap to call often (every page signal and panel poll). Snapshots are taken once per snapshot interval; while a session
   * runs the call gate is also consulted every second, so "read every 5 s" and "idle for 8 s" are not rounded up to the
   * snapshot grid.
   */
  async pump(now = Date.now(), opts: { force?: boolean } = {}): Promise<void> {
    this.pumpedAt = { now, real: Date.now() };
    if (this.ticking) {
      // A timer that fired while another pass was running must not be lost: that pass may already be past the point where it would have looked.
      if (opts.force) this.wakeAt(150, true);
      return;
    }
    const session = this.deps.session();
    if (!session && !this.deps.active()) return;
    const captureDue = now - this.lastTickAt >= this.deps.intervalMs();
    // `force` is a wake-up timer that was set for exactly this moment: the usual "not more than every 200 ms" spacing doesn't apply to it.
    if (!captureDue && (!session || (!opts.force && now - this.lastDecideAt < DECIDE_MS))) return;
    this.ticking = true;
    this.lastDecideAt = now;
    try {
      this.syncGate(session);
      const changed = new Map<number, number>();
      if (captureDue) {
        this.lastTickAt = now;
        for (const tab of await this.targets(session)) {
          const c = await this.capture(tab, now);
          if (c) changed.set(tab.id!, c.workChange);
        }
      }
      if (!session || !this.gate) return;

      if (captureDue) void this.detectWorkTab(session, now);
      const source = session.workTabId ?? session.problemTabId;
      const newIncorrect = this.pendingIncorrect;
      this.pendingIncorrect = 0;
      if (this.pendingCorrect > 0) {
        // The homework page itself says it's right: there is nothing left to ask the model about this problem.
        this.pendingCorrect = 0;
        this.gate.markSolvedByPage();
        this.log('The page says your answer is correct, so there is nothing more to check.', now);
        this.deps.onSolvedByPage?.();
      }
      const score = this.deps.score();
      const finish = this.deps.finish?.() ?? null;
      const progress = this.deps.progress?.() ?? null;
      const ownUi = now < this.ownUiUntil;
      const decision = this.gate.push({ now, workChanged: ownUi ? 0 : (changed.get(source) ?? 0), workInput: this.inputSince(source), score, newIncorrect, finish, progress });
      const quiet = this.frozen || now < this.pausedUntil || now < this.suspendedUntil || !this.deps.hasHeadroom();
      if (!decision && !quiet && progress) {
        // A line is nearly done: take the picture now, and wake up exactly when it settles instead of at the next page signal.
        if (this.gate.lineWaiting(now, PRECAPTURE_IDLE_MS) && this.preCapturedFor !== this.gate.lastWriteAt()) {
          this.preCapturedFor = this.gate.lastWriteAt();
          await this.captureWork(session);
        }
        // The capture took real time: how long until the line settles is counted from now, not from before it.
        this.wakeAt(this.gate.nextWakeMs(this.t()));
      }
      if (!decision || quiet) return;

      // Looks finished, the homework page just said the answer is wrong, or a line was just written: take a fresh snapshot of the work
      // right now rather than using the last periodic one (up to a snapshot interval old, which would be before the line existed).
      const isCheck = decision.reason === 'finished' || decision.reason === 'wrong-answer';
      if (isCheck) {
        this.log(decision.reason === 'finished' ? `Looks like you've finished (${decision.detail}). Taking a snapshot to check your answer.` : 'The page says your answer is wrong. Taking a snapshot to see where it went off.', now);
      }
      if (isCheck) await this.snapshotNow();
      else if (decision.reason === 'progress') await this.freshWork(session);
      const idleMs = this.gate.idleMs(this.t());
      const work = this.latest.get(source)?.frame;
      if (!work) return;
      const separate = session.workTabId !== null && session.workTabId !== session.problemTabId;
      // Reading along every few seconds doesn't re-send a problem page that hasn't changed; every other look carries it.
      let problem: Frame | null = null;
      if (separate) {
        if (decision.reason === 'progress') problem = this.problemIfNew(session);
        else {
          const p = this.latest.get(session.problemTabId);
          problem = p?.frame ?? null;
          if (p) this.attached.set(session.problemTabId, p.gray);
        }
      }
      this.wakeMisses = 0;
      const job: ReviewJob = { sessionId: session.id, reason: decision.reason, detail: decision.detail, work, problem, separate, idleMs };
      this.gate.callStarted(this.t(), decision.reason, score);
      this.reviews++;
      this.last = { at: now, reason: decision.reason, detail: decision.detail, outcome: 'running' };
      // Reading along is routine; it is logged once it has an outcome so the log stays readable.
      if (decision.reason !== 'progress') this.log(isCheck ? 'Checking your answer…' : `Asking the model to look: ${decision.detail}.`, now);
      const gate = this.gate;
      this.deps.review(job).then(
        (outcome) => {
          gate.callFinished(outcome);
          if (this.last) this.last.outcome = outcome;
          this.note = null;
          this.lookedAt = Date.now();
          if (isCheck) this.log(`Checked your answer: ${outcome === 'solved' ? 'looks right' : outcome.replace('_', ' ')}.`);
          else if (decision.reason !== 'progress' || outcome === 'mistake' || outcome === 'different') this.log(`The model's look found: ${outcome.replace('_', ' ')}.`);
          this.deps.onOutcome?.(outcome, job);
        },
        (e) => {
          gate.callFinished('failed');
          if (this.last) this.last.outcome = 'failed';
          this.pauseFor(e);
        },
      );
    } finally {
      this.ticking = false;
    }
  }

  /** A new gate per session; none outside one. */
  private syncGate(session: MonitorSession | null): void {
    if (!session) {
      this.gate = null;
      this.gateFor = null;
      this.frozen = null;
      return;
    }
    if (this.gateFor !== session.id) {
      this.gate = new CallGate(session.startedAt, { ...DEFAULT_GATE, ...this.deps.gateConfig?.() });
      this.gateFor = session.id;
      this.gate.seedWork(this.roles.recentInput(this.source(session), session.startedAt));
      this.last = null;
      this.log('Session started: watching the problem tab.', session.startedAt);
    }
  }

  /** Typing and pen/mouse drawing on a tab since the last tick (the first tick for a tab is just its baseline). */
  private inputSince(tabId: number): number {
    const d = this.dom.get(tabId);
    if (!d) return 0;
    const total = d.keyTotal + POINTER_WEIGHT * d.pointerTotal;
    const before = this.inputAtTick.get(tabId);
    this.inputAtTick.set(tabId, total);
    return before === undefined ? 0 : Math.max(0, total - before);
  }

  /** Make the input the tab already had in the recent window show up as "new" on the next tick. */
  private seedInput(tabId: number, now: number): void {
    const d = this.dom.get(tabId);
    if (!d) return;
    this.inputAtTick.set(tabId, d.keyTotal + POINTER_WEIGHT * d.pointerTotal - this.roles.recentInput(tabId, now));
  }

  private async detectWorkTab(session: MonitorSession, now: number): Promise<void> {
    if (session.workPinned) return;
    const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*', 'file:///*'] }).catch(() => [] as chrome.tabs.Tab[]);
    const pick = this.roles.pickWork(
      tabs.filter((t) => t.id !== undefined).map((t) => ({ tabId: t.id!, url: t.url ?? '', title: t.title ?? '' })),
      session.problemTabId,
      session.workTabId,
      now,
    );
    if (pick !== session.workTabId) {
      // Whatever the student wrote before we noticed this tab still counts as new work for the call gate.
      if (pick !== null) this.seedInput(pick, now);
      this.deps.onWorkTab(pick);
      this.log(pick === null ? 'No separate work tab: watching the problem page.' : 'Found the tab where you are writing your work.', now);
    }
  }

  private pauseFor(e: unknown): void {
    if (e instanceof RateLimitError) {
      this.pausedUntil = Date.now() + 10_000;
    } else if (e instanceof LlmError && (e.kind === 'auth' || e.kind === 'quota')) {
      // Long enough not to hammer a bad key, short enough that fixing the key in setup doesn't mean waiting minutes for it to resume.
      this.pausedUntil = Date.now() + REVIEW_BACKOFF_MS;
      this.note = e.message;
    } else if (e instanceof LlmError && e.kind === 'rate') {
      this.pausedUntil = Date.now() + REVIEW_BACKOFF_MS;
      this.note = 'Gemini is rate-limiting, so I paused asking for a minute. Snapshots are still being saved.';
    } else {
      this.pausedUntil = Date.now() + 20_000;
      this.note = e instanceof Error ? e.message : 'Couldn\'t review your work just now.';
    }
    this.log(`The model call failed: ${this.note ?? 'paused briefly'}`);
  }

  // ---------------- what the model gets ----------------

  /** The work tab's picture is from after the student's last stroke (so it shows everything they wrote): nothing to capture. */
  private async freshWork(session: MonitorSession): Promise<void> {
    const source = this.source(session);
    const have = this.latest.get(source);
    if (have && this.gate && have.frame.at >= this.gate.lastWriteAt()) return;
    await this.captureWork(session);
  }

  /** Captures just the tab where the work is: one capture instead of every tab (Chrome allows two a second, so each one counts). */
  private async captureWork(session: MonitorSession): Promise<void> {
    try {
      await this.capture(await chrome.tabs.get(this.source(session)));
    } catch {
      /* the tab is gone: the next periodic snapshot copes */
    }
  }

  /** Now, on the clock `pump` was last given. Outside tests that is just the time. */
  private t(): number {
    const p = this.pumpedAt;
    return p ? p.now + (Date.now() - p.real) : Date.now();
  }

  /** Checks the call gate again in `ms` (the next thing that can happen is a matter of the clock, not of anything arriving). */
  private wakeAt(ms: number | null, exact = false): void {
    if (this.wakeTimer !== undefined) clearTimeout(this.wakeTimer);
    this.wakeTimer = undefined;
    if (ms === null) return;
    // If waking up didn't lead to a look (something else is holding it back, like a spent budget), wake less and less often rather than spin.
    const delay = exact ? ms : Math.min(2000, ms * 2 ** Math.min(this.wakeMisses, 6));
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = undefined;
      if (!exact) this.wakeMisses++;
      void this.pump(this.t(), { force: true }).catch(() => undefined);
    }, delay) as unknown as number;
  }

  /** Captures the session's tabs right now (the student may have just typed). */
  async snapshotNow(): Promise<void> {
    const session = this.deps.session();
    if (!session) return;
    for (const tab of await this.targets(session)) await this.capture(tab);
  }

  private source(session: MonitorSession): number {
    return session.workTabId ?? session.problemTabId;
  }

  /**
   * The screens to show the hint writer. The work screen is ALWAYS attached: handwriting is a tiny
   * fraction of a screen, so "has it changed?" can't be trusted to notice it, and a hint is exactly the
   * moment the model needs to see their work. The problem tab is only attached when it changed
   * since the model last saw it (it usually hasn't).
   */
  forTutor(): { work: Frame | null; problem: Frame | null } {
    const session = this.deps.session();
    if (!session) return { work: null, problem: null };
    if (this.frozen) return { work: this.frozen.work, problem: this.frozen.problem };
    // What the model has seen is remembered per session, not per gate: the first tick after a session starts
    // must not make the tutor re-attach a problem page it was already shown.
    if (this.attachedFor !== session.id) {
      this.attached.clear();
      this.attachedFor = session.id;
    }
    const twoTabs = session.workTabId !== null && session.workTabId !== session.problemTabId;
    const source = this.source(session);
    const work = this.latest.get(source);
    if (work) this.attached.set(source, work.gray);
    if (!twoTabs) return { work: work?.frame ?? null, problem: null };
    return { work: work?.frame ?? null, problem: this.problemIfNew(session) };
  }

  /** The problem tab's frame if it changed since the model last saw it (or it never has), else null. Marks it as seen. */
  private problemIfNew(session: MonitorSession): Frame | null {
    if (this.attachedFor !== session.id) {
      this.attached.clear();
      this.attachedFor = session.id;
    }
    const prob = this.latest.get(session.problemTabId);
    if (!prob) return null;
    const seen = this.attached.get(session.problemTabId);
    const isNew = !seen || isChange(changedFraction(seen, prob.gray));
    this.attached.set(session.problemTabId, prob.gray);
    return isNew ? prob.frame : null;
  }

  /** The student is moving on: hold the frames of their finished work. `fresh` re-captures the (still showing) problem tab first. */
  async freeze(fresh: boolean): Promise<{ work: Frame; problem: Frame | null } | null> {
    if (this.frozen) return this.frozen;
    const session = this.deps.session();
    if (!session) return null;
    if (fresh) {
      try {
        await this.capture(await chrome.tabs.get(session.problemTabId));
      } catch {
        /* tab already gone: use what we have */
      }
    }
    const work = this.latest.get(this.source(session))?.frame ?? (await this.deps.store.latest(this.source(session)));
    if (!work) return null;
    const twoTabs = session.workTabId !== null && session.workTabId !== session.problemTabId;
    const problem = twoTabs ? (this.latest.get(session.problemTabId)?.frame ?? (await this.deps.store.latest(session.problemTabId))) : null;
    this.frozen = { work, problem };
    return this.frozen;
  }

  unfreeze(): void {
    this.frozen = null;
  }

  get isFrozen(): boolean {
    return this.frozen !== null;
  }

  /** The frames to judge finished work by (frozen if the student already moved on, else a fresh capture). */
  async finalFrames(): Promise<{ work: Frame; problem: Frame | null } | null> {
    if (this.frozen) return this.frozen;
    await this.snapshotNow();
    const session = this.deps.session();
    if (!session) return null;
    const work = this.latest.get(this.source(session))?.frame;
    if (!work) return null;
    const twoTabs = session.workTabId !== null && session.workTabId !== session.problemTabId;
    return { work, problem: twoTabs ? (this.latest.get(session.problemTabId)?.frame ?? null) : null };
  }

  latestFrame(tabId: number): Frame | null {
    return this.latest.get(tabId)?.frame ?? null;
  }

  /** A new session: forget the old session's state. Stored snapshots stay (they are just a short history). */
  reset(): void {
    this.wakeAt(null);
    this.preCapturedFor = 0;
    this.frozen = null;
    this.gate = null;
    this.gateFor = null;
    this.attached.clear();
    this.attachedFor = null;
    this.pendingIncorrect = 0;
    this.pendingCorrect = 0;
    this.pausedUntil = 0;
    this.suspendedUntil = 0;
    this.note = null;
    this.lookedAt = null;
    this.last = null;
  }

  /** Disabled or snoozed: drop every stored snapshot. */
  async clear(): Promise<void> {
    this.latest.clear();
    this.lastStoredAt.clear();
    this.attached.clear();
    this.reset();
    await this.deps.store.clear().catch(() => {});
  }

  get lastCaptureAt(): number | null {
    let t = 0;
    for (const { frame } of this.latest.values()) t = Math.max(t, frame.at);
    return t || null;
  }

  async stats(now = Date.now()): Promise<MonitorStats> {
    const session = this.deps.session();
    const store: StoreStats = await this.deps.store.stats().catch(() => ({ frames: 0, bytes: 0, perTab: {} }));
    const tabs: TabView[] = [...this.latest.values()]
      .map(({ frame }) => {
        const a = this.roles.assess(frame.tabId, frame.url, frame.title, now);
        return {
          tabId: frame.tabId,
          role: (frame.tabId === session?.problemTabId ? 'problem' : frame.tabId === session?.workTabId ? 'work' : 'other') as TabView['role'],
          title: frame.title,
          host: hostOf(frame.url),
          at: frame.at,
          stored: store.perTab[frame.tabId] ?? 0,
          looksLike: a.looksLike,
          confidence: Math.round(a.confidence * 100) / 100,
          why: a.why,
        };
      })
      .sort((a, b) => ['problem', 'work', 'other'].indexOf(a.role) - ['problem', 'work', 'other'].indexOf(b.role));
    return {
      captures: this.captures,
      storedFrames: store.frames,
      storedBytes: store.bytes,
      reviews: this.reviews,
      tabs,
      gate: this.gate?.state(now) ?? null,
      note: this.note,
      last: this.last,
      log: [...this.logLines].reverse(),
    };
  }
}
