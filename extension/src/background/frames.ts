// Captures a tab (no user gesture needed: the extension has <all_urls>) and shrinks it. Runs in the
// service worker, so it uses OffscreenCanvas rather than the DOM.
//
// chrome.tabs.captureVisibleTab only sees the active tab of a window, but it takes a window id, so
// the active tab of any window can be captured without focusing it (a second window beside the
// homework works). Chrome allows two captures a second across the whole extension, so every capture
// goes through one pacing queue.
import { FRAME_MAX_WIDTH, NEVER_CAPTURE } from '../shared/constants';
import { bytesToBase64, changedFraction, GRAY_W, toGray, type Gray } from './frameDiff';

export interface Frame {
  /** Base64 JPEG without the data: prefix (what the model API wants). */
  jpeg: string;
  at: number;
  tabId: number;
  windowId: number;
  url: string;
  title: string;
  /** Fraction of the screen that changed since the previous frame of this tab (1 for the first). */
  changed: number;
}

export interface Captured {
  frame: Frame;
  gray: Gray;
}

const CAPTURABLE = /^(https?|file):/;
/** Two captures a second are allowed; stay a little under. */
const CAPTURE_GAP_MS = 520;

export function capturable(tab: chrome.tabs.Tab | undefined): tab is chrome.tabs.Tab & { id: number; url: string } {
  return !!tab?.id && !!tab.url && CAPTURABLE.test(tab.url) && !NEVER_CAPTURE.some((re) => re.test(tab.url!));
}

export async function activeTab(windowId?: number): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query(windowId === undefined ? { active: true, lastFocusedWindow: true } : { active: true, windowId });
  return tab;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let chain: Promise<unknown> = Promise.resolve();
let lastCaptureAt = 0;

/** Runs one capture at a time, at least CAPTURE_GAP_MS after the previous one. */
function paced<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    const wait = CAPTURE_GAP_MS - (Date.now() - lastCaptureAt);
    if (wait > 0) await sleep(wait);
    lastCaptureAt = Date.now();
    return fn();
  });
  chain = run.catch(() => undefined);
  return run;
}

/** A capture that never comes back (a window Chrome isn't painting) must not hold up every later capture behind it. */
const CAPTURE_TIMEOUT_MS = 8000;
const withTimeout = <T,>(p: Promise<T>, ms: number): Promise<T> =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('capture timed out')), ms))]);

/** Null on pages Chrome won't let extensions capture (chrome://, the Web Store, …), pages on the never-capture list, or any failure. */
export async function captureTab(tab: chrome.tabs.Tab | undefined, prev: Gray | null = null): Promise<Captured | null> {
  if (!capturable(tab)) return null;
  try {
    const dataUrl = await paced(() => withTimeout(chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 80 }), CAPTURE_TIMEOUT_MS));
    const { jpeg, gray } = await prepare(dataUrl);
    return { frame: { jpeg, at: Date.now(), tabId: tab.id, windowId: tab.windowId, url: tab.url, title: tab.title ?? '', changed: changedFraction(prev, gray) }, gray };
  } catch {
    return null;
  }
}

/** A small JPEG data URL of a base64 JPEG, for showing in the panel. */
export async function thumbnail(jpeg: string, width = 520): Promise<string> {
  const bitmap = await createImageBitmap(await (await fetch(`data:image/jpeg;base64,${jpeg}`)).blob());
  try {
    const scale = Math.min(1, width / bitmap.width);
    const c = new OffscreenCanvas(Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.round(bitmap.height * scale)));
    c.getContext('2d')!.drawImage(bitmap, 0, 0, c.width, c.height);
    const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.7 });
    return `data:image/jpeg;base64,${bytesToBase64(new Uint8Array(await blob.arrayBuffer()))}`;
  } finally {
    bitmap.close();
  }
}

async function prepare(dataUrl: string): Promise<{ jpeg: string; gray: Gray }> {
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  try {
    const scale = Math.min(1, FRAME_MAX_WIDTH / bitmap.width);
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const big = new OffscreenCanvas(w, h);
    big.getContext('2d')!.drawImage(bitmap, 0, 0, w, h);
    const blob = await big.convertToBlob({ type: 'image/jpeg', quality: 0.8 });

    const gh = Math.max(1, Math.round((bitmap.height / bitmap.width) * GRAY_W));
    const small = new OffscreenCanvas(GRAY_W, gh);
    const g = small.getContext('2d', { willReadFrequently: true })!;
    g.drawImage(bitmap, 0, 0, GRAY_W, gh);
    return {
      jpeg: bytesToBase64(new Uint8Array(await blob.arrayBuffer())),
      gray: { data: toGray(g.getImageData(0, 0, GRAY_W, gh).data), w: GRAY_W, h: gh },
    };
  } finally {
    bitmap.close();
  }
}
