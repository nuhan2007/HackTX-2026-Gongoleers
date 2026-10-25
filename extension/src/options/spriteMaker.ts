// Making a sprite from a photo, the browser half: load the picture, crop it to a square, cut the person out with MediaPipe's selfie
// segmenter (everything stays on this device), or, for a pet or a drawing, cut out whatever stands out from the plain background; then
// build the sticker or the pixel art. The maths (masks, outlines, palettes) is in shared/cutout.ts.
import { FaceLandmarker, FilesetResolver, ImageSegmenter } from '@mediapipe/tasks-vision';
import { blurMask, bounds, dilate, fillHoles, floodBackground, keepLargest, looksInverted, pixelate, soften, upscale } from '../shared/cutout';
import { silenceMediaPipeNotices } from '../shared/quietConsole';

silenceMediaPipeNotices();

/** The working size: big enough for a clean cut, small enough to be quick. */
const N = 512;
/** The sticker as saved. */
const STICKER = 256;
/** 36 cells, like the monkey: drawn 108px wide that is exactly 3px a cell, so the two have the same size of pixel. Saved at 6px a cell for sharp screens. */
const PIXEL_CELLS = 36;
const PIXEL_SCALE = 6;

/** Which part of the photo is used: the centre as a fraction of the photo's width and height, and how far it is zoomed in (1 = the whole short side). */
export interface Crop {
  cx: number;
  cy: number;
  zoom: number;
}
export const WHOLE_PHOTO: Crop = { cx: 0.5, cy: 0.5, zoom: 1 };

export type Style = 'sticker' | 'pixel';
/** `auto` looks for a face: a person is cut out with the person model, anything else from its plain background. */
export type CutChoice = 'auto' | 'person' | 'plain' | 'none';
export type CutMethod = 'person' | 'plain' | 'none';

export interface Made {
  png: string;
  method: CutMethod;
}

export async function loadBitmap(file: Blob): Promise<ImageBitmap> {
  return createImageBitmap(file, { imageOrientation: 'from-image' });
}

/** The chosen part of the photo as a square canvas. */
export function renderSquare(bmp: ImageBitmap | HTMLVideoElement, crop: Crop, size = N): HTMLCanvasElement {
  const sw = bmp instanceof HTMLVideoElement ? bmp.videoWidth : bmp.width;
  const sh = bmp instanceof HTMLVideoElement ? bmp.videoHeight : bmp.height;
  const side = Math.min(sw, sh) / Math.max(1, crop.zoom);
  const x = Math.min(sw - side, Math.max(0, crop.cx * sw - side / 2));
  const y = Math.min(sh - side, Math.max(0, crop.cy * sh - side / 2));
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  g.imageSmoothingQuality = 'high';
  g.drawImage(bmp, x, y, side, side, 0, 0, size, size);
  return c;
}

let segmenter: Promise<ImageSegmenter> | null = null;
function loadSegmenter(): Promise<ImageSegmenter> {
  if (!segmenter) {
    segmenter = (async () => {
      const fileset = await FilesetResolver.forVisionTasks(chrome.runtime.getURL('mediapipe/wasm'));
      const opts = (delegate: 'GPU' | 'CPU') => ({
        baseOptions: { modelAssetPath: chrome.runtime.getURL('mediapipe/selfie_segmenter.tflite'), delegate },
        runningMode: 'IMAGE' as const,
        outputConfidenceMasks: true,
        outputCategoryMask: false,
      });
      try {
        return await ImageSegmenter.createFromOptions(fileset, opts('GPU'));
      } catch {
        return ImageSegmenter.createFromOptions(fileset, opts('CPU'));
      }
    })();
    segmenter.catch(() => (segmenter = null)); // try again next time
  }
  return segmenter;
}

/** Where the person is, as 0..255 at N x N, or null when the model can't be used. */
async function personMask(square: HTMLCanvasElement): Promise<Uint8Array | null> {
  try {
    const seg = await loadSegmenter();
    let conf: Float32Array | null = null;
    let mw = 0;
    let mh = 0;
    seg.segment(square, (res) => {
      const m = res.confidenceMasks?.[0];
      if (!m) return;
      conf = Float32Array.from(m.getAsFloat32Array());
      mw = m.width;
      mh = m.height;
    });
    if (!conf || !mw) return null;
    const probs: Float32Array = conf;
    const invert = looksInverted(probs, mw, mh);
    // Scale the model's small mask up to the working size through a canvas, which also smooths it.
    const small = document.createElement('canvas');
    small.width = mw;
    small.height = mh;
    const sg = small.getContext('2d')!;
    const px = sg.createImageData(mw, mh);
    for (let i = 0; i < mw * mh; i++) {
      const p = invert ? 1 - probs[i] : probs[i];
      px.data[i * 4 + 3] = Math.round(Math.min(1, Math.max(0, p)) * 255);
    }
    sg.putImageData(px, 0, 0);
    const big = document.createElement('canvas');
    big.width = big.height = N;
    const bg = big.getContext('2d', { willReadFrequently: true })!;
    bg.imageSmoothingQuality = 'high';
    bg.drawImage(small, 0, 0, N, N);
    const data = bg.getImageData(0, 0, N, N).data;
    const mask = new Uint8Array(N * N);
    for (let i = 0; i < mask.length; i++) mask[i] = data[i * 4 + 3] >= 128 ? 255 : 0;
    return mask;
  } catch {
    return null;
  }
}

