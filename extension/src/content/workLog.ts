// A short, human-readable log of what the student has been doing in this frame: what they typed
// (as before → after edits, not raw keystrokes), what they submitted, what feedback came back,
// and whether they've been drawing. Read only when the student asks Gongo for help.

const MAX_ENTRIES = 40;
const EDIT_SETTLE_MS = 1500;
const MAX_AGE_MS = 10 * 60_000;
const clip = (s: string, n = 160) => (s.length > n ? `${s.slice(0, n)}…` : s);

function isPrivateField(el: Element): boolean {
  if (!(el instanceof HTMLInputElement)) return false;
  return el.type === 'password' || /cc-|password|one-time-code/.test(el.autocomplete ?? '');
}

/** Best human label for a form field: <label>, aria-label, placeholder, name. */
export function fieldLabel(el: Element): string {
  const id = el.getAttribute('id');
  const forLabel = id ? el.ownerDocument.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent : null;
  const label =
    forLabel ||
    el.closest('label')?.textContent ||
    el.getAttribute('aria-label') ||
    el.getAttribute('placeholder') ||
    el.getAttribute('name') ||
    ((el as HTMLElement).isContentEditable ? 'editor' : el.tagName.toLowerCase());
  return clip(label.replace(/\s+/g, ' ').trim(), 50);
}

export function fieldValue(el: Element): string {
  if ((el as HTMLElement).isContentEditable) return el.textContent ?? '';
  if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) return el.checked ? 'checked' : 'unchecked';
  return (el as HTMLInputElement | HTMLTextAreaElement).value ?? '';
}

export class WorkLog {
  private entries: { t: number; text: string }[] = [];
  private pending = new Map<Element, { before: string; timer: number }>();
  private strokes: { t: number; target: string }[] = [];
  private stroke: { target: string; dist: number; x: number; y: number } | null = null;

  constructor(doc: Document = document) {
    doc.addEventListener('input', this.onInput, true);
    doc.addEventListener('pointerdown', this.onPointerDown, { capture: true, passive: true });
    doc.addEventListener('pointermove', this.onPointerMove, { capture: true, passive: true });
    doc.addEventListener('pointerup', this.onPointerUp, { capture: true, passive: true });
  }

  add(text: string): void {
    this.entries.push({ t: Date.now(), text });
    if (this.entries.length > MAX_ENTRIES) this.entries.shift();
  }

  /** Oldest first, with relative times, e.g. "2m ago: submitted Q4: "30x(3x^2+1)^5"". */
  recent(now = Date.now()): string[] {
    this.flushAll();
    const ago = (t: number) => {
      const s = Math.round((now - t) / 1000);
      return s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`;
    };
    const out = this.entries.filter((e) => now - e.t < MAX_AGE_MS).map((e) => `${ago(e.t)}: ${e.text}`);
    const recentStrokes = this.strokes.filter((s) => now - s.t < 2 * 60_000);
    if (recentStrokes.length) {
      const where = [...new Set(recentStrokes.map((s) => s.target))].join(', ');
      out.push(`in the last 2 min: drew ${recentStrokes.length} pen/mouse strokes on the ${where} (see the drawing images)`);
    }
    return out;
  }

  private onInput = (e: Event) => {
    const el = e.target as Element;
    if (!el || isPrivateField(el) || el.closest?.('#gongo-root')) return;
    const p = this.pending.get(el);
    if (p) clearTimeout(p.timer);
    // `before` is the value when this burst of typing started.
    const before = p?.before ?? this.lastValues.get(el) ?? '';
    const timer = window.setTimeout(() => this.flush(el), EDIT_SETTLE_MS);
    this.pending.set(el, { before, timer });
  };

  private lastValues = new WeakMap<Element, string>();

  private flush(el: Element) {
    const p = this.pending.get(el);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(el);
    const after = fieldValue(el);
    this.lastValues.set(el, after);
    if (after === p.before) return;
    const label = fieldLabel(el);
    if (!p.before) this.add(`typed into "${label}": "${clip(after)}"`);
    else if (!after) this.add(`erased "${label}" (was "${clip(p.before)}")`);
    else this.add(`changed "${label}" from "${clip(p.before)}" to "${clip(after)}"`);
  }

  private flushAll() {
    for (const el of [...this.pending.keys()]) this.flush(el);
  }

  private onPointerDown = (e: PointerEvent) => {
    const t = e.target as Element;
    const surface = t?.closest?.('canvas, svg');
    if (!surface || surface.closest('#gongo-root')) return;
    this.stroke = { target: surface.tagName.toLowerCase() === 'canvas' ? 'canvas' : 'drawing area', dist: 0, x: e.clientX, y: e.clientY };
  };

  private onPointerMove = (e: PointerEvent) => {
    if (!this.stroke || e.buttons === 0) return;
    this.stroke.dist += Math.hypot(e.clientX - this.stroke.x, e.clientY - this.stroke.y);
    this.stroke.x = e.clientX;
    this.stroke.y = e.clientY;
  };

  private onPointerUp = () => {
    if (this.stroke && this.stroke.dist > 12) {
      this.strokes.push({ t: Date.now(), target: this.stroke.target });
      if (this.strokes.length > 500) this.strokes.shift();
    }
    this.stroke = null;
  };
}
