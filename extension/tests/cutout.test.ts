// Turning a photo into a sprite: finding the subject, cutting it out cleanly, and turning it into pixel art.
import { describe, expect, it } from 'vitest';
import { blurMask, bounds, dilate, estimateBackground, fillHoles, floodBackground, keepLargest, looksInverted, palette, pixelate, punch, soften, upscale, type Rgba } from '../src/shared/cutout';

type RGB = [number, number, number];

/** A picture: a plain background with discs of colour on it. */
function picture(w: number, h: number, bg: RGB, discs: { cx: number; cy: number; r: number; c: RGB }[] = [], noise = 0): Rgba {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      let c = bg;
      for (const d of discs) if ((x - d.cx) ** 2 + (y - d.cy) ** 2 <= d.r * d.r) c = d.c;
      const n = noise ? Math.round((((x * 7 + y * 13) % 11) - 5) * noise) : 0;
      data[i] = c[0] + n;
      data[i + 1] = c[1] + n;
      data[i + 2] = c[2] + n;
      data[i + 3] = 255;
    }
  }
  return { data, w, h };
}
const count = (m: ArrayLike<number>, min = 128) => Array.from(m).filter((v) => v >= min).length;
const at = (m: Uint8Array, w: number, x: number, y: number) => m[y * w + x];

describe('finding a subject on a plain background', () => {
  it('reads the background colour from the edge of the picture', () => {
    expect(estimateBackground(picture(40, 40, [240, 238, 230], [{ cx: 20, cy: 20, r: 10, c: [200, 20, 20] }]))).toEqual([240, 238, 230]);
  });

  it('cuts out a subject in the middle and leaves the background out', () => {
    const img = picture(80, 80, [250, 250, 250], [{ cx: 40, cy: 40, r: 20, c: [200, 60, 40] }]);
    const mask = floodBackground(img);
    expect(at(mask, 80, 40, 40)).toBe(255);
    expect(at(mask, 80, 2, 2)).toBe(0);
    expect(at(mask, 80, 40, 75)).toBe(0);
    // about a disc's worth of pixels
    expect(Math.abs(count(mask) - Math.PI * 400)).toBeLessThan(60);
  });

  it('is not fooled by a slightly noisy background (a photo is never one flat colour)', () => {
    const img = picture(80, 80, [200, 210, 220], [{ cx: 40, cy: 40, r: 18, c: [30, 90, 40] }], 3);
    const mask = floodBackground(img, 30);
    expect(at(mask, 80, 40, 40)).toBe(255);
    expect(at(mask, 80, 5, 70)).toBe(0);
  });

  it('keeps only the biggest thing: a speck elsewhere is not part of the subject', () => {
    const img = picture(80, 80, [255, 255, 255], [
      { cx: 40, cy: 40, r: 20, c: [20, 20, 20] },
      { cx: 8, cy: 8, r: 3, c: [20, 20, 20] },
    ]);
    const mask = floodBackground(img);
    expect(at(mask, 80, 40, 40)).toBe(255);
    expect(at(mask, 80, 8, 8)).toBe(0);
  });

  it('finds nothing when the picture is one flat colour', () => {
    const img = picture(60, 60, [255, 255, 255], [{ cx: 30, cy: 30, r: 12, c: [255, 255, 255] }]);
    expect(count(floodBackground(img))).toBe(0);
  });
});

describe('cleaning up a mask', () => {
  it('keepLargest drops everything but the biggest blob', () => {
    const w = 20;
    const m = new Uint8Array(w * w);
    for (let y = 2; y < 10; y++) for (let x = 2; x < 10; x++) m[y * w + x] = 255;
    m[15 * w + 15] = 255;
    const out = keepLargest(m, w, w);
    expect(count(out)).toBe(64);
    expect(at(out, w, 15, 15)).toBe(0);
  });

  it('fillHoles fills a hole inside the subject but not the space outside it', () => {
    const w = 20;
    const m = new Uint8Array(w * w);
    for (let y = 4; y < 16; y++) for (let x = 4; x < 16; x++) m[y * w + x] = 255;
    for (let y = 8; y < 12; y++) for (let x = 8; x < 12; x++) m[y * w + x] = 0;
    const out = fillHoles(m, w, w);
    expect(at(out, w, 9, 9)).toBe(255);
    expect(at(out, w, 1, 1)).toBe(0);
    expect(count(out)).toBe(144);
  });

  it('dilate grows the subject by about the radius all round', () => {
    const w = 40;
    const m = new Uint8Array(w * w);
    for (let y = 15; y < 25; y++) for (let x = 15; x < 25; x++) m[y * w + x] = 255;
    const out = dilate(m, w, w, 4);
    expect(at(out, w, 12, 20)).toBe(255);
    expect(at(out, w, 10, 20)).toBe(0);
    expect(bounds(out, w, w)).toEqual({ x0: 11, y0: 11, x1: 28, y1: 28 });
    expect(count(out)).toBeGreaterThan(count(m));
  });

  it('bounds gives the box round the subject, and null for nothing', () => {
    const w = 30;
    const m = new Uint8Array(w * w);
    for (let y = 5; y < 12; y++) for (let x = 8; x < 20; x++) m[y * w + x] = 255;
    expect(bounds(m, w, w)).toEqual({ x0: 8, y0: 5, x1: 19, y1: 11 });
    expect(bounds(new Uint8Array(w * w), w, w)).toBeNull();
  });

  it('soften makes a clean antialiased edge: solid inside, clear outside, a ramp between', () => {
    const w = 40;
    const m = new Uint8Array(w * w);
    for (let y = 10; y < 30; y++) for (let x = 10; x < 30; x++) m[y * w + x] = 255;
    const out = soften(m, w, w, 2);
    expect(at(out, w, 20, 20)).toBe(255);
    expect(at(out, w, 2, 2)).toBe(0);
    const edge = Array.from({ length: 8 }, (_, i) => at(out, w, 7 + i, 20));
    expect(edge[0]).toBe(0);
    expect(edge[7]).toBe(255);
    expect(edge.some((v) => v > 0 && v < 255)).toBe(true);
    for (let i = 1; i < edge.length; i++) expect(edge[i]).toBeGreaterThanOrEqual(edge[i - 1]);
  });

  it('blur keeps a flat mask flat', () => {
    const w = 16;
    const m = new Uint8Array(w * w).fill(255);
    expect(Array.from(blurMask(m, w, w, 3)).every((v) => v === 255)).toBe(true);
  });

  it('spots a mask that means background instead of person', () => {
    const w = 50;
    const person = new Float32Array(w * w);
    for (let y = 10; y < 40; y++) for (let x = 15; x < 35; x++) person[y * w + x] = 0.95;
    expect(looksInverted(person, w, w)).toBe(false);
    expect(looksInverted(person.map((v) => 1 - v), w, w)).toBe(true);
  });
});

