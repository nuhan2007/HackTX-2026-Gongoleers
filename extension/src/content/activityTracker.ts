// Behavioural cues: re-reading, erratic mouse, rage clicks, backspace bursts,
// repeated selections, and the raw idle timer (the engine turns idle into a signal).
import type { Signal } from '../shared/types';

const within = <T extends { t: number }>(xs: T[], now: number, ms: number) => xs.filter((x) => now - x.t < ms);
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

export class ActivityTracker {
  private lastInputAt = Date.now();
  private scrolls: { t: number; y: number; dir: number }[] = [];
  private maxScrollY = 0;
  private moves: { t: number; x: number; y: number }[] = [];
  private clicks: { t: number; x: number; y: number }[] = [];
  private keys: { t: number; del: boolean }[] = [];
  private selections: { t: number; text: string }[] = [];
  private lastY = 0;
  /** The press in progress: it becomes a click only if it ends without much movement, otherwise it was a drag (a stroke). */
  private press: { x: number; y: number; t: number; moved: number } | null = null;
  /** Running totals for the page (see PageStats). */
  keyTotal = 0;
  pointerTotal = 0;

  /**
   * `onInput` is told when the student does something that changes their work (a key press or the end of a stroke), so the page can report
   * it straight away instead of at the next tick: the first look at the new line then starts when they stop, not a second later.
   */
  constructor(private win: Window = window, private onInput?: () => void) {
    const opts = { capture: true, passive: true } as const;
    win.addEventListener('scroll', this.onScroll, opts);
    // Pointer events, not mouse events: a drawing app cancels `pointerdown` (so the page gets no mouse events at
    // all for that stroke, mouse included, per the Pointer Events spec), but a capture listener on the window
    // still sees every pointer event, whether it came from a mouse, a pen or a finger.
    win.addEventListener('pointermove', this.onMove, opts);
    win.addEventListener('pointerdown', this.onDown, opts);
    win.addEventListener('pointerup', this.onUp, opts);
    win.addEventListener('pointercancel', this.onCancel, opts);
    win.addEventListener('keydown', this.onKey, opts);
    win.addEventListener('mouseup', this.onSelect, opts);
    win.addEventListener('touchstart', this.touch, opts);
    this.lastY = win.scrollY;
  }

  dispose(): void {
    for (const [ev, fn] of [
      ['scroll', this.onScroll],
      ['pointermove', this.onMove],
      ['pointerdown', this.onDown],
      ['pointerup', this.onUp],
      ['pointercancel', this.onCancel],
      ['keydown', this.onKey],
      ['mouseup', this.onSelect],
      ['touchstart', this.touch],
    ] as const)
      this.win.removeEventListener(ev, fn as EventListener, true);
  }

  get scrollY(): number {
    return this.win.scrollY;
  }

  get idleMs(): number {
    return Date.now() - this.lastInputAt;
  }

  signals(now = Date.now()): Signal[] {
    this.prune(now);
    const out: Signal[] = [];

    // Re-reading: scroll direction reversals, especially scrolling back up to text already seen.
    const sc = within(this.scrolls, now, 30_000);
    let reversals = 0;
    for (let i = 1; i < sc.length; i++) if (sc[i].dir !== 0 && sc[i].dir !== sc[i - 1].dir) reversals++;
    if (reversals >= 3) out.push({ id: 'rereading', value: clamp01((reversals - 2) / 6), reason: `re-reading (scrolled back ×${Math.ceil(reversals / 2)})` });

    // Erratic mouse: a long path that goes nowhere over the last 10s.
    const mv = within(this.moves, now, 10_000);
    if (mv.length > 20) {
      let path = 0;
      for (let i = 1; i < mv.length; i++) path += Math.hypot(mv[i].x - mv[i - 1].x, mv[i].y - mv[i - 1].y);
      const disp = Math.hypot(mv[mv.length - 1].x - mv[0].x, mv[mv.length - 1].y - mv[0].y) + 50;
      const ratio = path / disp;
      if (path > 3000 && ratio > 6) out.push({ id: 'erraticMouse', value: clamp01((ratio - 6) / 10), reason: 'mouse wandering aimlessly' });
    }

    // Rage clicks: ≥3 clicks inside 1s and 30px.
    const ck = within(this.clicks, now, 60_000);
    let bursts = 0;
    for (let i = 2; i < ck.length; i++) {
      const a = ck[i - 2], c = ck[i];
      if (c.t - a.t < 1000 && Math.hypot(c.x - a.x, c.y - a.y) < 30) {
        bursts++;
        i += 2;
      }
    }
    if (bursts > 0) out.push({ id: 'rageClicks', value: clamp01(bursts / 2), reason: `rapid repeat clicks ×${bursts}` });

    // Backspace bursts: a high delete ratio in recent typing.
    const ks = within(this.keys, now, 30_000);
    const dels = ks.filter((k) => k.del).length;
    if (dels >= 8 && ks.length > 0) {
      const ratio = dels / ks.length;
      if (ratio > 0.25) out.push({ id: 'backspace', value: clamp01((ratio - 0.2) / 0.4), reason: `backspace bursts (${dels} deletes in 30s)` });
    }

    // Repeatedly highlighting the same text.
    const counts = new Map<string, number>();
    for (const s of within(this.selections, now, 120_000)) counts.set(s.text, (counts.get(s.text) ?? 0) + 1);
    let top: [string, number] | null = null;
    for (const e of counts) if (!top || e[1] > top[1]) top = e;
    if (top && top[1] >= 2) {
      const snippet = top[0].length > 24 ? top[0].slice(0, 24) + '…' : top[0];
      out.push({ id: 'repeatedSelection', value: clamp01((top[1] - 1) / 3), reason: `re-selected "${snippet}" ×${top[1]}` });
    }
    return out;
  }

