// "Look at the tab" (Copilot-style): an image of what's visible plus what every frame can read
// about itself (text, math, answer fields, work log, drawings). Runs only when the student asks.
import type { Msg, PageContext } from '../shared/messages';

const IMAGE_MAX_W = 1600;
const FRAME_TIMEOUT_MS = 1500;
const MAX_TEXT = 9000;
const MAX_DRAWINGS = 3;

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Visible-tab image, downscaled in the worker with OffscreenCanvas. Null on pages Chrome won't capture. */
export async function captureTabImage(windowId: number): Promise<string | null> {
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 90 });
    const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
    const scale = Math.min(1, IMAGE_MAX_W / bmp.width);
    const canvas = new OffscreenCanvas(Math.round(bmp.width * scale), Math.round(bmp.height * scale));
    canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
    return toBase64(await blob.arrayBuffer());
  } catch {
    return null;
  }
}

function askFrame(tabId: number, frameId: number): Promise<PageContext | null> {
  return Promise.race([
    chrome.tabs.sendMessage(tabId, { type: 'get-page-context' } satisfies Msg, { frameId }).catch(() => null),
    new Promise<null>((r) => setTimeout(() => r(null), FRAME_TIMEOUT_MS)),
  ]);
}

/** Asks every known frame (top first) and merges the answers. Null where no content script runs (PDFs, chrome://). */
export async function readTab(tabId: number, frameIds: number[]): Promise<PageContext | null> {
  const ids = [0, ...frameIds.filter((f) => f !== 0)];
  const parts = (await Promise.all(ids.map((f) => askFrame(tabId, f)))).filter((p): p is PageContext => !!p);
  if (!parts.length) return null;
  const top = parts[0];
  const text = parts
    .map((p, i) => (i === 0 ? p.viewportText : p.viewportText && `[embedded frame ${p.title || p.url}] ${p.viewportText}`))
    .filter(Boolean)
    .join('\n')
    .slice(0, MAX_TEXT);
  return {
    url: top.url,
    title: top.title,
    selection: parts.map((p) => p.selection).find(Boolean) ?? '',
    viewportText: text,
    math: [...new Set(parts.flatMap((p) => p.math))].slice(0, 40),
    fields: parts.flatMap((p) => p.fields).slice(0, 30),
    workLog: parts.flatMap((p) => p.workLog).slice(-40),
    drawings: parts.flatMap((p) => p.drawings).slice(0, MAX_DRAWINGS),
  };
}
