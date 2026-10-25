import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LlmError } from '../src/ai/llmClient';
import type { CallOutcome } from '../src/background/callGate';
import { changedFraction, type Gray } from '../src/background/frameDiff';
import type { Frame } from '../src/background/frames';
import { MemoryFrameStore } from '../src/background/frameStore';
import { Monitor, type DomStats, type MonitorSession, type ReviewJob } from '../src/background/monitor';

// ---- a fake browser: tabs, windows, and screens that can change ----
interface FakeTab {
  id: number;
  windowId: number;
  url: string;
  title: string;
  active: boolean;
}
const fx = vi.hoisted(() => ({ tabs: [] as FakeTab[], focusedWindow: 1, screens: new Map<number, Gray>(), version: new Map<number, number>() }));

vi.mock('../src/background/frames', () => ({
  capturable: (t?: FakeTab) => !!t?.id && /^https?:/.test(t.url ?? ''),
  activeTab: async (windowId?: number) => fx.tabs.find((t) => t.active && t.windowId === (windowId ?? fx.focusedWindow)),
  captureTab: async (tab: FakeTab, prev: Gray | null) => {
    const gray = fx.screens.get(tab.id)!;
    const frame: Frame = {
      jpeg: `jpeg-${tab.id}-v${fx.version.get(tab.id) ?? 0}`,
      at: Date.now(),
      tabId: tab.id,
      windowId: tab.windowId,
      url: tab.url,
      title: tab.title,
      changed: changedFraction(prev, gray),
    };
    return { frame, gray };
  },
}));

const W = 192;
const H = 108;
const blank = (): Gray => ({ data: new Uint8Array(W * H).fill(240), w: W, h: H });
/** Draw `fraction` of the screen dark: the student writing. */
function draw(tabId: number, fraction: number) {
  const g = fx.screens.get(tabId)!;
  const next: Gray = { ...g, data: new Uint8Array(g.data) };
  const start = next.data.findIndex((v) => v === 240);
  for (let i = 0; i < Math.round(next.data.length * fraction); i++) next.data[start + i] = 10;
  fx.screens.set(tabId, next);
  fx.version.set(tabId, (fx.version.get(tabId) ?? 0) + 1);
}

const stats = (over: Partial<DomStats> = {}): DomStats => ({ incorrectTotal: 0, submitTotal: 0, keyTotal: 0, pointerTotal: 0, scrollY: 0, ...over });
const T0 = 50_000_000;

interface Rig {
  m: Monitor;
  store: MemoryFrameStore;
  session: { current: MonitorSession | null };
  reviews: ReviewJob[];
  setOutcome: (o: CallOutcome | Error) => void;
  headroom: { ok: boolean };
  score: { value: number | null };
  /** When the student counts as finished; null (the default) = automatic checking off. */
  finish: { current: { idleMs: number; calmBelow: number } | null };
  /** How often to read the work while it is written; null (the default) = continuous reading off. */
  progress: { current: { everyMs: number } | null };
  outcomes: CallOutcome[];
  solvedByPage: { n: number };
  workTabs: (number | null)[];
  /** Run one tick per `step` seconds (3, like the snapshot interval, unless said otherwise) for `seconds`, returning the virtual time reached. */
  run: (seconds: number, from?: number, step?: number) => Promise<number>;
}

