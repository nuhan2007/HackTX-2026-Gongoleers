import { describe, expect, it, vi } from 'vitest';
import { ActivityTracker } from '../src/content/activityTracker';
import { isMediaPipeNotice, silenceMediaPipeNotices } from '../src/shared/quietConsole';

describe('silenceMediaPipeNotices', () => {
  const sink = () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), log: vi.fn() });

  it('drops the exact lines Chrome was listing as extension errors', () => {
    const s = sink();
    const { warn, error } = s;
    silenceMediaPipeNotices(s);
    s.warn('W1024 22:33:28.887000 2191552 face_landmarker_graph.cc:180] Sets FaceBlendshapesGraph acceleration to xnnpack by default.');
    s.warn('W1024 22:33:28.960000 2191552 gl_context.cc:1135] OpenGL error checking is disabled');
    s.error('INFO: Created TensorFlow Lite XNNPACK delegate for CPU.');
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('lets every other message through untouched', () => {
    const s = sink();
    const { warn, error } = s;
    silenceMediaPipeNotices(s);
    s.error('Failed to load resource', 404);
    s.warn({ not: 'a string' });
    s.error(new TypeError('boom'));
    expect(error).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledWith('Failed to load resource', 404);
    expect(warn).toHaveBeenCalledWith({ not: 'a string' });
  });

  it('is idempotent', () => {
    const s = sink();
    const { error } = s;
    silenceMediaPipeNotices(s);
    silenceMediaPipeNotices(s);
    s.error('real problem');
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('recognises notices only as strings', () => {
    expect(isMediaPipeNotice('gl_context.cc:1135] OpenGL error checking is disabled')).toBe(true);
    expect(isMediaPipeNotice('camera failed')).toBe(false);
    expect(isMediaPipeNotice(undefined)).toBe(false);
  });
});

/** A window that records its listeners, so tests can fire events at the tracker. */
function events() {
  const handlers = new Map<string, (e: unknown) => void>();
  const win = {
    scrollY: 0,
    addEventListener: (type: string, fn: (e: unknown) => void) => handlers.set(type, fn),
    removeEventListener: () => {},
    getSelection: () => null,
  } as unknown as Window;
  return { t: new ActivityTracker(win), fire: (type: string, e: object = {}) => handlers.get(type)?.({ screenX: 0, screenY: 0, ...e }) };
}

describe('ActivityTracker key handling', () => {
  // Autofill and some password managers dispatch keydown events that have no `key`. That used to throw
  // "Cannot read properties of undefined (reading 'length')" from the content script.
  function tracker() {
    const handlers = new Map<string, (e: unknown) => void>();
    const win = {
      scrollY: 0,
      addEventListener: (type: string, fn: (e: unknown) => void) => handlers.set(type, fn),
      removeEventListener: () => {},
      getSelection: () => null,
    } as unknown as Window;
    return { t: new ActivityTracker(win), key: (e: unknown) => handlers.get('keydown')!(e) };
  }

  it('does not throw when a keydown has no key', () => {
    const { key } = tracker();
    expect(() => key({})).not.toThrow();
    expect(() => key({ key: undefined })).not.toThrow();
  });

  it('counts drawing from pointer events, which a drawing app cannot hide by cancelling pointerdown', () => {
    // A canvas sketchpad calls preventDefault() on pointerdown, so the page gets no mouse events at all for the
    // stroke, mouse included. Only pointer events still arrive, and they must count as the student working.
    const { t, fire } = events();
    fire('pointerdown', { buttons: 1 });
    for (let i = 0; i < 40; i++) fire('pointermove', { buttons: 1 });
    expect(t.pointerTotal).toBe(41);
    expect(t.idleMs).toBeLessThan(1000);
  });

  it('counts a pen or finger in contact (buttons 1), not one hovering above the page', () => {
    const { t, fire } = events();
    for (let i = 0; i < 10; i++) fire('pointermove', { buttons: 0 }); // hover
    expect(t.pointerTotal).toBe(0);
    for (let i = 0; i < 10; i++) fire('pointermove', { buttons: 1, pointerType: 'pen' });
    expect(t.pointerTotal).toBe(10);
  });

  it('does not read handwriting as rage-clicking or aimless mouse wandering', () => {
    const { t, fire } = events();
    // twelve quick pen strokes within a couple of seconds, each a real drag across the canvas
    for (let s = 0; s < 12; s++) {
      fire('pointerdown', { buttons: 1, screenX: 100 + s, screenY: 100 });
      for (let i = 1; i <= 25; i++) fire('pointermove', { buttons: 1, screenX: 100 + s + i * 2, screenY: 100 + (i % 5) * 3 });
      fire('pointerup', { buttons: 0, screenX: 150 + s, screenY: 100 });
    }
    expect(t.signals().find((x) => x.id === 'rageClicks')).toBeUndefined();
    expect(t.signals().find((x) => x.id === 'erraticMouse')).toBeUndefined();
    expect(t.pointerTotal).toBe(12 * 26); // but it all counts as the student working
  });

  it('still reads real rapid repeat clicks as rage-clicking, with a mouse, a pen or a finger', () => {
    const { t, fire } = events();
    for (let i = 0; i < 4; i++) {
      fire('pointerdown', { buttons: 1, screenX: 300, screenY: 200 });
      fire('pointerup', { buttons: 0, screenX: 300, screenY: 200 });
    }
    expect(t.signals().find((x) => x.id === 'rageClicks')).toBeTruthy();
  });

  it('does not count a drag twice when the browser also sends compatibility mouse events', () => {
    const { t, fire } = events();
    fire('pointerdown', { buttons: 1 });
    fire('mousedown', { buttons: 1 });
    for (let i = 0; i < 5; i++) {
      fire('pointermove', { buttons: 1 });
      fire('mousemove', { buttons: 1 });
    }
    expect(t.pointerTotal).toBe(6);
  });

  it('still counts typing and deletes', () => {
    const { t, key } = tracker();
    for (let i = 0; i < 10; i++) key({ key: 'Backspace' });
    key({ key: 'a' });
    key({ key: 'Shift' });
    expect(t.signals().find((s) => s.id === 'backspace')).toBeTruthy();
  });
});
