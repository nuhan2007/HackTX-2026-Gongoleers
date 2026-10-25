import type { PageContext } from '../shared/messages';
import { readRoleHints } from './roleHints';

const MAX_CHARS = 4000;

/**
 * Selected text plus the text currently visible in the viewport, including what's typed in answer fields.
 * myTA reads this while a tutor session is running; it only leaves the device inside a model request.
 */
export function readPageContext(question?: string): PageContext {
  const selection = window.getSelection()?.toString().trim().slice(0, 1500) ?? '';
  const chunks: string[] = [];
  let total = 0;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const el = node.parentElement;
      if (!el || el.closest('script, style, noscript, #myta-root')) return NodeFilter.FILTER_REJECT;
      if (!node.textContent?.trim()) return NodeFilter.FILTER_SKIP;
      const r = el.getBoundingClientRect();
      const visible = r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth && r.width > 0;
      return visible ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    },
  });
  for (let n = walker.nextNode(); n && total < MAX_CHARS; n = walker.nextNode()) {
    const t = n.textContent!.replace(/\s+/g, ' ').trim();
    chunks.push(t);
    total += t.length + 1;
  }
  // Include current values of answer fields so the model sees the student's work.
  for (const f of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input[type=text], input:not([type]), textarea')) {
    if (f.value && total < MAX_CHARS) {
      chunks.push(`[student input: ${f.value.slice(0, 300)}]`);
      total += f.value.length;
    }
  }
  return { selection, viewportText: chunks.join(' ').slice(0, MAX_CHARS), url: location.href, title: document.title, question, fields: countAnswerFields(), roleHints: readRoleHints() };
}

const ANSWER_FIELDS = [
  'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]):not([type=image]):not([type=search]):not([type=file])',
  'textarea',
  'select',
  '[contenteditable=""]',
  '[contenteditable=true]',
  '[role=textbox]:not([role=searchbox])',
].join(',');

const CHECK_BUTTON = /^(check( answer| my answer| work)?|submit( answer)?|done|check it)$/i;

/**
 * Visible places to type or choose an answer, plus a visible "Check" button (an exercise whose answer is a drag-and-drop or a
 * graph has no text box, but it has one of those). A search box doesn't count; a page with none of these is rarely a problem.
 */
function countAnswerFields(): number {
  let n = 0;
  for (const el of document.querySelectorAll<HTMLElement>(ANSWER_FIELDS)) {
    if (el.closest('#myta-root, form[role=search]') || el.getClientRects().length === 0) continue;
    n++;
  }
  for (const b of document.querySelectorAll<HTMLElement>('button, [role=button], input[type=submit]')) {
    if (b.closest('#myta-root') || b.getClientRects().length === 0) continue;
    const label = ((b as HTMLInputElement).value || b.textContent || b.getAttribute('aria-label') || '').trim();
    if (CHECK_BUTTON.test(label)) n++;
  }
  return n;
}
