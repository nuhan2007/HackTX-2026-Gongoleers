// Turning a photo into a sprite, the pure part: it works on plain pixel arrays (RGBA bytes), so it runs anywhere and is unit-tested. The
// browser-only half (loading the photo, the person cut-out model, drawing) is in options/spriteMaker.ts.
//
// Two looks: a smooth STICKER (the subject cut out, with a white outline like a sticker in Messages), and PIXEL ART (the subject
// shrunk to a few dozen cells, reduced to a handful of colours and outlined, so it sits beside the pixel monkey).

export interface Rgba {
  data: Uint8ClampedArray | Uint8Array;
  w: number;
  h: number;
}

type RGB = [number, number, number];

const dist2 = (a: RGB, b: RGB) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

/** The colour around the edge of the picture: the middle value of every border pixel. */
export function estimateBackground({ data, w, h }: Rgba): RGB {
  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];
  const push = (x: number, y: number) => {
    const i = (y * w + x) * 4;
    rs.push(data[i]);
    gs.push(data[i + 1]);
    bs.push(data[i + 2]);
  };
  const band = Math.max(1, Math.round(Math.min(w, h) * 0.02));
  for (let b = 0; b < band; b++) {
    for (let x = 0; x < w; x++) {
      push(x, b);
      push(x, h - 1 - b);
    }
    for (let y = band; y < h - band; y++) {
      push(b, y);
      push(w - 1 - b, y);
    }
  }
  const mid = (a: number[]) => a.sort((p, q) => p - q)[a.length >> 1];
  return [mid(rs), mid(gs), mid(bs)];
}

/**
 * For a subject on a plain background (a person against a wall, a pet on a sofa, a drawing on paper): everything reachable from the
 * edge through pixels close to the edge colour is background. Returns a mask, 255 for the subject and 0 for the background.
 */