  private touch = () => {
    this.lastInputAt = Date.now();
  };

  /**
   * An event that came from the sprite itself (a click on its buttons, a drag of its bubble). The page sees those retargeted to the sprite's
   * host element. They are the student being here (so `touch()` still counts), but they are not "mouse wandering", "rapid clicks" or work.
   */
  private fromSprite(e: Event): boolean {
    return (e.target as Element | null)?.id === 'myta-root';
  }

  private onScroll = () => {
    this.touch();
    const y = this.win.scrollY;
    const d = y - this.lastY;
    if (Math.abs(d) < 80) return;
    // Only count upward scrolls into territory already read as re-reading reversals.
    const dir = d > 0 ? 1 : y < this.maxScrollY - 100 ? -1 : 0;
    this.scrolls.push({ t: Date.now(), y, dir });
    this.maxScrollY = Math.max(this.maxScrollY, y);
    this.lastY = y;
  };

  private onMove = (e: PointerEvent) => {
    this.touch();
    if (this.fromSprite(e)) return;
    if (e.buttons) {
      // In contact (pressed, or a pen/finger touching): drawing or selecting. That is work, not wandering, so it
      // counts as input but stays out of the aimless-mouse analysis below.
      this.pointerTotal++;
      if (this.press) this.press.moved = Math.max(this.press.moved, Math.hypot(e.screenX - this.press.x, e.screenY - this.press.y));
      return;
    }
    const now = Date.now();
    const last = this.moves[this.moves.length - 1];
    if (!last || now - last.t > 50) this.moves.push({ t: now, x: e.screenX, y: e.screenY });
  };

  private onDown = (e: PointerEvent) => {
    this.touch();
    if (this.fromSprite(e)) return;
    this.pointerTotal++;
    this.press = { x: e.screenX, y: e.screenY, t: Date.now(), moved: 0 };
  };

  /** A press that ends where it began, quickly, is a click (and rapid repeats are rage clicks). A stroke is not. */
  private onUp = (e: PointerEvent) => {
    this.touch();
    if (this.fromSprite(e)) {
      this.press = null;
      return;
    }
    const p = this.press;
    this.press = null;
    if (p && p.moved < 12 && Date.now() - p.t < 700) this.clicks.push({ t: Date.now(), x: e.screenX, y: e.screenY });
    // The end of a stroke or a click on the page is when what's on screen has changed: report it now.
    this.onInput?.();
  };

  private onCancel = () => {
    this.press = null;
  };

  private onKey = (e: KeyboardEvent) => {
    this.touch();
    if (this.fromSprite(e)) return;
    // Browser autofill and some password managers dispatch keydown events with no `key`.
    const key = e.key ?? '';
    if (key.length === 1 || key === 'Backspace' || key === 'Delete') {
      this.keyTotal++;
      this.keys.push({ t: Date.now(), del: key === 'Backspace' || key === 'Delete' });
      this.onInput?.();
    }
  };

  private onSelect = () => {
    const text = this.win.getSelection()?.toString().trim().replace(/\s+/g, ' ') ?? '';
    if (text.length >= 3 && text.length <= 300) this.selections.push({ t: Date.now(), text: text.toLowerCase() });
  };

  private prune(now: number) {
    this.scrolls = within(this.scrolls, now, 30_000);
    this.moves = within(this.moves, now, 10_000);
    this.clicks = within(this.clicks, now, 60_000);
    this.keys = within(this.keys, now, 30_000);
    this.selections = within(this.selections, now, 120_000);
  }
}
