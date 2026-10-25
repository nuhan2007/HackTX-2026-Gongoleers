// Decides when the student has settled on a problem, and when they have moved on to another one, so myTA can start
// following a problem without anybody clicking anything. It is pure: the background tells it what each page reports
// (which problem, since when) and acts on what it answers. Nothing here talks to the model.
//
// A "problem" is a page plus the question on it (the page's own "Q4" label, or its title when it has none), so moving to
// the next question of a quiz, or to another page of the homework, is a different problem.
import { AUTO_START_BUDGET, AUTO_START_DWELL_MS, HELP_SITE_PATTERNS, MOVED_ON_AFTER_MS } from '../shared/constants';
import type { PageContext } from '../shared/messages';
import { roleOf, scoreRole } from '../shared/pageRole';

const NUMBERED_QUESTION = /^(Q\d|Problem \d|Exercise \d)/;
/** A page that stops reporting for this long isn't being looked at (switched away, or closed). */
const GAP_MS = 4_000;
/** Pages with less visible text than this aren't a problem (a blank tab, a login box). */
const MIN_PROBLEM_TEXT = 60;

/**
 * The page (without its #fragment) plus the numbered question on it ("Q4", "Problem 2"), or null for a page that can't be
 * identified. Only numbered labels count: the page's other "labels" are whatever heading or field label sits nearest
 * the last thing typed in ("Your answer"), and would make typing look like moving to a different problem.
 */
export function problemKey(url: string | undefined, label: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    const q = (label ?? '').trim();
    return `${u.origin}${u.pathname}${u.search}|${NUMBERED_QUESTION.test(q) ? q : ''}`;
  } catch {
    return null;
  }
}

/** The numbered question in a key ("Q4"), or "" for a page-level key. */
export const labelOf = (key: string): string => key.slice(key.indexOf('|') + 1);

/** The page part of a key. */
const pageOf = (key: string): string => key.slice(0, key.indexOf('|'));

/**
 * Does this page show several numbered questions ("Q3" and "Q4" both on screen)? Then which one the student is working
 * on is not known until they touch one, and myTA waits rather than guess and check their work against the wrong problem.
 */
