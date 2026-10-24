// Tab hopping and "went looking for help" visits, from chrome.tabs events.
// Persisted to storage.session so a service-worker restart doesn't forget them.
import { HELP_SITE_PATTERNS } from '../shared/constants';
import type { Signal } from '../shared/types';

const KEY = 'tabTracker';
const SWITCH_WINDOW_MS = 2 * 60_000;
const HELP_WINDOW_MS = 5 * 60_000;

interface TabState {
  switches: number[];
  helpVisits: { t: number; host: string }[];
}

let state: TabState = { switches: [], helpVisits: [] };
const ready = chrome.storage.session.get(KEY).then((r) => {
  if (r[KEY]) state = r[KEY] as TabState;
});

async function persist() {
  const now = Date.now();
  state.switches = state.switches.filter((t) => now - t < SWITCH_WINDOW_MS);
  state.helpVisits = state.helpVisits.filter((v) => now - v.t < HELP_WINDOW_MS);
  await chrome.storage.session.set({ [KEY]: state });
}

export function startTabTracker(): void {
  chrome.tabs.onActivated.addListener(async () => {
    await ready;
    state.switches.push(Date.now());
    await persist();
  });
  chrome.tabs.onUpdated.addListener(async (_id, info) => {
    if (!info.url) return;
    await ready;
    if (HELP_SITE_PATTERNS.some((re) => re.test(info.url!))) {
      state.helpVisits.push({ t: Date.now(), host: new URL(info.url).hostname.replace(/^www\./, '') });
      await persist();
    }
  });
}

export function tabSignals(now = Date.now()): Signal[] {
  const switches = state.switches.filter((t) => now - t < SWITCH_WINDOW_MS).length;
  const help = state.helpVisits.filter((v) => now - v.t < HELP_WINDOW_MS);
  const switchV = Math.min(1, Math.max(0, (switches - 3) / 8));
  const helpV = Math.min(1, help.length * 0.6);
  if (helpV === 0 && switchV === 0) return [];
  const reason =
    helpV >= switchV ? `looked for help on ${help[help.length - 1].host}` : `switched tabs ×${switches} in 2 min`;
  return [{ id: 'tabHopping', value: Math.max(switchV, helpV), reason }];
}
