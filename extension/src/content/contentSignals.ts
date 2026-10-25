// What the student is working on: the current question label, how long since they made progress,
// and a log of what they submitted or saw (context for the tutor). It deliberately does NOT
// judge whether an answer was right or wrong; confusion comes from activity and the face.
import type { WorkLog } from './workLog';

const SUBMIT_RE = /\b(submit|check|run|test|grade|verify|answer|go)\b/i;
const ERROR_RE = /\b([A-Z][A-Za-z]*(Exception|Error))\b|\berror:|\bfailed\b|\btraceback\b/;

export class ContentSignals {
  private lastSubmitAt = 0;
  private lastErrorAt = 0;
  private current = '';
  private lastProgressAt = Date.now();
  private observer: MutationObserver;

  constructor(private log: WorkLog | null = null, private doc: Document = document) {
    doc.addEventListener('click', this.onClick, true);
    doc.addEventListener('submit', this.onSubmit, true);
    doc.addEventListener('input', this.onInput, true);
    doc.addEventListener('keydown', this.onKey, true);
    this.observer = new MutationObserver(this.onMutations);
    this.observer.observe(doc.documentElement, { childList: true, subtree: true, characterData: true });
    this.current = this.questionKeyFor(doc.body);
  }

  dispose(): void {
    this.observer.disconnect();
    this.doc.removeEventListener('click', this.onClick, true);
    this.doc.removeEventListener('submit', this.onSubmit, true);
    this.doc.removeEventListener('input', this.onInput, true);
    this.doc.removeEventListener('keydown', this.onKey, true);
  }

  get questionLabel(): string {
    return this.current;
  }

  /** ms on the current question without new input. */
  get dwellMs(): number {
    return Date.now() - this.lastProgressAt;
  }

  // ---- event handlers ----

  private onClick = (e: Event) => {
    const el = (e.target as Element | null)?.closest?.('button, input[type=submit], input[type=button], [role=button], a');
    if (!el) return;
    const text = (el as HTMLInputElement).value || el.textContent || el.getAttribute('aria-label') || '';
    if (SUBMIT_RE.test(text.trim().slice(0, 40))) this.recordSubmit(el);
  };

  private onSubmit = (e: Event) => this.recordSubmit(e.target as Element);

  private onInput = (e: Event) => {
    this.lastProgressAt = Date.now();
    this.setCurrent(this.questionKeyFor(e.target as Element));
  };

  // Ctrl/Cmd+Enter is a common "run" shortcut in online IDEs.
  private onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) this.recordSubmit(e.target as Element);
  };

  private recordSubmit(el: Element) {
    const now = Date.now();
    // Clicking a button and the form's submit event fire together; count once.
    if (now - this.lastSubmitAt < 500) return;
    this.lastSubmitAt = now;
    const key = this.questionKeyFor(el);
    this.setCurrent(key);
    const answer = this.answerValue(el);
    this.log?.add(`submitted ${key}${answer ? `: "${answer.slice(0, 160)}"` : ''}`);
  }

  // Error output (stack traces, compiler errors) goes in the log so the tutor can see it.
  private onMutations = (records: MutationRecord[]) => {
    const now = Date.now();
    if (now - this.lastErrorAt < 1000) return;
    for (const r of records) {
      const nodes: Node[] = r.type === 'characterData' ? [r.target] : Array.from(r.addedNodes);
      for (const node of nodes) {
        const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
        if (!el || el.closest('#gongo-root')) continue;
        const text = (node.textContent ?? '').trim();
        if (!text || text.length > 2000) continue;
        const line = text.split('\n').find((l) => ERROR_RE.test(l));
        if (line) {
          this.lastErrorAt = now;
          this.log?.add(`error shown: "${line.trim().slice(0, 140)}"`);
          return;
        }
      }
    }
  };

  private setCurrent(key: string) {
    if (key !== this.current) {
      this.current = key;
      this.lastProgressAt = Date.now();
    }
  }

  /** Nearest "Q4"/"Question 4"/"Problem 2" label, else the nearest heading, else the page title. */
  private questionKeyFor(el: Element | null): string {
    const LABEL_RE = /\b(Q(?:uestion)?|Problem|Exercise|Part)\s*#?\s*(\d+[a-z]?)\b/i;
    for (let cur: Element | null = el; cur && cur !== this.doc.documentElement; cur = cur.parentElement) {
      const own = cur.getAttribute?.('data-question') || cur.id;
      if (own && LABEL_RE.test(own)) return normalizeLabel(own.match(LABEL_RE)!);
      const heading = cur.querySelector?.(':scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > legend, :scope > label');
      const ht = heading?.textContent?.trim();
      if (ht) {
        const m = ht.match(LABEL_RE);
        return m ? normalizeLabel(m) : ht.slice(0, 40);
      }
    }
    return (this.doc.title || 'this problem').slice(0, 40);
  }

  private answerValue(el: Element): string | null {
    const scope = el.closest('form') ?? el.closest('section, article, fieldset, div') ?? this.doc.body;
    const fields = scope.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
      'input:not([type=submit]):not([type=button]):not([type=hidden]):not([type=password]), textarea, [contenteditable=true]',
    );
    if (fields.length === 0) return null;
    return Array.from(fields)
      .map((f) => (f as HTMLElement).isContentEditable ? f.textContent ?? '' : f.type === 'radio' || f.type === 'checkbox' ? String((f as HTMLInputElement).checked) : f.value)
      .join('|');
  }
}

function normalizeLabel(m: RegExpMatchArray): string {
  const kind = m[1].toLowerCase().startsWith('q') ? 'Q' : m[1][0].toUpperCase() + m[1].slice(1).toLowerCase() + ' ';
  return `${kind}${m[2]}`;
}
