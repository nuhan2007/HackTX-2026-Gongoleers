import type { PageContext } from '../shared/messages';

const MAX_CHARS = 4000;

/** Selected text plus the text currently visible in the viewport (only sent after the student clicks Send). */
export function readPageContext(): PageContext {
  const selection = window.getSelection()?.toString().trim().slice(0, 1500) ?? '';
  const chunks: string[] = [];
  let total = 0;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const el = node.parentElement;
      if (!el || el.closest('script, style, noscript, #gongo-root')) return NodeFilter.FILTER_REJECT;
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
  // Include current values of answer fields so Gemini sees the student's work.
  for (const f of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input[type=text], input:not([type]), textarea')) {
    if (f.value && total < MAX_CHARS) {
      chunks.push(`[student input: ${f.value.slice(0, 300)}]`);
      total += f.value.length;
    }
  }
  return { selection, viewportText: chunks.join(' ').slice(0, MAX_CHARS), url: location.href, title: document.title };
}
