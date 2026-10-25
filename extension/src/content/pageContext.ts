// "Look at the tab": everything Gongo can read from this frame when the student asks for help.
// The service worker merges every frame and adds an image of the visible tab.
import type { PageContext } from '../shared/messages';
import { fieldLabel, fieldValue, type WorkLog } from './workLog';

const MAX_TEXT = 6000;
const MAX_DRAWINGS = 2;
const DRAWING_MAX_W = 900;

function isVisible(el: Element): boolean {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
}

function visibleText(): string {
  const chunks: string[] = [];
  let total = 0;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const el = node.parentElement;
      if (!el || el.closest('script, style, noscript, #gongo-root, annotation, mjx-assistive-mml')) return NodeFilter.FILTER_REJECT;
      if (!node.textContent?.trim()) return NodeFilter.FILTER_SKIP;
      return isVisible(el) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    },
  });
  for (let n = walker.nextNode(); n && total < MAX_TEXT; n = walker.nextNode()) {
    const t = n.textContent!.replace(/\s+/g, ' ').trim();
    chunks.push(t);
    total += t.length + 1;
  }
  return chunks.join(' ').slice(0, MAX_TEXT);
}

/** Rendered math loses its structure as plain text, so pull the source TeX where pages keep it. */
function mathSource(): string[] {
  const out = new Set<string>();
  document.querySelectorAll('annotation[encoding="application/x-tex"]').forEach((a) => out.add(a.textContent!.trim()));
  document.querySelectorAll('script[type^="math/tex"]').forEach((s) => out.add(s.textContent!.trim()));
  document.querySelectorAll<HTMLImageElement>('img[alt]').forEach((img) => {
    if (/[\\^_]|\\frac/.test(img.alt) && isVisible(img)) out.add(img.alt.trim());
  });
  return [...out].filter(Boolean).slice(0, 30);
}

function answerFields(): { label: string; value: string }[] {
  const out: { label: string; value: string }[] = [];
  document
    .querySelectorAll('input:not([type=hidden]):not([type=password]):not([type=submit]):not([type=button]), textarea, select, [contenteditable=true]')
    .forEach((el) => {
      if (out.length >= 20 || el.closest('#gongo-root') || !isVisible(el)) return;
      const value = fieldValue(el).trim();
      out.push({ label: fieldLabel(el), value: value ? value.slice(0, 500) : '(empty)' });
    });
  return out;
}

/** Snapshots of visible canvases (whiteboards, handwriting pads) on a white background. */
function drawings(): string[] {
  const out: string[] = [];
  for (const c of document.querySelectorAll('canvas')) {
    if (out.length >= MAX_DRAWINGS) break;
    const r = c.getBoundingClientRect();
    if (r.width < 120 || r.height < 120 || !isVisible(c) || c.width === 0) continue;
    try {
      const scale = Math.min(1, DRAWING_MAX_W / c.width);
      const t = document.createElement('canvas');
      t.width = Math.round(c.width * scale);
      t.height = Math.round(c.height * scale);
      const g = t.getContext('2d')!;
      g.fillStyle = '#fff';
      g.fillRect(0, 0, t.width, t.height);
      g.drawImage(c, 0, 0, t.width, t.height);
      out.push(t.toDataURL('image/jpeg', 0.85).replace(/^data:image\/jpeg;base64,/, ''));
    } catch {
      // Cross-origin (tainted) canvas: the tab image still shows it.
    }
  }
  return out;
}

export function readPageContext(log: WorkLog): PageContext {
  return {
    url: location.href,
    title: document.title,
    selection: window.getSelection()?.toString().trim().slice(0, 1500) ?? '',
    viewportText: visibleText(),
    math: mathSource(),
    fields: answerFields(),
    workLog: log.recent(),
    drawings: drawings(),
  };
}
