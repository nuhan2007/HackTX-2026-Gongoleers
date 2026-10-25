// Measures what kind of page this is from its structure, for the role scoring in shared/pageRole.ts: is there a canvas
// filling the screen, a toolbar of drawing tools, a big writing area (a board or a document)? Or answer boxes, a "Check"
// button, numbered questions and a paragraph of problem text (a homework page)? Cheap enough to run every few seconds.
import type { RoleHints } from '../shared/pageRole';

const TOOL_WORDS = /\b(pen|pencil|eraser|brush|marker|highlighter|lasso|shapes?|rectangle|ellipse|line|arrow|undo|redo|colou?rs?|stroke|fill|draw|sketch|select|hand|text|sticky|clear( all)?)\b/i;
const CHECK_BUTTON = /^(check( answer| my answer| work)?|submit( answer)?|done|check it|answer)$/i;
const PROBLEM_CUES = /\b(solve|find|calculate|evaluate|simplify|determine|compute|what is|how many|how much|prove|show that|factor|expand|graph|which of the following)\b|[=?]/gi;
const QUESTION_LABEL = /\b(?:Question|Q|Problem|Exercise)\s*#?\s*(\d+)\b/gi;

/** Big pages have thousands of controls; a page's character shows in the first few hundred. */
const first = <T,>(list: Iterable<T>, n: number): T[] => {
  const out: T[] = [];
  for (const x of list) if (out.push(x) >= n) break;
  return out;
};

const visible = (el: Element): DOMRect | null => {
  if (el.closest('#myta-root')) return null;
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return null;
  if (r.bottom <= 0 || r.right <= 0 || r.top >= innerHeight || r.left >= innerWidth) return null;
  const cs = getComputedStyle(el);
  if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) return null;
  return r;
};

/** The share of the window an element covers (clipped to the window). */
function share(r: DOMRect): number {
  const w = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0));
  const h = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
  return (w * h) / Math.max(1, innerWidth * innerHeight);
}

export function readRoleHints(): RoleHints {
  let canvasShare = 0;
  for (const c of first(document.querySelectorAll('canvas'), 20)) {
    const r = visible(c);
    if (r) canvasShare = Math.max(canvasShare, share(r));
  }

  let editorShare = 0;
  let oneLineFields = 0;
  for (const el of first(document.querySelectorAll<HTMLElement>('textarea, [contenteditable=""], [contenteditable=true], [role=textbox], input'), 200)) {
    const r = visible(el);
    if (!r) continue;
    const isInput = el instanceof HTMLInputElement;
    if (isInput && /^(hidden|submit|button|reset|image|search|file|checkbox|radio|range|color)$/i.test(el.type)) {
      if (/^(checkbox|radio)$/i.test(el.type)) oneLineFields++;
      continue;
    }
    if (isInput || r.height < 60) oneLineFields++;
    else editorShare = Math.max(editorShare, share(r));
  }

  let toolButtons = 0;
  let checkButton = false;
  for (const b of first(document.querySelectorAll<HTMLElement>('button, [role=button], input[type=submit], [role=radio], [role=tab]'), 300)) {
    if (!visible(b)) continue;
    const label = ((b as HTMLInputElement).value || b.getAttribute('aria-label') || b.getAttribute('title') || b.textContent || '').trim().slice(0, 40);
    if (CHECK_BUTTON.test(label)) checkButton = true;
    else if (label && TOOL_WORDS.test(label)) toolButtons++;
    else if (!label && (b.querySelector('svg, img') || b.className)) {
      // An icon-only button: a toolbar full of them next to a canvas is a drawing app.
      const cls = `${b.className ?? ''} ${b.id ?? ''}`;
      if (typeof cls === 'string' && TOOL_WORDS.test(cls)) toolButtons++;
    }
  }

  const text = (document.body?.innerText ?? '').slice(0, 4000);
  const labels = new Set<string>();
  for (const m of text.matchAll(QUESTION_LABEL)) labels.add(m[1]);
  const cues = (text.match(PROBLEM_CUES) ?? []).length;

  return {
    canvasShare: Math.round(canvasShare * 100) / 100,
    editorShare: Math.round(editorShare * 100) / 100,
    toolButtons: Math.min(toolButtons, 20),
    answerFields: oneLineFields,
    checkButton,
    questionLabels: Math.min(labels.size, 20),
    textLen: text.length,
    problemCues: Math.min(cues, 50),
  };
}