let faceFinder: Promise<FaceLandmarker> | null = null;
/** Is there a face in the picture? That is what tells a person from a pet or a drawing, which the person model would only half cut out. */
async function hasFace(square: HTMLCanvasElement): Promise<boolean> {
  try {
    if (!faceFinder) {
      faceFinder = (async () => {
        const fileset = await FilesetResolver.forVisionTasks(chrome.runtime.getURL('mediapipe/wasm'));
        const opts = (delegate: 'GPU' | 'CPU') => ({ baseOptions: { modelAssetPath: chrome.runtime.getURL('mediapipe/face_landmarker.task'), delegate }, runningMode: 'IMAGE' as const, numFaces: 1 });
        try {
          return await FaceLandmarker.createFromOptions(fileset, opts('GPU'));
        } catch {
          return FaceLandmarker.createFromOptions(fileset, opts('CPU'));
        }
      })();
      faceFinder.catch(() => (faceFinder = null));
    }
    const res = (await faceFinder).detect(square);
    return res.faceLandmarks.length > 0;
  } catch {
    return false;
  }
}

/** How much of the picture's outer edge the subject runs into: a clean cut-out of a pet or a drawing sits inside the frame, a bad one drags the background in. */
function edgeTouch(mask: Uint8Array): number {
  let on = 0;
  let n = 0;
  const ring = 3;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      if (x >= ring && y >= ring && x < N - ring && y < N - ring) continue;
      n++;
      if (mask[y * N + x]) on++;
    }
  }
  return on / n;
}

const coverage = (mask: Uint8Array) => {
  let n = 0;
  for (const v of mask) if (v) n++;
  return n / mask.length;
};

/** A rounded square, for a photo whose background should stay. */
function roundedSquareMask(): Uint8Array {
  const mask = new Uint8Array(N * N);
  const m = Math.round(N * 0.06);
  const r = Math.round(N * 0.16);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const dx = Math.max(m + r - x, x - (N - 1 - m - r), 0);
      const dy = Math.max(m + r - y, y - (N - 1 - m - r), 0);
      if (x >= m && y >= m && x < N - m && y < N - m && dx * dx + dy * dy <= r * r) mask[y * N + x] = 255;
    }
  }
  return mask;
}

/**
 * Finds the subject. `auto`: a face means a person (the person model); no face means a pet, an object or a drawing, cut out from its plain
 * background when that gives a clean cut, and otherwise kept whole as a rounded sticker.
 */
async function findSubject(square: HTMLCanvasElement, choice: CutChoice, tolerance: number): Promise<{ mask: Uint8Array; method: CutMethod }> {
  if (choice === 'none') return { mask: roundedSquareMask(), method: 'none' };
  const g = square.getContext('2d', { willReadFrequently: true })!;
  const sane = (m: Uint8Array) => {
    const c = coverage(m);
    return c > 0.05 && c < 0.93;
  };
  const person = async () => {
    const m = await personMask(square);
    return m && sane(m) ? m : null;
  };
  const plain = () => {
    const img = g.getImageData(0, 0, N, N);
    const m = floodBackground({ data: img.data, w: N, h: N }, tolerance);
    const c = coverage(m);
    return c > 0.04 && c < 0.9 ? m : null;
  };
  if (choice === 'person') {
    const m = await person();
    return m ? { mask: m, method: 'person' } : { mask: roundedSquareMask(), method: 'none' };
  }
  if (choice === 'plain') {
    const m = plain();
    return m ? { mask: m, method: 'plain' } : { mask: roundedSquareMask(), method: 'none' };
  }
  if (await hasFace(square)) {
    const m = await person();
    if (m) return { mask: m, method: 'person' };
  }
  // No face: a pet, an object, a drawing. It is only cut out when the cut is clean (the subject sits inside the frame against a plain
  // background); a photo of a cat on a sofa is better kept whole than cut up.
  const flat = plain();
  if (flat && edgeTouch(flat) < 0.12 && coverage(flat) < 0.78) return { mask: flat, method: 'plain' };
  return { mask: roundedSquareMask(), method: 'none' };
}

