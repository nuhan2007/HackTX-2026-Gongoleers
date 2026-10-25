// Cheap "did the screen change?" test, so unchanged snapshots are never stored twice or sent to the model.
// A frame is reduced to a small grayscale image; the amount that changed between two of them is the
// fraction of pixels whose brightness moved by more than a threshold (typed text, a drawn line, a new
// message), with a noise floor so a blinking caret or a hover highlight doesn't count.

export const GRAY_W = 192;
/** A pixel counts as changed when its brightness moved by more than this (0..255). */
export const PIXEL_DELTA = 24;
/** Below this fraction of the frame a change is noise (caret blink, antialiasing, hover). */
export const NOISE_FRACTION = 0.0006;

export interface Gray {
  data: Uint8Array;
  w: number;
  h: number;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Luma of an RGBA buffer, one byte per pixel. */
export function toGray(rgba: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(rgba.length >> 2);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j++) out[j] = (rgba[i] * 77 + rgba[i + 1] * 151 + rgba[i + 2] * 28) >> 8;
  return out;
}

/** Fraction of pixels whose brightness moved by more than `delta`. 1 when the two frames can't be compared (different size). */
export function changedFraction(prev: Gray | null, next: Gray, delta = PIXEL_DELTA): number {
  if (!prev || prev.w !== next.w || prev.h !== next.h) return 1;
  let changed = 0;
  const n = next.data.length;
  for (let i = 0; i < n; i++) {
    const d = prev.data[i] - next.data[i];
    if (d > delta || d < -delta) changed++;
  }
  return n ? changed / n : 0;
}

/** True when the difference is more than noise. */
export const isChange = (fraction: number) => fraction > NOISE_FRACTION;