function rig(session: MonitorSession | null = null): Rig {
  const store = new MemoryFrameStore();
  const ref = { current: session };
  const reviews: ReviewJob[] = [];
  const headroom = { ok: true };
  const score = { value: null as number | null };
  const finish = { current: null as { idleMs: number; calmBelow: number } | null };
  const progress = { current: null as { everyMs: number } | null };
  const outcomes: CallOutcome[] = [];
  const solvedByPage = { n: 0 };
  const workTabs: (number | null)[] = [];
  let outcome: CallOutcome | Error = 'on_track';
  const m = new Monitor({
    store,
    intervalMs: () => 3000,
    active: () => true,
    session: () => ref.current,
    score: () => score.value,
    finish: () => finish.current,
    progress: () => progress.current,
    onOutcome: (o) => outcomes.push(o),
    onSolvedByPage: () => solvedByPage.n++,
    hasHeadroom: () => headroom.ok,
    review: async (job) => {
      reviews.push(job);
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
    onWorkTab: (id) => {
      workTabs.push(id);
      if (ref.current) ref.current = { ...ref.current, workTabId: id };
    },
  });
  let clock = T0;
  const run = async (seconds: number, from?: number, step = 3) => {
    clock = from ?? clock;
    for (let t = 0; t < seconds; t += step) {
      clock += step * 1000;
      await m.pump(clock);
      await new Promise((r) => setTimeout(r, 0)); // let review promises settle
    }
    return clock;
  };
  return { m, store, session: ref, reviews, setOutcome: (o) => (outcome = o), headroom, score, finish, progress, outcomes, solvedByPage, workTabs, run };
}

const sessionOn = (problemTabId: number, extra: Partial<MonitorSession> = {}): MonitorSession => ({ id: 's1', problemTabId, workTabId: null, workPinned: false, startedAt: T0, ...extra });

beforeEach(() => {
  fx.tabs = [
    { id: 1, windowId: 1, url: 'https://homework.example/q4', title: 'Homework 3.4', active: true },
    { id: 2, windowId: 2, url: 'https://docs.google.com/document/d/abc', title: 'My work', active: true },
  ];
  fx.focusedWindow = 1;
  fx.screens = new Map([[1, blank()], [2, blank()]]);
  fx.version = new Map();
  vi.stubGlobal('chrome', { tabs: { get: async (id: number) => fx.tabs.find((t) => t.id === id), query: async () => fx.tabs } });
});

describe('Monitor: snapshots are free', () => {
  it('captures every tick and stores only what changed, without ever calling the model', async () => {
    const r = rig();
    await r.run(30); // 10 ticks of an unchanged screen
    expect((await r.store.stats()).frames).toBe(1);
    draw(1, 0.05);
    await r.run(9);
    expect((await r.store.stats()).frames).toBe(2);
    const s = await r.m.stats();
    expect(s.captures).toBe(13);
    expect(s.reviews).toBe(0);
    expect(r.reviews).toHaveLength(0);
  });

  it('only acts once per interval, however often it is poked', async () => {
    const r = rig();
    await r.m.pump(T0 + 3000);
    await r.m.pump(T0 + 3100);
    await r.m.pump(T0 + 3200);
    expect((await r.m.stats()).captures).toBe(1);
  });

  it('does nothing when it is not allowed to watch', async () => {
    const store = new MemoryFrameStore();
    const m = new Monitor({ store, intervalMs: () => 3000, active: () => false, session: () => null, score: () => null, hasHeadroom: () => true, review: async () => 'on_track', onWorkTab: () => {} });
    await m.pump(T0 + 3000);
    expect((await m.stats()).captures).toBe(0);
  });

  it('forgets everything on clear()', async () => {
    const r = rig();
    await r.run(6);
    await r.m.clear();
    expect((await r.store.stats()).frames).toBe(0);
    expect((await r.m.stats()).tabs).toHaveLength(0);
  });
});

describe('Monitor: when it asks the model', () => {
  it('a wrong answer on the homework page → exactly one look, then quiet', async () => {
    const r = rig(sessionOn(1));
    await r.run(6);
    r.m.noteDom(1, 0, stats());
    r.m.noteDom(1, 0, stats({ incorrectTotal: 1 }));
    await r.run(12);
    expect(r.reviews).toHaveLength(1);
    expect(r.reviews[0]).toMatchObject({ reason: 'wrong-answer', sessionId: 's1' });
    expect(r.reviews[0].work.tabId).toBe(1);
    expect(r.reviews[0].problem).toBeNull(); // one tab: the problem and the work are the same page
    await r.run(600); // ten quiet minutes
    expect(r.reviews).toHaveLength(1);
  });

  it('an unchanged screen with a rising score is not worth a look', async () => {
    const r = rig(sessionOn(1));
    r.score.value = 80;
    await r.run(300);
    expect(r.reviews).toHaveLength(0);
  });

  it('rising confusion plus new work → a look', async () => {
    const r = rig(sessionOn(1));
    r.score.value = 10;
    await r.run(6);
    r.score.value = 55;
    draw(1, 0.001);
    await r.run(6);
    expect(r.reviews).toHaveLength(1);
    expect(r.reviews[0].reason).toBe('confusion-rise');
  });

  it('a long time on the problem with new work → a look (and not before the checkpoint)', async () => {
    const r = rig(sessionOn(1));
    await r.run(6);
    draw(1, 0.001); // a little work: enough to count as new, not a burst
    await r.run(30);
    expect(r.reviews).toHaveLength(0); // the checkpoint (a minute in) hasn't come yet
    await r.run(30);
    expect(r.reviews.map((j) => j.reason)).toEqual(['time-on-problem']);
  });

  it('a burst of writing then a pause → a look', async () => {
    const r = rig(sessionOn(1));
    await r.run(6);
    draw(1, 0.04);
    await r.run(12);
    expect(r.reviews.map((j) => j.reason)).toEqual(['work-pause']);
  });

  it('scrolling or navigating is not "work"', async () => {
    const r = rig(sessionOn(1));
    await r.run(6);
    r.m.noteDom(1, 0, stats({ scrollY: 0 }));
    r.m.noteDom(1, 0, stats({ scrollY: 900 })); // the page scrolled
    draw(1, 0.5);
    await r.run(15);
    fx.tabs[0].url = 'https://homework.example/q5'; // and then navigated
    draw(1, 0.5);
    await r.run(30);
    expect(r.reviews).toHaveLength(0);
  });

  it('never makes a call without headroom, but keeps taking snapshots', async () => {
    const r = rig(sessionOn(1));
    r.headroom.ok = false;
    await r.run(6);
    r.m.noteDom(1, 0, stats());
    r.m.noteDom(1, 0, stats({ incorrectTotal: 1 }));
    await r.run(30);
    expect(r.reviews).toHaveLength(0);
    expect((await r.m.stats()).captures).toBeGreaterThan(5);
  });

  it('a failed call pauses asking (and says why) but not snapshots', async () => {
    const r = rig(sessionOn(1));
    r.setOutcome(new LlmError('rate', 'slow down', 429));
    await r.run(6);
    r.m.noteDom(1, 0, stats());
    r.m.noteDom(1, 0, stats({ incorrectTotal: 1 }));
    await r.run(12);
    expect(r.reviews).toHaveLength(1);
    expect(r.m.note).toMatch(/rate-limiting/);
    r.m.noteDom(1, 0, stats({ incorrectTotal: 2 }));
    await r.run(30); // inside the pause: no second call
    expect(r.reviews).toHaveLength(1);
    expect((await r.m.stats()).captures).toBeGreaterThan(8);
  });

  it('stops asking once the work is solved', async () => {
    const r = rig(sessionOn(1));
    r.setOutcome('solved');
    await r.run(6);
    r.m.noteDom(1, 0, stats());
    r.m.noteDom(1, 0, stats({ incorrectTotal: 1 }));
    await r.run(12);
    expect(r.reviews).toHaveLength(1);
    draw(1, 0.05);
    await r.run(120);
    expect(r.reviews).toHaveLength(1);
  });

  it('but the homework page saying "wrong" after that is heard, and checked at once (the page has the last word)', async () => {
    const r = rig(sessionOn(1));
    r.setOutcome('solved');
    await r.run(6);
    r.m.noteDom(1, 0, stats());
    r.m.noteDom(1, 0, stats({ incorrectTotal: 1 }));
    await r.run(12);
    expect(r.reviews).toHaveLength(1);
    r.m.noteDom(1, 0, stats({ incorrectTotal: 2 }));
    await r.run(15);
    expect(r.reviews).toHaveLength(2);
    expect(r.reviews[1].reason).toBe('wrong-answer');
  });

  it('starts a fresh gate for a new session', async () => {
    const r = rig(sessionOn(1));
    r.setOutcome('solved');
    await r.run(6);
    r.m.noteDom(1, 0, stats());
    r.m.noteDom(1, 0, stats({ incorrectTotal: 1 }));
    await r.run(12);
    expect(r.reviews).toHaveLength(1);
    r.session.current = sessionOn(1, { id: 's2', startedAt: T0 + 100_000 });
    r.setOutcome('on_track');
    r.m.noteDom(1, 0, stats({ incorrectTotal: 2 }));
    await r.run(15);
    expect(r.reviews.map((j) => j.sessionId)).toEqual(['s1', 's2']);
  });
});

describe('Monitor: a sketchpad (drawing is events and a few pixels, not typing)', () => {
  it('finds a work tab where the student only draws', async () => {
    const r = rig(sessionOn(1));
    await r.run(6);
    r.m.noteDom(2, 0, stats({ pointerTotal: 0 }), T0);
    r.m.noteDom(2, 0, stats({ pointerTotal: 250 }), T0 + 30_000); // a handwritten line: lots of drag events
    await r.run(6, T0 + 30_000);
    expect(r.workTabs).toEqual([2]);
  });

  it('asks the model to look after a written line and a pause, even though the screen barely changed', async () => {
    const r = rig(sessionOn(1, { workTabId: 2 }));
    const now = await r.run(6);
    // the student drags a pen: ~400 drag events and a change too small for any pixel threshold
    r.m.noteDom(2, 0, stats({ pointerTotal: 0 }), now);
    await r.run(3, now);
    r.m.noteDom(2, 0, stats({ pointerTotal: 400 }), now + 3000);
    draw(2, 0.0003);
    await r.run(12);
    expect(r.reviews.map((j) => j.reason)).toEqual(['work-pause']);
    expect(r.reviews[0].work.tabId).toBe(2); // and the look is of the sketchpad
  });

  it('counts what the student wrote before the sketchpad was recognised as the work tab', async () => {
    const r = rig(sessionOn(1));
    await r.run(6);
    // a line of handwriting, then the student stops; only then does the monitor work out which tab it was
    r.m.noteDom(2, 0, stats({ pointerTotal: 0 }), T0);
    r.m.noteDom(2, 0, stats({ pointerTotal: 400 }), T0 + 30_000);
    await r.run(6, T0 + 30_000);
    expect(r.workTabs).toEqual([2]);
    await r.run(15);
    expect(r.reviews.map((j) => j.reason)).toEqual(['work-pause']);
    expect(r.reviews[0].work.tabId).toBe(2);
  });

  it('a few stray strokes do not cost a model call', async () => {
    const r = rig(sessionOn(1, { workTabId: 2 }));
    const now = await r.run(6);
    r.m.noteDom(2, 0, stats({ pointerTotal: 0 }), now);
    await r.run(3, now);
    r.m.noteDom(2, 0, stats({ pointerTotal: 30 }), now + 3000); // ~7 characters' worth
    await r.run(60);
    expect(r.reviews).toHaveLength(0);
  });

  it('always shows the tutor the sketchpad as it is now, not a blank one from earlier', async () => {
    const r = rig(sessionOn(1, { workTabId: 2 }));
    await r.m.snapshotNow();
    expect(r.m.forTutor().work?.jpeg).toBe('jpeg-2-v0'); // the empty sketchpad
    draw(2, 0.0004); // writing too faint for a pixel threshold
    await r.m.snapshotNow();
    expect(r.m.forTutor().work?.jpeg).toBe('jpeg-2-v1'); // the model gets the new frame regardless
  });
});

describe('Monitor: the student finishes', () => {
  const FIN = { idleMs: 10_000, calmBelow: 35 };
  /** The student handwrites a line on the sketchpad (tab 2), then does nothing. Returns the time of the last stroke. */
  async function writeALine(r: Rig): Promise<number> {
    const now = await r.run(6);
    r.m.noteDom(2, 0, stats({ pointerTotal: 0 }), now);
    await r.run(3, now);
    r.m.noteDom(2, 0, stats({ pointerTotal: 400 }), now + 3000);
    draw(2, 0.0003); // too faint for any pixel threshold
    return now + 3000;
  }

  it('stops for the idle time with a low score → one check of the answer, of the work screen, by itself', async () => {
    const r = rig(sessionOn(1, { workTabId: 2 }));
    r.finish.current = FIN;
    r.score.value = 15;
    await writeALine(r);
    await r.run(30);
    expect(r.reviews.map((j) => j.reason)).toEqual(['finished']);
    expect(r.reviews[0].work.tabId).toBe(2);
    expect(r.reviews[0].problem?.tabId).toBe(1);
    const log = (await r.m.stats()).log.map((l) => l.text).join('\n');
    expect(log).toMatch(/finished/i);
    expect(log).toMatch(/snapshot/i); // it says it took one
  });

  it('takes a fresh snapshot at that moment, rather than using the last periodic one', async () => {
    const r = rig(sessionOn(1, { workTabId: 2 }));
    r.finish.current = FIN;
    r.score.value = 15;
    await writeALine(r);
    const before = (await r.m.stats()).captures;
    await r.run(30); // 10 ticks of two tabs, plus the extra snapshot of both at the moment of finishing
    const after = (await r.m.stats()).captures;
    const ticks = 10;
    expect(after - before).toBeGreaterThan(ticks * 2);
  });

  it('does not check while the student is still confused, however still they are', async () => {
    const r = rig(sessionOn(1, { workTabId: 2 }));
    r.finish.current = FIN;
    r.score.value = 70;
    await writeALine(r);
    await r.run(120);
    expect(r.reviews.map((j) => j.reason)).not.toContain('finished');
  });

  it('does nothing of the kind when automatic checking is off', async () => {
    const r = rig(sessionOn(1, { workTabId: 2 }));
    r.score.value = 15;
    await writeALine(r);
    await r.run(120);
    expect(r.reviews.map((j) => j.reason)).not.toContain('finished');
  });

  it('does not check again by itself once the answer is confirmed right', async () => {
    const r = rig(sessionOn(1, { workTabId: 2 }));
    r.finish.current = FIN;
    r.score.value = 15;
    r.setOutcome('solved');
    const last = await writeALine(r);
    await r.run(30);
    expect(r.reviews).toHaveLength(1);
    r.m.noteDom(2, 0, stats({ pointerTotal: 800 }), last + 60_000); // more writing afterwards
    await r.run(60);
    expect(r.reviews).toHaveLength(1);
  });

  it('checks again after the student fixes their work, and not before', async () => {
    const r = rig(sessionOn(1, { workTabId: 2 }));
    r.finish.current = FIN;
    r.score.value = 15;
    r.setOutcome('mistake');
    const last = await writeALine(r);
    const t = await r.run(30);
    expect(r.reviews.map((j) => j.reason)).toEqual(['finished']);
    expect(r.m.checkedSinceLastWork()).toBe(true); // so the "check before you move on?" offer is not repeated
    await r.run(60); // they read the message and do nothing
    expect(r.reviews).toHaveLength(1);
    r.m.noteDom(2, 0, stats({ pointerTotal: 800 }), t + 3000); // they rewrite a line
    await r.run(30);
    // (a quiet "a while on this problem" look may also come along while they rewrite; the checks are what matter here)
    expect(r.reviews.filter((j) => j.reason === 'finished')).toHaveLength(2);
    void last;
  });

  it('counts a check the student asked for, so it is not repeated', async () => {
    const r = rig(sessionOn(1, { workTabId: 2 }));
    r.finish.current = FIN;
    r.score.value = 15;
    await writeALine(r);
    await r.run(6); // the writing is seen; they are not yet still for long enough to count as finished
    expect(r.reviews).toHaveLength(0);
    r.m.noteCheck(); // they press "Check my work"
    expect(r.m.checkedSinceLastWork()).toBe(true);
    await r.run(60);
    expect(r.reviews.map((j) => j.reason)).not.toContain('finished');
  });

  it('keeps quiet looks away while the student has moved to another problem, until they come back', async () => {
    const r = rig(sessionOn(1));
    await r.run(6);
    r.m.suspendLooks(60_000);
    r.m.noteDom(1, 0, stats());
    r.m.noteDom(1, 0, stats({ incorrectTotal: 1 }));
    await r.run(30);
    expect(r.reviews).toHaveLength(0);
    r.m.resumeLooks();
    await r.run(12);
    expect(r.reviews.map((j) => j.reason)).toEqual(['wrong-answer']);
  });

  it('does not mistake its own toast, pill or sprite appearing on the page for the student writing', async () => {
    const r = rig(sessionOn(1));
    const now = await r.run(6);
    r.m.ownUiChanged(now);
    draw(1, 0.04); // a sprite bubble appears: a change on screen the size of a line of writing
    await r.run(12, now);
    expect(r.reviews).toHaveLength(0);
    draw(1, 0.04); // later the student really writes
    await r.run(15);
    expect(r.reviews.map((j) => j.reason)).toEqual(['work-pause']);
  });

  it('lets the background add its own events to the log the panel shows', async () => {
    const r = rig(sessionOn(1));
    r.m.logEvent('Noticed Q4: working it out privately.');
    expect((await r.m.stats()).log[0].text).toBe('Noticed Q4: working it out privately.');
  });
});

describe('Monitor: it keeps reading while the student writes', () => {
  /** A student drawing steadily on the work tab: every second, another stretch of strokes. */
  async function keepWriting(r: Rig, seconds: number, from: number, perSecond = 40) {
    let total = 0;
    let t = from;
    r.m.noteDom(2, 0, stats({ pointerTotal: 0 }), t);
    for (let i = 0; i < seconds; i++) {
      t += 1000;
      total += perSecond;
      r.m.noteDom(2, 0, stats({ pointerTotal: total }), t);
      await r.run(1, t, 1);
    }
    return t;
  }

  it('reads every few seconds for as long as they keep writing, not once and then nothing', async () => {
    const r = rig(sessionOn(1, { workTabId: 2 }));
    r.progress.current = { everyMs: 5000 };
    const t = await r.run(3);
    await keepWriting(r, 60, t);
    const reads = r.reviews.filter((j) => j.reason === 'progress');
    expect(reads.length).toBeGreaterThanOrEqual(10);
    expect(reads.length).toBeLessThanOrEqual(13); // about one every 5 s, not a flood
    expect(reads.every((j) => j.work.tabId === 2)).toBe(true);
  });

  it('is off when continuous reading is switched off', async () => {
    const r = rig(sessionOn(1, { workTabId: 2 }));
    const t = await r.run(3);
    await keepWriting(r, 40, t);
    expect(r.reviews.filter((j) => j.reason === 'progress')).toHaveLength(0);
  });

  it('stops reading when they stop (sitting still costs nothing)', async () => {
    const r = rig(sessionOn(1, { workTabId: 2 }));
    r.progress.current = { everyMs: 5000 };
    const t = await r.run(3);
    const end = await keepWriting(r, 20, t);
    const during = r.reviews.length;
    await r.run(120, end, 1);
    // a read that was already due may follow; after that, nothing: no more readings while they sit still
    expect(r.reviews.slice(during + 1).filter((j) => j.reason === 'progress')).toHaveLength(0);
  });

  it('is not slowed by earlier readings that found nothing new, however many', async () => {
    const r = rig(sessionOn(1, { workTabId: 2 }));
    r.progress.current = { everyMs: 5000 };
    r.setOutcome('no_work');
    const t = await r.run(3);
    await keepWriting(r, 90, t);
    expect(r.reviews.filter((j) => j.reason === 'progress').length).toBeGreaterThanOrEqual(14);
  });

  it('sends the problem tab with the first reading only, then again only when it changed', async () => {
    const r = rig(sessionOn(1, { workTabId: 2 }));
    r.progress.current = { everyMs: 5000 };
    const t = await r.run(3);
    const end = await keepWriting(r, 25, t);
    const reads = r.reviews.filter((j) => j.reason === 'progress');
    expect(reads.length).toBeGreaterThanOrEqual(4);
    expect(reads[0].problem?.tabId).toBe(1);
    expect(reads.slice(1).every((j) => j.problem === null && j.separate)).toBe(true); // the model has seen it: no image tokens spent
    draw(1, 0.03); // the homework page changes
    await r.run(3, end, 3); // a snapshot sees it
    await keepWriting(r, 12, end + 3000);
    const later = r.reviews.filter((j) => j.reason === 'progress').slice(reads.length);
    expect(later.some((j) => j.problem?.tabId === 1)).toBe(true);
  });

  it('with one tab, there is no separate problem tab to leave out', async () => {
    const r = rig(sessionOn(1));
    r.progress.current = { everyMs: 5000 };
    const t = await r.run(3);
    r.m.noteDom(1, 0, stats({ keyTotal: 0 }), t);
    let keys = 0;
    for (let i = 0; i < 20; i++) {
      keys += 6;
      r.m.noteDom(1, 0, stats({ keyTotal: keys }), t + (i + 1) * 1000);
      await r.run(1, t + (i + 1) * 1000, 1);
    }
    const reads = r.reviews.filter((j) => j.reason === 'progress');
    expect(reads.length).toBeGreaterThanOrEqual(3);
    expect(reads.every((j) => !j.separate && j.problem === null)).toBe(true);
  });

  it('a wrong answer that arrives in the middle of all this is still checked promptly', async () => {
    const r = rig(sessionOn(1, { workTabId: 2 }));
    r.progress.current = { everyMs: 5000 };
    const t = await r.run(3);
    const mid = await keepWriting(r, 12, t);
    r.m.noteDom(1, 0, stats({ incorrectTotal: 0 }), mid);
    r.m.noteDom(1, 0, stats({ incorrectTotal: 1 }), mid + 1000);
    r.m.noteDom(2, 0, stats({ pointerTotal: 1000 }), mid + 1000);
    const before = r.reviews.length;
    await r.run(10, mid + 1000, 1);
    const reasons = r.reviews.slice(before).map((j) => j.reason);
    expect(reasons).toContain('wrong-answer');
    expect(reasons.indexOf('wrong-answer')).toBeLessThanOrEqual(1); // among the first things asked, within a few seconds
  });

  it('reports every outcome, so the background can act on "this is a different problem"', async () => {
    const r = rig(sessionOn(1, { workTabId: 2 }));
    r.progress.current = { everyMs: 5000 };
    r.setOutcome('different');
    const t = await r.run(3);
    await keepWriting(r, 12, t);
    expect(r.outcomes.length).toBeGreaterThanOrEqual(2);
    expect(new Set(r.outcomes)).toEqual(new Set(['different']));
  });
});

describe('Monitor: a finished line is read right away', () => {
  async function writeFor(r: Rig, seconds: number, from: number, perSecond = 40) {
    let total = 0;
    let t = from;
    r.m.noteDom(2, 0, stats({ pointerTotal: 0 }), t);
    for (let i = 0; i < seconds; i++) {
      t += 1000;
      total += perSecond;
      r.m.noteDom(2, 0, stats({ pointerTotal: total }), t);
      await r.run(1, t, 1);
    }
    return { t, total };
  }

  it('reads within about two seconds of the student stopping, not at the next periodic read', async () => {
    const r = rig(sessionOn(1, { workTabId: 2 }));
    r.progress.current = { everyMs: 30_000 }; // the periodic read is far away: only the pause can trigger a read
    const start = await r.run(3);
    const first = await writeFor(r, 4, start);
    const before = r.reviews.length;
    // they stop: tick every second and see when the line is read
    let readAt = -1;
    for (let k = 1; k <= 6 && readAt < 0; k++) {
      await r.run(1, first.t + k * 1000, 1);
      if (r.reviews.length > before) readAt = k;
    }
    expect(readAt).toBeGreaterThan(0);
    expect(readAt).toBeLessThanOrEqual(3);
    expect(r.reviews[r.reviews.length - 1]).toMatchObject({ reason: 'progress' });
    expect(r.reviews[r.reviews.length - 1].detail).toMatch(/finished a line|writing: reading what is new/);
  });

  it('says how long the student had been still when the picture was taken', async () => {
    const r = rig(sessionOn(1, { workTabId: 2 }));
    r.progress.current = { everyMs: 30_000 };
    const start = await r.run(3);
    const first = await writeFor(r, 3, start);
    await r.run(4, first.t, 1);
    const job = r.reviews.find((j) => j.detail.includes('finished a line'));
    expect(job).toBeTruthy();
    expect(job!.idleMs).not.toBeNull();
    expect(job!.idleMs!).toBeGreaterThanOrEqual(0);
  });

  it('looks again once the student is still when a reading asks for it (a copy that may be unfinished)', async () => {
    const r = rig(sessionOn(1, { workTabId: 2 }));
    r.progress.current = { everyMs: 30_000 };
    const start = await r.run(3);
    const first = await writeFor(r, 3, start);
    await r.run(4, first.t, 1); // the line is read
    const after = r.reviews.length;
    r.m.requestSettledRead();
    await r.run(8, first.t + 4000, 1);
    expect(r.reviews.length).toBe(after + 1);
    expect(r.reviews[after].detail).toMatch(/copied/);
    // and only once
    await r.run(20, first.t + 12_000, 1);
    expect(r.reviews.length).toBe(after + 1);
  });

  it('does nothing at all without continuous reading', async () => {
    const r = rig(sessionOn(1, { workTabId: 2 }));
    const start = await r.run(3);
    const first = await writeFor(r, 3, start);
    await r.run(10, first.t, 1);
    expect(r.reviews.filter((j) => j.reason === 'progress')).toHaveLength(0);
  });
});

describe('Monitor: the homework page says the answer is correct', () => {
  it('ends the asking for good and says so, instead of asking the model about work the page already confirmed', async () => {
    const r = rig(sessionOn(1));
    r.progress.current = { everyMs: 5000 };
    await r.run(6);
    r.m.noteDom(1, 0, stats({ correctTotal: 0 }));
    r.m.noteDom(1, 0, stats({ correctTotal: 1 }));
    await r.run(3, undefined, 1);
    expect(r.solvedByPage.n).toBe(1);
    expect(r.m.checkedSinceLastWork()).toBe(true); // so moving on does not offer a check of a confirmed answer
    const calls = r.reviews.length;
    r.m.noteDom(1, 0, stats({ correctTotal: 1, keyTotal: 300, incorrectTotal: 3 }));
    await r.run(60, undefined, 1);
    expect(r.reviews.length).toBe(calls);
  });
});

describe('Monitor: timing is not rounded to the snapshot grid', () => {
  it('decides "finished" about when the idle time is up, not up to a snapshot later', async () => {
    const r = rig(sessionOn(1, { workTabId: 2 }));
    r.finish.current = { idleMs: 8000, calmBelow: 35 };
    r.score.value = 10;
    const t = await r.run(18, undefined, 3); // a settled session (older than the 15 s minimum)
    r.m.noteDom(2, 0, stats({ pointerTotal: 0 }), t);
    await r.run(1, t, 1);
    r.m.noteDom(2, 0, stats({ pointerTotal: 400 }), t + 2000); // the last strokes
    await r.run(1, t + 1000, 1);
    await r.run(1, t + 2000, 1); // this tick sees the strokes
    const last = t + 2000;
    let at = -1;
    for (let sec = 1; sec <= 20 && at < 0; sec++) {
      await r.run(1, last + sec * 1000, 1);
      if (r.reviews.some((j) => j.reason === 'finished')) at = sec;
    }
    const idleWhenChecked = at + 1; // each loop pass pumps one second after `last`
    expect(idleWhenChecked).toBeGreaterThanOrEqual(8); // never before the idle time is up
    expect(idleWhenChecked).toBeLessThanOrEqual(9); // and right after it (on the 3 s grid this would have been 9 to 12)
  });
});

describe('Monitor: two tabs', () => {
  const typing = (m: Monitor, tab: number, keys: number) => {
    m.noteDom(tab, 0, stats({ keyTotal: 0 }), T0);
    m.noteDom(tab, 0, stats({ keyTotal: keys }), T0 + 30_000);
  };

  it('finds the tab where the student is typing and reports it', async () => {
    const r = rig(sessionOn(1));
    await r.run(6);
    typing(r.m, 2, 60);
    await r.run(6, T0 + 30_000);
    expect(r.workTabs).toEqual([2]);
  });

  it('sends the work tab and the problem tab together, and boxes against the work', async () => {
    const r = rig(sessionOn(1, { workTabId: 2 }));
    await r.run(6);
    draw(2, 0.02); // the student writes in their document
    r.m.noteDom(1, 0, stats());
    r.m.noteDom(1, 0, stats({ incorrectTotal: 1 })); // and the homework page says wrong
    await r.run(12);
    expect(r.reviews).toHaveLength(1);
    expect(r.reviews[0].work.tabId).toBe(2);
    expect(r.reviews[0].problem?.tabId).toBe(1);
  });

  it('captures a second window without focusing it, and shows both tabs', async () => {
    const r = rig(sessionOn(1, { workTabId: 2 }));
    await r.run(6);
    const s = await r.m.stats();
    expect(s.tabs.map((t) => [t.tabId, t.role])).toEqual([[1, 'problem'], [2, 'work']]);
    expect(s.tabs[1].host).toBe('docs.google.com');
  });

  it('leaves a pinned work tab alone', async () => {
    const r = rig(sessionOn(1, { workTabId: 2, workPinned: true }));
    fx.tabs.push({ id: 3, windowId: 3, url: 'https://notes.example/p', title: 'notes', active: true });
    fx.screens.set(3, blank());
    await r.run(6);
    typing(r.m, 3, 200);
    await r.run(12, T0 + 30_000);
    expect(r.workTabs).toEqual([]);
  });

  it('sums typing across a tab\'s frames (Google Docs types inside an iframe)', async () => {
    const r = rig(sessionOn(1));
    await r.run(6);
    r.m.noteDom(2, 0, stats(), T0);
    r.m.noteDom(2, 7, stats(), T0);
    r.m.noteDom(2, 7, stats({ keyTotal: 50 }), T0 + 30_000);
    await r.run(6, T0 + 30_000);
    expect(r.workTabs).toEqual([2]);
  });
});

describe('Monitor: what the model and the student are shown', () => {
  it('always gives the tutor the current work screen, even when nothing seems to have changed', async () => {
    // Handwriting is a tiny fraction of a screen: "unchanged" can't be trusted to mean "nothing new was written".
    const r = rig(sessionOn(1));
    await r.m.snapshotNow();
    expect(r.m.forTutor().work?.jpeg).toBe('jpeg-1-v0');
    expect(r.m.forTutor().work?.jpeg).toBe('jpeg-1-v0');
    draw(1, 0.0004); // a few pen strokes: below the pixel noise floor
    await r.m.snapshotNow();
    expect(r.m.forTutor().work?.jpeg).toBe('jpeg-1-v1');
  });

  it('only re-sends the problem tab when it changed since the model last saw it', async () => {
    const r = rig(sessionOn(1, { workTabId: 2 }));
    await r.m.snapshotNow();
    expect(r.m.forTutor().problem?.tabId).toBe(1); // first look at it
    await r.m.snapshotNow();
    expect(r.m.forTutor().problem).toBeNull(); // unchanged: no image tokens spent on it
    draw(1, 0.03); // the homework page now shows "Incorrect"
    await r.m.snapshotNow();
    expect(r.m.forTutor().problem?.tabId).toBe(1);
  });

  it('does not re-attach the problem tab just because the gate started ticking', async () => {
    const r = rig(sessionOn(1, { workTabId: 2 }));
    await r.m.snapshotNow();
    expect(r.m.forTutor().problem).not.toBeNull();
    await r.run(6); // the first ticks of the session
    await r.m.snapshotNow();
    expect(r.m.forTutor().problem).toBeNull();
  });

  it('starts from scratch for a new session', async () => {
    const r = rig(sessionOn(1, { workTabId: 2 }));
    await r.m.snapshotNow();
    expect(r.m.forTutor().problem).not.toBeNull();
    r.session.current = sessionOn(1, { id: 's2', workTabId: 2 });
    expect(r.m.forTutor().problem).not.toBeNull();
  });

  it('includes the problem tab when the work is elsewhere (first time)', async () => {
    const r = rig(sessionOn(1, { workTabId: 2 }));
    await r.m.snapshotNow();
    const f = r.m.forTutor();
    expect(f.work?.tabId).toBe(2);
    expect(f.problem?.tabId).toBe(1);
  });

  it('holds the finished work when the student moves on, ignoring what loads next', async () => {
    const r = rig(sessionOn(1));
    draw(1, 0.03);
    await r.run(6);
    const held = await r.m.freeze(true);
    expect(held?.work.jpeg).toBe('jpeg-1-v1');
    expect(r.m.isFrozen).toBe(true);

    draw(1, 0.3); // the next problem loads
    await r.run(6);
    expect((await r.m.finalFrames())?.work.jpeg).toBe('jpeg-1-v1');
    expect(r.m.forTutor().work?.jpeg).toBe('jpeg-1-v1');
    r.m.unfreeze();
    expect((await r.m.finalFrames())?.work.jpeg).toBe('jpeg-1-v2');
  });

  it('never asks the model while a work check is pending', async () => {
    const r = rig(sessionOn(1));
    await r.run(6);
    await r.m.freeze(false);
    r.m.noteDom(1, 0, stats());
    r.m.noteDom(1, 0, stats({ incorrectTotal: 1 }));
    await r.run(30);
    expect(r.reviews).toHaveLength(0);
  });

  it('summarises itself for the panel', async () => {
    const r = rig(sessionOn(1));
    await r.run(6);
    r.m.noteDom(1, 0, stats());
    r.m.noteDom(1, 0, stats({ incorrectTotal: 1 }));
    const now = await r.run(12);
    const s = await r.m.stats(now);
    expect(s.reviews).toBe(1);
    expect(s.last).toMatchObject({ reason: 'wrong-answer', outcome: 'on_track' });
    expect(s.log.some((l) => /wrong/i.test(l.text))).toBe(true);
    expect(s.gate?.callsInWindow).toBe(1);
  });
});
