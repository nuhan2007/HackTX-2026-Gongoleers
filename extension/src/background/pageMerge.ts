// What the confusion engine sees of the open pages. Activity (re-reading, idling, backspace bursts) comes
// from the tab the student is in right now. Content cues (a wrong answer, a repeated error) are
// different: they describe the PROBLEM, so they keep counting while the student works in another tab,
// fading out over a few minutes. Without this the score collapses the moment they switch to their work.
import { PAGE_STALE_MS } from '../shared/constants';
import type { PageSignals, Signal } from '../shared/types';

export interface FrameReport {
  signals: PageSignals;
  at: number;
}
export type TabReports = Map<number, Map<number, FrameReport>>;

/** How long a content cue from a tab the student has left keeps counting (it fades linearly). */
export const CARRY_MS = 5 * 60_000;

/** The strongest signal of each kind across the given lists. */
function strongest(lists: Signal[][]): Signal[] {
  const best = new Map<string, Signal>();
  for (const s of lists.flat()) if (!best.has(s.id) || best.get(s.id)!.value < s.value) best.set(s.id, s);
  return [...best.values()];
}

export function mergePage(tabs: TabReports, activeTabId: number | null, now: number): PageSignals | null {
  const fresh = [...(activeTabId === null ? [] : (tabs.get(activeTabId)?.values() ?? []))].filter((f) => now - f.at < PAGE_STALE_MS);

  const carried: { signals: Signal[]; label: string }[] = [];
  for (const [tabId, byFrame] of tabs) {
    if (tabId === activeTabId) continue;
    for (const f of byFrame.values()) {
      const fade = 1 - (now - f.at) / CARRY_MS;
      if (fade <= 0 || !f.signals.content.length) continue;
      carried.push({ signals: f.signals.content.map((s) => ({ ...s, value: s.value * fade })), label: f.signals.questionLabel });
    }
  }
  if (!fresh.length && !carried.length) return null;

  const withContent = fresh.find((f) => f.signals.content.length) ?? fresh[0];
  return {
    content: strongest([...fresh.map((f) => f.signals.content), ...carried.map((c) => c.signals)]),
    activity: strongest(fresh.map((f) => f.signals.activity)),
    // The timers belong to the tab the student is in; with none fresh there is nothing to time.
    idleMs: fresh.length ? Math.min(...fresh.map((f) => f.signals.idleMs)) : 0,
    dwellMs: fresh.length ? Math.min(...fresh.map((f) => f.signals.dwellMs)) : 0,
    questionLabel: withContent?.signals.questionLabel ?? carried[0]?.label ?? '',
  };
}