export function severalQuestions(text: string): boolean {
  const numbers = new Set<string>();
  for (const m of text.matchAll(/\b(?:Question|Q|Problem|Exercise)\s*#?\s*(\d+)\b/gi)) numbers.add(m[1]);
  return numbers.size >= 2;
}

/** A numbered question ("Q4") is strong evidence of a problem, whatever else is on the page. */
export const isNumbered = (key: string): boolean => labelOf(key) !== '';

/** The problem's name for saying out loud: its number ("Q4") if the page numbers its questions, else the page's title. */
export function displayLabel(ctx: Pick<PageContext, 'question' | 'title'> | null | undefined): string {
  if (ctx?.question && NUMBERED_QUESTION.test(ctx.question)) return ctx.question;
  return (ctx?.title ?? '').trim().slice(0, 40) || 'this problem';
}

/**
 * Cheap local check, before any model call: a page with a question label, or with something to answer in. A page that is
 * plainly a drawing board or a document (judged from several indicators, see pageRole) is where the student WRITES, not where
 * the problem is, even though its text area looks like an answer box. A page that is plainly a homework page is a problem.
 */
export function looksLikeProblem(ctx: Pick<PageContext, 'url' | 'viewportText' | 'question' | 'fields' | 'title' | 'roleHints'>): boolean {
  if (HELP_SITE_PATTERNS.some((re) => re.test(ctx.url))) return false;
  if ((ctx.viewportText ?? '').length < MIN_PROBLEM_TEXT) return false;
  const numbered = NUMBERED_QUESTION.test(ctx.question ?? '');
  if (ctx.roleHints) {
    const a = scoreRole(ctx.url, ctx.title ?? '', ctx.roleHints, { recent: 0, min: Infinity, strong: Infinity });
    const role = roleOf(a);
    if (role === 'work' && !numbered) return false;
    if (role === 'problem') return true;
  }
  return (ctx.fields ?? 0) > 0 || numbered;
}

export interface TrackedSession {
  key: string | null;
  tabId: number | null;
}

export interface TrackContext {
  now: number;
  /** The tab the student is looking at (the focused window's active tab). */
  focusedTabId: number | null;
  /** May myTA start something right now? (set up, switched on, not snoozed, nothing else in the way) */
  canStart: boolean;
  session: TrackedSession | null;
  /** The student sent this problem away ("Not now") or finished it: don't start it again. */
  declined(key: string): boolean;
}

export type TrackDecision =
  | { kind: 'none' }
  /** The student has stayed on a problem long enough: work it out and follow it. */
  | { kind: 'start'; tabId: number; key: string }
  /** The session's tab is showing a different problem now (reported once). */
  | { kind: 'moved'; key: string }
  /** The page the session started on (when it named no question) now says which question the student is on: same problem, named. */
  | { kind: 'refine'; key: string }
  /** …and it is back on the session's problem. */
  | { kind: 'back' };

interface Seen {
  key: string;
  since: number;
  seenAt: number;
}

export type Rejection = 'not-a-problem' | 'several';

export class ProblemTracker {
  private tabs = new Map<number, Seen>();
  /** Problems that turned out not to be (or can't yet be) problems, until when, and why. */
  private rejected = new Map<string, { until: number; why: Rejection }>();
  private starts: number[] = [];
  private movedFor: string | null = null;

  constructor(private dwellMs = AUTO_START_DWELL_MS, private budget = AUTO_START_BUDGET) {}

  /** What a tab's content script reports each second: the problem it is showing. */
  observe(tabId: number, key: string | null, now: number): void {
    if (key === null) return void this.tabs.delete(tabId);
    const t = this.tabs.get(tabId);
    const continuing = t && t.key === key && now - t.seenAt <= GAP_MS;
    this.tabs.set(tabId, { key, since: continuing ? t.since : now, seenAt: now });
  }

  forget(tabId: number): void {
    this.tabs.delete(tabId);
  }

  /** Stop treating this problem as a candidate for a while (not a problem, the model couldn't find one, or the page has several and none is picked). */
  reject(key: string, now: number, forMs: number, why: Rejection = 'not-a-problem'): void {
    this.rejected.set(key, { until: now + forMs, why });
  }

  isRejected(key: string, now: number): boolean {
    return (this.rejected.get(key)?.until ?? 0) > now;
  }

  rejectedWhy(key: string, now: number): Rejection | null {
    return this.isRejected(key, now) ? this.rejected.get(key)!.why : null;
  }

  /** An automatic start was made: counts toward the budget. */
  started(now: number): void {
    this.starts.push(now);
  }

  /** A different session began or ended: "moved on" is measured against the new one. */
  sessionChanged(): void {
    this.movedFor = null;
  }

  /** The problem the student is settling on, for the panel: how long they've been on it. */
  candidate(ctx: Pick<TrackContext, 'now' | 'focusedTabId'>): { tabId: number; key: string; forMs: number } | null {
    const c = ctx.focusedTabId === null ? undefined : this.tabs.get(ctx.focusedTabId);
    if (!c || ctx.now - c.seenAt > GAP_MS) return null;
    return { tabId: ctx.focusedTabId!, key: c.key, forMs: ctx.now - c.since };
  }

  decide(ctx: TrackContext): TrackDecision {
    const { now, session } = ctx;

    // 1. Is the session's own tab still on the session's problem?
    if (session?.key && session.tabId !== null) {
      const t = this.tabs.get(session.tabId);
      if (t && now - t.seenAt <= GAP_MS) {
        if (t.key !== session.key && now - t.since >= MOVED_ON_AFTER_MS) {
          // The session began on a page that named no question, and the page now names one: that is the same problem, not a new one.
          if (labelOf(session.key) === '' && labelOf(t.key) !== '' && pageOf(session.key) === pageOf(t.key)) return { kind: 'refine', key: t.key };
          if (this.movedFor !== t.key) {
            this.movedFor = t.key;
            return { kind: 'moved', key: t.key };
          }
        }
        if (t.key === session.key && this.movedFor !== null) {
          this.movedFor = null;
          return { kind: 'back' };
        }
      }
    }

    // 2. Has the student settled on a problem myTA isn't following yet?
    if (!ctx.canStart) return { kind: 'none' };
    const c = this.candidate(ctx);
    if (!c || c.forMs < this.dwellMs) return { kind: 'none' };
    if (session?.key === c.key || ctx.declined(c.key)) return { kind: 'none' };
    if (this.isRejected(c.key, now)) return { kind: 'none' };
    // With a problem already followed, only its own tab, or a clearly numbered question elsewhere, replaces it. (A document
    // or sketchpad where the student writes their work can look like a page with a box to type in.)
    if (session && c.tabId !== session.tabId && !isNumbered(c.key)) return { kind: 'none' };
    this.starts = this.starts.filter((t) => now - t < this.budget.windowMs);
    if (this.starts.length >= this.budget.max) return { kind: 'none' };
    return { kind: 'start', tabId: c.tabId, key: c.key };
  }
}
