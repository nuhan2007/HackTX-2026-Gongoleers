import { DEFAULT_MODEL, DEMO_TRIGGER, NORMAL_TRIGGER, type TriggerConfig } from './constants';
import type { CalibrationBaseline } from './types';

export interface Settings {
  geminiKey: string;
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
}

export const DEFAULT_SETTINGS: Settings = {
  geminiKey: '',
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
};

const KEY = 'settings';

export async function getSettings(): Promise<Settings> {
  const { [KEY]: stored } = await chrome.storage.local.get(KEY);
  return { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
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
  if (!s.geminiKey) missing.push('Gemini API key');
  if (!s.serpKey) missing.push('SerpApi key');
  if (!s.cameraGranted) missing.push('camera access');
  if (!s.calibration) missing.push('camera calibration');
  return { ready: missing.length === 0, missing };
}
