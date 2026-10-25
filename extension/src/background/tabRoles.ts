// Which tab is the student's WORK tab? The problem tab is where the session started. The work tab is the other tab where they
// write their solution. myTA never decides that from one clue: each tab is scored from several independent indicators (see
// shared/pageRole.ts): is the site a known drawing board or document editor, is the page a canvas with drawing tools or a big
// writing area, is the student typing or drawing on it. A homework site is never taken for a work tab, whatever is typed in
// it. Search and chat tabs count as "looking for help", not as work. A pin from the panel always wins, so an app myTA can't
// recognise can still be chosen by hand.
import { HELP_SITE_PATTERNS, NEVER_CAPTURE } from '../shared/constants';
import { roleOf, scoreRole, whyText, type PageRole, type RoleHints, type RoleScore } from '../shared/pageRole';

/** How far back "recent" typing reaches. */
export const WORK_WINDOW_MS = 90_000;
/** Less input than this in the window and a tab isn't a work tab on typing alone (a few stray keys or clicks). */
export const MIN_WORK_INPUT = 8;
/** A lot of input: a person is plainly writing here. */
export const STRONG_WORK_INPUT = 40;
/** Pen/mouse drag events are dense, so each counts for a quarter of a keystroke. */
export const POINTER_WEIGHT = 0.25;
/** How sure the indicators must be before a tab is taken as the work tab. */
export const SURE = 0.5;
/** A tab with no input yet is only taken as the work tab (on its site and structure alone) while the student has had it on screen this recently. */
const SEEN_MS = 60_000;
/** A new tab must out-type the current work tab by this factor, or out-score it by `SWITCH_MARGIN`, to take over. */
const SWITCH_FACTOR = 2;
const SWITCH_MARGIN = 0.2;

interface Sample {
  t: number;
  keys: number;
  pointer: number;
}

export interface TabCandidate {
  tabId: number;
  url: string;
  title?: string;
}

/** A tab's scores, what it looks like, how sure, and why: for choosing the work tab and for showing the student the reasons. */
export interface RoleAssessment extends RoleScore {
  looksLike: PageRole;
  confidence: number;
  why: string[];
  input: number;
}

export class TabRoles {
  private samples = new Map<number, Sample[]>();
  private hints = new Map<number, { hints: RoleHints; at: number }>();

  /** Feed each tab's running totals (they only ever grow within a page; a smaller number means the page reloaded). */
  record(tabId: number, now: number, keys: number, pointer: number): void {
    const list = this.samples.get(tabId) ?? [];
    const last = list.at(-1);
    if (last && (keys < last.keys || pointer < last.pointer)) list.length = 0; // new page in this tab: totals restarted
    list.push({ t: now, keys, pointer });
    while (list.length > 1 && now - list[1].t > WORK_WINDOW_MS) list.shift();
    this.samples.set(tabId, list);
  }

  /** What the tab's page looks like, as measured in the page (a canvas and drawing tools, or answer boxes and a Check button). */
  recordHints(tabId: number, hints: RoleHints, now: number): void {
    this.hints.set(tabId, { hints, at: now });
  }

  /** Typing plus quarter-weighted pen/mouse drags in the last WORK_WINDOW_MS (a stroke is dozens of events). */
  recentInput(tabId: number, now: number): number {
    const list = this.samples.get(tabId);
    if (!list?.length) return 0;
    const last = list.at(-1)!;
    if (now - last.t > WORK_WINDOW_MS) return 0;
    const first = list.find((s) => now - s.t <= WORK_WINDOW_MS) ?? list[0];
    return Math.max(0, last.keys - first.keys) + POINTER_WEIGHT * Math.max(0, last.pointer - first.pointer);
  }

  forget(tabId: number): void {
    this.samples.delete(tabId);
    this.hints.delete(tabId);
  }

  /** Scores one tab on every indicator: its site, its structure, and what the student does there. */
  assess(tabId: number, url: string, title: string, now: number): RoleAssessment {
    const input = this.recentInput(tabId, now);
    const s = scoreRole(url, title, this.hints.get(tabId)?.hints ?? null, { recent: input, min: MIN_WORK_INPUT, strong: STRONG_WORK_INPUT });
    const looksLike = roleOf(s, SURE);
    return { ...s, looksLike, confidence: looksLike === 'work' ? s.work : looksLike === 'problem' ? s.problem : Math.max(s.work, s.problem), why: whyText(looksLike, s), input };
  }

  /** The best work tab among `candidates` (never the problem tab), or null. Keeps `current` unless another clearly out-works it. */
  pickWork(candidates: TabCandidate[], problemTabId: number | null, current: number | null, now: number): number | null {
    const eligible = candidates.filter((c) => c.tabId !== problemTabId && /^(https?|file):/.test(c.url) && !HELP_SITE_PATTERNS.some((re) => re.test(c.url)) && !NEVER_CAPTURE.some((re) => re.test(c.url)));
    const scored = eligible.map((c) => {
      const a = this.assess(c.tabId, c.url, c.title ?? '', now);
      const seenAt = this.hints.get(c.tabId)?.at ?? 0;
      // Without anything typed or drawn there yet, a tab only counts while the student has had it on screen a moment ago:
      // an old document tab left open from earlier must not become the work tab on its looks alone.
      const inView = a.input >= MIN_WORK_INPUT || now - seenAt <= SEEN_MS;
      const ok = inView && a.looksLike === 'work';
      return { id: c.tabId, score: ok ? a.work : 0, input: a.input };
    });
    let best: (typeof scored)[number] | null = null;
    for (const c of scored) if (c.score >= SURE && (!best || c.score > best.score || (c.score === best.score && c.input > best.input))) best = c;
    const cur = current === null ? undefined : scored.find((c) => c.id === current);
    if (cur && (!best || best.id === cur.id)) return current;
    if (cur && best) {
      const overtakes = best.score >= cur.score + SWITCH_MARGIN || (best.input >= MIN_WORK_INPUT && best.input > cur.input * SWITCH_FACTOR);
      if (!overtakes) return current;
    }
    return best?.id ?? (cur ? current : null);
  }
}