/** The photo cut out along `mask` (clean, antialiased), centred in a square and sized to fill most of it. Returns RGBA at N x N. */
function cutOut(square: HTMLCanvasElement, rawMask: Uint8Array, fill = 0.88): ImageData {
  let mask = keepLargest(rawMask, N, N);
  mask = fillHoles(mask, N, N);
  mask = soften(mask, N, N, 2);
  const g = square.getContext('2d', { willReadFrequently: true })!;
  const src = g.getImageData(0, 0, N, N);
  const cut = new ImageData(N, N);
  for (let i = 0; i < N * N; i++) {
    cut.data[i * 4] = src.data[i * 4];
    cut.data[i * 4 + 1] = src.data[i * 4 + 1];
    cut.data[i * 4 + 2] = src.data[i * 4 + 2];
    cut.data[i * 4 + 3] = mask[i];
  }
  const b = bounds(mask, N, N, 100);
  if (!b) return cut;
  const holder = document.createElement('canvas');
  holder.width = holder.height = N;
  holder.getContext('2d')!.putImageData(cut, 0, 0);
  const bw = b.x1 - b.x0 + 1;
  const bh = b.y1 - b.y0 + 1;
  const scale = Math.min((N * fill) / bw, (N * fill) / bh);
  const out = document.createElement('canvas');
  out.width = out.height = N;
  const og = out.getContext('2d', { willReadFrequently: true })!;
  og.imageSmoothingQuality = 'high';
  og.drawImage(holder, b.x0, b.y0, bw, bh, (N - bw * scale) / 2, (N - bh * scale) / 2, bw * scale, bh * scale);
  return og.getImageData(0, 0, N, N);
}

const toPng = (data: ImageData | { data: Uint8ClampedArray | Uint8Array; w: number; h: number }, outSize?: number): string => {
  const w = 'w' in data ? data.w : data.width;
  const h = 'w' in data ? data.h : data.height;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(data.data), w, h), 0, 0);
  if (!outSize || outSize === w) return c.toDataURL('image/png');
  const s = document.createElement('canvas');
  s.width = s.height = outSize;
  const g = s.getContext('2d')!;
  g.imageSmoothingQuality = 'high';
  g.drawImage(c, 0, 0, outSize, outSize);
  return s.toDataURL('image/png');
};

/** A sticker: the subject with a white outline, like a sticker in Messages. */
function sticker(cut: ImageData): string {
  const alpha = new Uint8Array(N * N);
  for (let i = 0; i < alpha.length; i++) alpha[i] = cut.data[i * 4 + 3];
  // The outline grows from the subject's edge; a little blur rounds off its corners.
  const ring = soften(dilate(alpha, N, N, 9), N, N, 3);
  const out = new Uint8ClampedArray(N * N * 4);
  for (let i = 0; i < N * N; i++) {
    const a = cut.data[i * 4 + 3] / 255;
    const o = ring[i] / 255;
    // white outline underneath, the photo on top
    const alphaOut = a + o * (1 - a);
    if (alphaOut <= 0) continue;
    for (let k = 0; k < 3; k++) out[i * 4 + k] = Math.round((cut.data[i * 4 + k] * a + 255 * o * (1 - a)) / alphaOut);
    out[i * 4 + 3] = Math.round(alphaOut * 255);
  }
  return toPng({ data: out, w: N, h: N }, STICKER);
}

/** Pixel art in the monkey's style: a few dozen cells, a dozen colours, a dark outline. Drawn crisp (no smoothing). */
function pixelArt(cut: ImageData): string {
  // A slightly softer mask before shrinking keeps single stray pixels out of the art.
  const a = new Uint8Array(N * N);
  for (let i = 0; i < a.length; i++) a[i] = cut.data[i * 4 + 3];
  const clean = blurMask(a, N, N, 1, 1);
  const data = new Uint8ClampedArray(cut.data);
  for (let i = 0; i < N * N; i++) data[i * 4 + 3] = clean[i];
  const art = pixelate({ data, w: N, h: N }, PIXEL_CELLS, 14);
  return toPng(upscale(art, PIXEL_SCALE));
}

/** The whole pipeline: a square crop in, a sprite out. */
export async function makeSprite(square: HTMLCanvasElement, style: Style, choice: CutChoice, tolerance = 44): Promise<Made> {
  const { mask, method } = await findSubject(square, choice, tolerance);
  const cut = cutOut(square, mask, style === 'pixel' ? 0.94 : 0.84);
  return { png: style === 'pixel' ? pixelArt(cut) : sticker(cut), method };
}
