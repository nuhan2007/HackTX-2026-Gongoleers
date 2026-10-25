import { DEFAULT_MODEL, DEMO_TRIGGER, NORMAL_TRIGGER, type TriggerConfig } from './constants';
import type { CalibrationBaseline } from './types';

export interface Settings {
  openaiKey: string;
  serpKey: string;
  model: string;
  enabled: boolean;
  demoMode: boolean;
  devMode: boolean; // shows "Force trigger"
  labelMode: boolean;
  threshold: number;
  durationSec: number;
  cooldownSec: number;
  cameraGranted: boolean;
  calibration: CalibrationBaseline | null;
  snoozedUntil: number;
  settingsVersion: number;
}

const SETTINGS_VERSION = 6;

export const DEFAULT_SETTINGS: Settings = {
  openaiKey: '',
  serpKey: '',
  model: DEFAULT_MODEL,
  enabled: true,
  demoMode: false,
  devMode: false,
  labelMode: false,
  ...NORMAL_TRIGGER,
  cameraGranted: false,
  calibration: null,
  snoozedUntil: 0,
  settingsVersion: SETTINGS_VERSION,
};

const KEY = 'settings';

/** Only OpenAI chat models work here; anything else (e.g. a leftover value from an older version) falls back. */
export const validModel = (m: string): string => (/^(gpt|o\d|chatgpt)/i.test(m ?? '') ? m : DEFAULT_MODEL);

export async function getSettings(): Promise<Settings> {
  const { [KEY]: stored } = (await chrome.storage.local.get(KEY)) as { [KEY]?: Partial<Settings> };
  const s: Settings = { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
  if (stored && (stored.settingsVersion ?? 1) < SETTINGS_VERSION) {
    // Retuned defaults (the old ones were too hard to reach); anyone who customised a value keeps it.
    const old = [{ threshold: 60, durationSec: 45, cooldownSec: 180 }, { threshold: 40, durationSec: 45, cooldownSec: 180 }, { threshold: 35, durationSec: 20, cooldownSec: 120 }];
    if (old.some((o) => o.threshold === stored.threshold && o.durationSec === stored.durationSec && o.cooldownSec === stored.cooldownSec))
      Object.assign(s, NORMAL_TRIGGER);
    // v5 switched AI providers: drop any saved key/option we no longer know about, and reset an unusable model.
    for (const k of Object.keys(s)) if (!(k in DEFAULT_SETTINGS)) delete (s as unknown as Record<string, unknown>)[k];
    // v6 moved the default model; anyone still on the old default follows it, a custom choice stays.
    s.model = stored.model === 'gpt-5-mini' ? DEFAULT_SETTINGS.model : validModel(s.model);
    s.settingsVersion = SETTINGS_VERSION;
    await chrome.storage.local.set({ [KEY]: s });
  }
  return s;
}

export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}

export function onSettingsChanged(cb: (s: Settings) => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[KEY]) cb({ ...DEFAULT_SETTINGS, ...(changes[KEY].newValue as Partial<Settings>) });
  });
}

export function triggerConfig(s: Settings): TriggerConfig {
  return s.demoMode ? DEMO_TRIGGER : { threshold: s.threshold, durationSec: s.durationSec, cooldownSec: s.cooldownSec };
}

/** Tracking only runs once onboarding is complete: both keys plus a granted, calibrated camera. */
export function readiness(s: Settings): { ready: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!s.openaiKey) missing.push('OpenAI API key');
  if (!s.serpKey) missing.push('SerpApi key');
  if (!s.cameraGranted) missing.push('camera access');
  if (!s.calibration) missing.push('camera calibration');
  return { ready: missing.length === 0, missing };
}
