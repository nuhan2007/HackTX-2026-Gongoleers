// Local-only metrics: numbers, timings and concept names. Nothing here leaves the device.
import type { EvalResults, Stats } from '../shared/messages';
import type { SessionSummary } from '../shared/types';
import evalResults from '../shared/evalResults.json';

const SUMMARIES = 'sessionSummaries';
const CONCEPTS = 'conceptHistory';

export async function recordSummary(s: SessionSummary): Promise<void> {
  const { [SUMMARIES]: list = [] } = await chrome.storage.local.get(SUMMARIES);
  await chrome.storage.local.set({ [SUMMARIES]: [...(list as SessionSummary[]), s].slice(-500) });
  if (s.concepts.length) {
    const { [CONCEPTS]: hist = {} } = await chrome.storage.local.get(CONCEPTS);
    for (const c of s.concepts) (hist as Record<string, number>)[c.toLowerCase()] = ((hist as Record<string, number>)[c.toLowerCase()] ?? 0) + 1;
    await chrome.storage.local.set({ [CONCEPTS]: hist });
  }
}

/** How many earlier sessions involved this concept (used to offer practice links). */
export async function conceptCount(concept: string): Promise<number> {
  const { [CONCEPTS]: hist = {} } = await chrome.storage.local.get(CONCEPTS);
  return (hist as Record<string, number>)[concept.toLowerCase()] ?? 0;
}

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export async function getStats(): Promise<Stats> {
  const { [SUMMARIES]: list = [] } = await chrome.storage.local.get(SUMMARIES);
  const sessions = list as SessionSummary[];
  const times = sessions.filter((s) => s.solved && s.timeToUnstuckSec !== null).map((s) => s.timeToUnstuckSec!);
  return {
    sessions: sessions.slice(-20).reverse(),
    medianTimeToUnstuckSec: median(times),
    solvedRate: sessions.length ? sessions.filter((s) => s.solved).length / sessions.length : null,
    eval: evalResults as EvalResults,
  };
}
