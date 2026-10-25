// Which character the sprite is: the pixel monkey (the default), or a picture the student made into a sticker (their TA, a pet, a friend).
// Kept in chrome.storage.local, on this device only, and read by the content script directly, so changing it in setup changes the sprite on
// every open page at once with no message passing.

export interface MySprite {
  mode: 'monkey' | 'custom';
  /** The sticker as a PNG data URL (transparent background), when `mode` is "custom". */
  png?: string;
  /** How it was made: a smooth cut-out sticker, or chunky pixel art to match the monkey. Pixel art is drawn without smoothing. */
  style?: 'sticker' | 'pixel';
  /** What the student calls it. */
  name?: string;
  updatedAt: number;
}

export const SPRITE_KEY = 'mySprite';
export const DEFAULT_SPRITE: MySprite = { mode: 'monkey', updatedAt: 0 };

/** Where the student dragged the sprite to, as distances from the right and bottom edges of the window. */
export interface SpritePos {
  right: number;
  bottom: number;
}
export const POS_KEY = 'spritePos';

export async function getMySprite(): Promise<MySprite> {
  try {
    const { [SPRITE_KEY]: s } = (await chrome.storage.local.get(SPRITE_KEY)) as { [SPRITE_KEY]?: MySprite };
    return s && (s.mode === 'monkey' || (s.mode === 'custom' && typeof s.png === 'string' && s.png.startsWith('data:image/'))) ? s : DEFAULT_SPRITE;
  } catch {
    return DEFAULT_SPRITE;
  }
}

export async function saveMySprite(s: MySprite): Promise<void> {
  await chrome.storage.local.set({ [SPRITE_KEY]: { ...s, updatedAt: Date.now() } });
}

/** Calls back with the new sprite whenever it changes anywhere. Returns a way to stop listening. */
export function onMySpriteChanged(cb: (s: MySprite) => void): () => void {
  const fn = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area !== 'local' || !changes[SPRITE_KEY]) return;
    const v = changes[SPRITE_KEY].newValue as MySprite | undefined;
    cb(v && (v.mode === 'monkey' || v.png) ? v : DEFAULT_SPRITE);
  };
  chrome.storage.onChanged.addListener(fn);
  return () => chrome.storage.onChanged.removeListener(fn);
}

export async function getSpritePos(): Promise<SpritePos | null> {
  try {
    const { [POS_KEY]: p } = (await chrome.storage.local.get(POS_KEY)) as { [POS_KEY]?: SpritePos };
    return p && Number.isFinite(p.right) && Number.isFinite(p.bottom) ? p : null;
  } catch {
    return null;
  }
}

export async function saveSpritePos(p: SpritePos): Promise<void> {
  await chrome.storage.local.set({ [POS_KEY]: p }).catch(() => undefined);
}

/** Keeps a dragged position on screen: the sprite is roughly this big, and at least this much of it has to stay in view. */
export function clampPos(p: SpritePos, viewport: { w: number; h: number }, size = { w: 120, h: 120 }): SpritePos {
  const keep = 48;
  return {
    right: Math.min(viewport.w - keep, Math.max(-(size.w - keep), p.right)),
    bottom: Math.min(viewport.h - keep, Math.max(-(size.h - keep), p.bottom)),
  };
}