describe('pixel art', () => {
  it('finds a palette of the colours that are really there', () => {
    const px: RGB[] = [];
    for (let i = 0; i < 50; i++) px.push([200 + (i % 5), 20, 20], [20, 20, 200 - (i % 4)], [240, 240, 10]);
    const pal = palette(px, 3);
    expect(pal).toHaveLength(3);
    const near = (c: RGB, t: RGB) => Math.abs(c[0] - t[0]) + Math.abs(c[1] - t[1]) + Math.abs(c[2] - t[2]) < 25;
    expect(pal.some((c) => near(c, [202, 20, 20]))).toBe(true);
    expect(pal.some((c) => near(c, [20, 20, 198]))).toBe(true);
    expect(pal.some((c) => near(c, [240, 240, 10]))).toBe(true);
    expect(palette([], 4)).toEqual([]);
    expect(palette([[1, 2, 3]], 4)).toHaveLength(1);
  });

  it('is the same every time (no random starts)', () => {
    const px: RGB[] = Array.from({ length: 200 }, (_, i) => [(i * 37) % 256, (i * 91) % 256, (i * 13) % 256]);
    expect(palette(px, 6)).toEqual(palette(px, 6));
  });

  it('punches colours up without changing the brightness much', () => {
    const [r, g, b] = punch([180, 120, 100]);
    expect(r).toBeGreaterThan(180);
    expect(b).toBeLessThan(100);
    expect(Math.abs(0.299 * r + 0.587 * g + 0.114 * b - (0.299 * 180 + 0.587 * 120 + 0.114 * 100))).toBeLessThan(3);
  });

  it('shrinks the subject to a grid of cells, a few colours, with a dark outline round it', () => {
    // a 64 x 64 picture: a red square with a blue square in it, on transparent
    const w = 64;
    const data = new Uint8ClampedArray(w * w * 4);
    for (let y = 8; y < 56; y++)
      for (let x = 8; x < 56; x++) {
        const i = (y * w + x) * 4;
        const blue = x > 28 && x < 44 && y > 28 && y < 44;
        data.set(blue ? [20, 40, 220, 255] : [220, 40, 30, 255], i);
      }
    const art = pixelate({ data, w, h: w }, 16, 4);
    expect(art.cells).toBe(16);
    const px = (x: number, y: number) => Array.from(art.data.slice((y * 16 + x) * 4, (y * 16 + x) * 4 + 4));
    expect(px(0, 0)[3]).toBe(0);
    expect(px(8, 8)[3]).toBe(255);
    const colours = new Set<string>();
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) if (px(x, y)[3] === 255) colours.add(px(x, y).join());
    expect(colours.size).toBeLessThanOrEqual(5); // 4 colours and the outline
    expect(colours.has([31, 19, 12, 255].join())).toBe(true);
    // the very edge of the grid is left empty, so the outline always has room
    expect(px(0, 8)[3]).toBe(0);
    expect(px(15, 8)[3]).toBe(0);
  });

  it('turns every cell into a block of real pixels, so it stays crisp', () => {
    const art = { cells: 2, data: new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 0, 0, 0, 0]) };
    const big = upscale(art, 3);
    expect(big.w).toBe(6);
    expect(Array.from(big.data.slice(0, 4))).toEqual([255, 0, 0, 255]);
    expect(Array.from(big.data.slice((2 * 6 + 2) * 4, (2 * 6 + 2) * 4 + 4))).toEqual([255, 0, 0, 255]);
    expect(Array.from(big.data.slice((0 * 6 + 3) * 4, (0 * 6 + 3) * 4 + 4))).toEqual([0, 255, 0, 255]);
    expect(big.data[(5 * 6 + 5) * 4 + 3]).toBe(0);
  });
});
