// The character: the pixel art is well-formed, every pose it needs exists, the saved choice of character is read safely, and the little
// pieces of text the bubble shows (the minute a clip starts at, in parentheses) come out right.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GRID, LAYERS, PALETTE } from '../src/content/sprite/monkeyArt';
import { ICON_SIZE, type IconName } from '../src/content/sprite/pixelIcons';
import { snappedSize } from '../src/content/sprite/Avatar';
import { fmtTime, startLabel } from '../src/content/sprite/Sprite';
import { bytesOfDataUrl } from '../src/shared/imageData';
import { clampPos, DEFAULT_SPRITE, getMySprite, getSpritePos, saveMySprite, SPRITE_KEY } from '../src/shared/mySprite';

describe('the pixel monkey', () => {
  it('is 36 cells square, in every layer, and only uses colours that exist', () => {
    expect(GRID).toBe(36);
    for (const [name, rows] of Object.entries(LAYERS)) {
      expect(rows, name).toHaveLength(GRID);
      for (const row of rows) {
        expect(row.length, name).toBe(GRID);
        for (const ch of row) expect(ch === '.' || ch in PALETTE, `${name}: ${ch}`).toBe(true);
      }
    }
  });

  it('has every layer a pose asks for', () => {
    const need = [
      'tail', 'torso', 'head', 'cheeks',
      'eyes_open', 'eyes_blink', 'eyes_happy', 'eyes_wide', 'eyes_think', 'eyes_worry',
      'mouth_neutral', 'mouth_smile', 'mouth_open', 'mouth_cheer', 'mouth_frown', 'mouth_o',
      'arms_rest', 'arms_chin', 'arms_up', 'arms_up_back', 'arms_whoa',
    ];
    for (const n of need) expect(Object.keys(LAYERS), n).toContain(n);
    for (const n of need) expect(LAYERS[n].some((r) => /[^.]/.test(r)), `${n} is empty`).toBe(true);
  });

  it('draws a head and a body (not empty art)', () => {
    const cells = (name: string) => LAYERS[name].join('').replace(/\./g, '').length;
    expect(cells('head')).toBeGreaterThan(250);
    expect(cells('torso')).toBeGreaterThan(150);
    expect(cells('tail')).toBeGreaterThan(30);
  });
});

describe('the pixel icons', () => {
  it('are rectangles of cells', () => {
    for (const n of ['excl', 'quest', 'star', 'heart', 'drop', 'banana', 'spark', 'zzz', 'book'] as IconName[]) {
      const { w, h } = ICON_SIZE(n);
      expect(w, n).toBeGreaterThan(2);
      expect(h, n).toBeGreaterThan(2);
    }
  });
});

describe('reading a picture that arrives as a data URL', () => {
  it('decodes base64', () => {
    const { bytes, type } = bytesOfDataUrl(`data:image/png;base64,${btoa('hello')}`);
    expect(type).toBe('image/png');
    expect(new TextDecoder().decode(bytes)).toBe('hello');
  });
  it('decodes plain text too', () => {
    const { bytes, type } = bytesOfDataUrl('data:text/plain,a%20b');
    expect(type).toBe('text/plain');
    expect(new TextDecoder().decode(bytes)).toBe('a b');
  });
});