export function floodBackground(img: Rgba, tolerance = 44): Uint8Array {
  const { data, w, h } = img;
  const bg = estimateBackground(img);
  const tol2 = tolerance * tolerance * 3;
  const isBg = new Uint8Array(w * h);
  const stack: number[] = [];
  const near = (p: number) => dist2([data[p * 4], data[p * 4 + 1], data[p * 4 + 2]], bg) <= tol2 || data[p * 4 + 3] < 16;
  const seed = (p: number) => {
    if (!isBg[p] && near(p)) {
      isBg[p] = 1;
      stack.push(p);
    }
  };
  for (let x = 0; x < w; x++) {
    seed(x);
    seed((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    seed(y * w);
    seed(y * w + w - 1);
  }
  while (stack.length) {
    const p = stack.pop()!;
    const x = p % w;
    if (x > 0) seed(p - 1);
    if (x < w - 1) seed(p + 1);
    if (p >= w) seed(p - w);
    if (p < w * (h - 1)) seed(p + w);
  }
  const mask = new Uint8Array(w * h);
  for (let p = 0; p < mask.length; p++) mask[p] = isBg[p] ? 0 : 255;
  return keepLargest(mask, w, h);
}

/** Keeps the biggest connected blob of the mask and drops every speck outside it. */
export function keepLargest(mask: Uint8Array, w: number, h: number): Uint8Array {
  const label = new Int32Array(w * h);
  let best = 0;
  let bestSize = 0;
  let next = 0;
  const sizes: number[] = [0];
  const stack: number[] = [];
  for (let s = 0; s < mask.length; s++) {
    if (!mask[s] || label[s]) continue;
    next++;
    let size = 0;
    label[s] = next;
    stack.push(s);
    while (stack.length) {
      const p = stack.pop()!;
      size++;
      const x = p % w;
      const visit = (q: number) => {
        if (mask[q] && !label[q]) {
          label[q] = next;
          stack.push(q);
        }
      };
      if (x > 0) visit(p - 1);
      if (x < w - 1) visit(p + 1);
      if (p >= w) visit(p - w);
      if (p < w * (h - 1)) visit(p + w);
    }
    sizes.push(size);
    if (size > bestSize) {
      bestSize = size;
      best = next;
    }
  }
  const out = new Uint8Array(w * h);
  if (best) for (let p = 0; p < out.length; p++) if (label[p] === best) out[p] = mask[p];
  return out;
}

/** Fills holes in the subject that are not connected to the outside (a gap inside a segmentation, the space inside a glasses frame). */
export function fillHoles(mask: Uint8Array, w: number, h: number): Uint8Array {
  const outside = new Uint8Array(w * h);
  const stack: number[] = [];
  const seed = (p: number) => {
    if (!mask[p] && !outside[p]) {
      outside[p] = 1;
      stack.push(p);
    }
  };
  for (let x = 0; x < w; x++) {
    seed(x);
    seed((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    seed(y * w);
    seed(y * w + w - 1);
  }
  while (stack.length) {
    const p = stack.pop()!;
    const x = p % w;
    if (x > 0) seed(p - 1);
    if (x < w - 1) seed(p + 1);
    if (p >= w) seed(p - w);
    if (p < w * (h - 1)) seed(p + w);
  }
  const out = new Uint8Array(mask);
  for (let p = 0; p < out.length; p++) if (!outside[p]) out[p] = 255;
  return out;
}

/** A box blur, `passes` times, over a mask: turns a hard edge into a soft one (then `soften` makes it a clean antialiased edge). */
export function blurMask(mask: Uint8Array, w: number, h: number, radius: number, passes = 2): Uint8Array {
  const src = Float32Array.from(mask);
  const dst = new Float32Array(w * h);
  const r = Math.max(1, Math.round(radius));
  for (let pass = 0; pass < passes; pass++) {
    // horizontal
    for (let y = 0; y < h; y++) {
      let sum = 0;
      const row = y * w;
      for (let x = -r; x <= r; x++) sum += src[row + Math.min(w - 1, Math.max(0, x))];
      for (let x = 0; x < w; x++) {
        dst[row + x] = sum / (2 * r + 1);
        sum += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
      }
    }
    // vertical
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let y = -r; y <= r; y++) sum += dst[Math.min(h - 1, Math.max(0, y)) * w + x];
      for (let y = 0; y < h; y++) {
        src[y * w + x] = sum / (2 * r + 1);
        sum += dst[Math.min(h - 1, y + r + 1) * w + x] - dst[Math.max(0, y - r) * w + x];
      }
    }
  }
  return Uint8Array.from(src, (v) => Math.round(v));
}

/** A blurred mask pushed through a steep curve: a smooth, antialiased edge that is still a clean cut. */
export function soften(mask: Uint8Array, w: number, h: number, radius = 2): Uint8Array {
  const blurred = blurMask(mask, w, h, radius, 2);
  return Uint8Array.from(blurred, (v) => {
    const t = Math.min(1, Math.max(0, (v / 255 - 0.35) / 0.3));
    return Math.round(255 * t * t * (3 - 2 * t));
  });
}

/** The box around everything above the threshold, or null for an empty mask. */
export function bounds(mask: Uint8Array, w: number, h: number, threshold = 128): { x0: number; y0: number; x1: number; y1: number } | null {
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (mask[y * w + x] >= threshold) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}

/** Grows the mask by `r` pixels all round (a round brush), for the white outline of a sticker. */
export function dilate(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const out = new Uint8Array(w * h);
  const offsets: [number, number][] = [];
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (dx * dx + dy * dy <= r * r) offsets.push([dx, dy]);
  // Only the edge pixels need to paint (the inside is already full).
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = mask[y * w + x];
      if (v < 128) continue;
      const edge = x === 0 || y === 0 || x === w - 1 || y === h - 1 || mask[y * w + x - 1] < 128 || mask[y * w + x + 1] < 128 || mask[(y - 1) * w + x] < 128 || mask[(y + 1) * w + x] < 128;
      if (!edge) {
        out[y * w + x] = 255;
        continue;
      }
      for (const [dx, dy] of offsets) {
        const xx = x + dx;
        const yy = y + dy;
        if (xx >= 0 && yy >= 0 && xx < w && yy < h) out[yy * w + xx] = 255;
      }
    }
  }
  return out;
}

/** Whether a mask looks inside out (high around the edge, low in the middle): the model's mask can mean "background" or "person". */
export function looksInverted(mask: ArrayLike<number>, w: number, h: number): boolean {
  let border = 0;
  let bn = 0;
  let centre = 0;
  let cn = 0;
  const bx = Math.max(1, Math.round(w * 0.1));
  const by = Math.max(1, Math.round(h * 0.1));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = mask[y * w + x];
      if (x < bx || x >= w - bx || y < by || y >= h - by) {
        border += v;
        bn++;
      } else if (x > w * 0.3 && x < w * 0.7 && y > h * 0.3 && y < h * 0.7) {
        centre += v;
        cn++;
      }
    }
  }
  return bn > 0 && cn > 0 && border / bn > centre / cn;
}

// ---------------------------------------------------------------- pixel art

/** k-means over the opaque pixels' colours: a palette of `k` colours that stand for the picture. */
export function palette(pixels: RGB[], k: number, iterations = 10): RGB[] {
  if (pixels.length === 0) return [];
  const k2 = Math.min(k, pixels.length);
  // Start from colours spread through the picture (every n-th pixel, after sorting by brightness) so the result is the same every time.
  const sorted = [...pixels].sort((a, b) => a[0] + a[1] + a[2] - (b[0] + b[1] + b[2]));
  let centres: RGB[] = Array.from({ length: k2 }, (_, i) => sorted[Math.min(sorted.length - 1, Math.floor(((i + 0.5) * sorted.length) / k2))]);
  for (let it = 0; it < iterations; it++) {
    const sum = centres.map(() => [0, 0, 0, 0]);
    for (const p of pixels) {
      let best = 0;
      let bd = Infinity;
      for (let c = 0; c < centres.length; c++) {
        const d = dist2(p, centres[c]);
        if (d < bd) {
          bd = d;
          best = c;
        }
      }
      sum[best][0] += p[0];
      sum[best][1] += p[1];
      sum[best][2] += p[2];
      sum[best][3]++;
    }
    centres = centres.map((c, i) => (sum[i][3] ? [Math.round(sum[i][0] / sum[i][3]), Math.round(sum[i][1] / sum[i][3]), Math.round(sum[i][2] / sum[i][3])] : c));
  }
  return centres;
}

/** A little more punch: pixel art reads better with colours a notch more saturated than a photo's. */
export function punch([r, g, b]: RGB, amount = 1.18): RGB {
  const l = 0.299 * r + 0.587 * g + 0.114 * b;
  const f = (v: number) => Math.max(0, Math.min(255, Math.round(l + (v - l) * amount)));
  return [f(r), f(g), f(b)];
}

export interface PixelArt {
  cells: number;
  /** RGBA, `cells` x `cells`: transparent where there is no subject. */
  data: Uint8ClampedArray;
}

/**
 * The subject, shrunk to `cells` x `cells`, in at most `colours` colours, with a dark outline of one cell around it. `rgba` is the picture
 * already cut out (transparent where the subject isn't), square, with the subject filling the frame.
 */
export function pixelate(img: Rgba, cells: number, colours = 12, outline: RGB = [31, 19, 12]): PixelArt {
  const { data, w, h } = img;
  const inner = cells - 2; // one cell of margin on every side, for the outline
  const out = new Uint8ClampedArray(cells * cells * 4);
  const opaque: RGB[] = [];
  const cellRgb: (RGB | null)[] = new Array(cells * cells).fill(null);
  for (let cy = 0; cy < inner; cy++) {
    for (let cx = 0; cx < inner; cx++) {
      const x0 = Math.floor((cx * w) / inner);
      const x1 = Math.max(x0 + 1, Math.floor(((cx + 1) * w) / inner));
      const y0 = Math.floor((cy * h) / inner);
      const y1 = Math.max(y0 + 1, Math.floor(((cy + 1) * h) / inner));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * w + x) * 4;
          const al = data[i + 3];
          r += data[i] * al;
          g += data[i + 1] * al;
          b += data[i + 2] * al;
          a += al;
          n++;
        }
      }
      if (n === 0 || a / n < 128) continue;
      const px: RGB = [Math.round(r / a), Math.round(g / a), Math.round(b / a)];
      cellRgb[(cy + 1) * cells + cx + 1] = px;
      opaque.push(px);
    }
  }
  const pal = palette(opaque, colours).map((c) => punch(c));
  const nearest = (p: RGB): RGB => {
    let best = pal[0];
    let bd = Infinity;
    for (const c of pal) {
      const d = dist2(p, c);
      if (d < bd) {
        bd = d;
        best = c;
      }
    }
    return best;
  };
  for (let i = 0; i < cellRgb.length; i++) {
    const p = cellRgb[i];
    if (!p) continue;
    const c = nearest(p);
    out[i * 4] = c[0];
    out[i * 4 + 1] = c[1];
    out[i * 4 + 2] = c[2];
    out[i * 4 + 3] = 255;
  }
  // The outline: every empty cell that touches the subject on a side.
  for (let y = 0; y < cells; y++) {
    for (let x = 0; x < cells; x++) {
      const i = y * cells + x;
      if (out[i * 4 + 3]) continue;
      const touches = (nx: number, ny: number) => nx >= 0 && ny >= 0 && nx < cells && ny < cells && out[(ny * cells + nx) * 4 + 3] === 255 && cellRgb[ny * cells + nx] !== null;
      if (touches(x - 1, y) || touches(x + 1, y) || touches(x, y - 1) || touches(x, y + 1)) {
        out[i * 4] = outline[0];
        out[i * 4 + 1] = outline[1];
        out[i * 4 + 2] = outline[2];
        out[i * 4 + 3] = 255;
      }
    }
  }
  return { cells, data: out };
}

/** The same pixel art, every cell blown up to `scale` x `scale` real pixels (so it stays crisp when drawn small without smoothing). */
export function upscale(art: PixelArt, scale: number): Rgba {
  const size = art.cells * scale;
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    const cy = Math.floor(y / scale);
    for (let x = 0; x < size; x++) {
      const cx = Math.floor(x / scale);
      const s = (cy * art.cells + cx) * 4;
      const d = (y * size + x) * 4;
      data[d] = art.data[s];
      data[d + 1] = art.data[s + 1];
      data[d + 2] = art.data[s + 2];
      data[d + 3] = art.data[s + 3];
    }
  }
  return { data, w: size, h: size };
}