describe('the chosen character', () => {
  let store: Record<string, unknown>;
  beforeEach(() => {
    store = {};
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: async (k: string) => ({ [k]: store[k] }),
          set: async (o: Record<string, unknown>) => void Object.assign(store, o),
        },
      },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('is the monkey until a picture is chosen', async () => {
    expect(await getMySprite()).toEqual(DEFAULT_SPRITE);
  });

  it('is the picture once it is saved, and says which look it is', async () => {
    await saveMySprite({ mode: 'custom', png: 'data:image/png;base64,AAAA', style: 'pixel', name: 'Prof', updatedAt: 0 });
    const s = await getMySprite();
    expect(s).toMatchObject({ mode: 'custom', png: 'data:image/png;base64,AAAA', style: 'pixel', name: 'Prof' });
    expect(s.updatedAt).toBeGreaterThan(0);
  });

  it('falls back to the monkey when what is stored is damaged or is not a picture', async () => {
    store[SPRITE_KEY] = { mode: 'custom', png: 'javascript:alert(1)', updatedAt: 1 };
    expect(await getMySprite()).toEqual(DEFAULT_SPRITE);
    store[SPRITE_KEY] = { mode: 'custom', updatedAt: 1 };
    expect(await getMySprite()).toEqual(DEFAULT_SPRITE);
    store[SPRITE_KEY] = 'nonsense';
    expect(await getMySprite()).toEqual(DEFAULT_SPRITE);
  });

  it('remembers where it was dragged to, and ignores a position that is not numbers', async () => {
    expect(await getSpritePos()).toBeNull();
    store.spritePos = { right: 300, bottom: 120 };
    expect(await getSpritePos()).toEqual({ right: 300, bottom: 120 });
    store.spritePos = { right: 'x', bottom: 1 };
    expect(await getSpritePos()).toBeNull();
  });
});

describe('keeping the sprite on screen', () => {
  const vp = { w: 1000, h: 700 };
  it('leaves a position that is fine alone', () => {
    expect(clampPos({ right: 20, bottom: 20 }, vp)).toEqual({ right: 20, bottom: 20 });
    expect(clampPos({ right: 500, bottom: 300 }, vp)).toEqual({ right: 500, bottom: 300 });
  });
  it('never lets it be dragged out of sight: some of it always stays in view', () => {
    const far = clampPos({ right: 5000, bottom: 5000 }, vp);
    expect(far.right).toBeLessThanOrEqual(vp.w - 48);
    expect(far.bottom).toBeLessThanOrEqual(vp.h - 48);
    const off = clampPos({ right: -5000, bottom: -5000 }, vp);
    expect(off.right).toBeGreaterThanOrEqual(-(120 - 48));
    expect(off.bottom).toBeGreaterThanOrEqual(-(120 - 48));
  });
});

describe('the minute a clip starts at', () => {
  it('is written as minutes and seconds, and hours when it needs them', () => {
    expect(fmtTime(0)).toBe('0:00');
    expect(fmtTime(134)).toBe('2:14');
    expect(fmtTime(3723)).toBe('1:02:03');
    expect(fmtTime(-5)).toBe('0:00');
  });
  it('goes in parentheses next to "Watch it": exact when the video itself told us', () => {
    expect(startLabel({ start: 134, source: 'video' })).toBe('(2:14)');
    expect(startLabel({ start: 90, source: 'chapters' })).toBe('(1:30)');
  });
  it('says it is approximate when it only came from the search result, and "from the start" when there is nothing', () => {
    expect(startLabel({ start: 60, source: 'metadata' })).toBe('(~1:00)');
    expect(startLabel({ start: 0, source: 'metadata' })).toBe('(from the start)');
  });
});

describe('drawing pixel art with whole screen pixels in every cell', () => {
  it('is 108px (3 screen pixels a cell) on an ordinary and on a 2x display', () => {
    expect(snappedSize(36, 108, 1)).toBe(108);
    expect(snappedSize(36, 108, 2)).toBe(108);
    expect(snappedSize(36, 108, 3)).toBe(108);
  });
  it('is nudged to a size that has whole screen pixels in a cell on 125% and 150% displays', () => {
    for (const dpr of [1.25, 1.5, 1.75, 2.25]) {
      const css = snappedSize(36, 108, dpr);
      const perCell = (css * dpr) / 36;
      expect(Math.abs(perCell - Math.round(perCell)), `dpr ${dpr}`).toBeLessThan(1e-9);
      expect(css).toBeGreaterThan(96);
      expect(css).toBeLessThan(125);
    }
    expect(snappedSize(36, 108, 1.25)).toBeCloseTo(115.2, 5);
    expect(snappedSize(36, 108, 1.5)).toBe(120);
  });
});
