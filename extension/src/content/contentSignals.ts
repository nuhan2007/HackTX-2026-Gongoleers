// Page-content cues: wrong-answer feedback after a submit, repeated submissions,
// the same error text showing up again and again, and edit-and-resubmit loops.
import type { Signal } from '../shared/types';

export const INCORRECT_RE = /\b(incorrect|wrong( answer)?|try again|not quite|not correct|that's not right|that is not right)\b|✗|❌/i;
// "Correct!" on its own (no word after it) has no word boundary to end on, so it is matched as its own case.
export const CORRECT_RE = /\b(correct[!.]|well done|great job|all tests passed|accepted|nice work|you got it|that's right|that is right|keep it up)|^\s*correct\s*$|✅|✓/i;
const SUBMIT_RE = /\b(submit|check|run|test|grade|verify|answer|go)\b/i;
const ERROR_RE = /\b([A-Z][A-Za-z]*(Exception|Error))\b|\berror:|\bfailed\b|\bexpected\b.{1,60}\bbut\b|\btraceback\b/;
const ERROR_CLASS_RE = /error|invalid|incorrect|wrong|danger/i;

// A click on one of these means "I'm done with this one" (checked on the first words of the control's label).
const MOVE_ON_RE = /^(next( question| problem| page| step)?|continue|skip|finish|move on|go to (the )?next|submit (quiz|test|exam|assignment))\b/i;
// Only a switch between real numbered questions counts as moving on, not between parts or fields of one problem.
const NUMBERED_QUESTION_RE = /^(Q\d|Problem \d|Exercise \d)/;

const FEEDBACK_WINDOW_MS = 4000;
const MEMORY_MS = 5 * 60_000;

interface QuestionStats {
  label: string;
  submits: number[];
  incorrect: number[];
  answerChanges: number[];
  lastAnswer: string | null;
}

export class ContentSignals {
  private questions = new Map<string, QuestionStats>();
  private errorCounts = new Map<string, { name: string; times: number[] }>();
  private lastSubmit: { at: number; key: string } | null = null;
  private lastIncorrectAt = 0;
  private current: string = '';
  /** Questions the student has typed in or submitted on; leaving one of these counts as moving on. */
  private touched = new Set<string>();
  /** Running totals for the page (see PageStats). */
  incorrectTotal = 0;
  correctTotal = 0;
  submitTotal = 0;
  private lastCorrectAt = 0;
  private lastProgressAt = Date.now();
  private observer: MutationObserver;

  constructor(private doc: Document = document, private onMoveOn?: (reason: string) => void) {
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
    return this.stats(this.current).label;
  }

  get dwellMs(): number {
    return Date.now() - this.lastProgressAt;
  }

  signals(now = Date.now()): Signal[] {
    const out: Signal[] = [];
    const q = this.stats(this.current);
    const recent = (ts: number[]) => ts.filter((t) => now - t < MEMORY_MS).length;

    const wrong = recent(q.incorrect);
    if (wrong > 0)
      out.push({ id: 'incorrect', value: wrong === 1 ? 0.55 : wrong === 2 ? 0.85 : 1, reason: `${wrong} incorrect ${wrong === 1 ? 'answer' : 'submissions'} on ${q.label}` });

    const subs = recent(q.submits);
    if (subs >= 2) out.push({ id: 'resubmits', value: Math.min(1, (subs - 1) / 3), reason: `${subs} submissions on ${q.label}` });

    const edits = recent(q.answerChanges);
    if (edits >= 2)
      out.push({ id: 'editResubmit', value: Math.min(1, (edits - 1) / 3), reason: `answer changed ${edits}× and resubmitted` });

    let worst: { name: string; n: number } | null = null;
    for (const e of this.errorCounts.values()) {
      const n = recent(e.times);
      if (n >= 2 && (!worst || n > worst.n)) worst = { name: e.name, n };
    }
    if (worst) out.push({ id: 'repeatedError', value: Math.min(1, (worst.n - 1) / 3), reason: `same ${worst.name} ×${worst.n}` });

    return out;
  }

  // ---- event handlers ----

  private onClick = (e: Event) => {
    const el = (e.target as Element | null)?.closest?.('button, input[type=submit], input[type=button], [role=button], a');
    if (!el) return;
    const text = (el as HTMLInputElement).value || el.textContent || el.getAttribute('aria-label') || '';
    if (SUBMIT_RE.test(text.trim().slice(0, 40))) this.recordSubmit(el);
    if (MOVE_ON_RE.test(text.trim().slice(0, 30))) this.onMoveOn?.(`clicked "${text.trim().slice(0, 20)}"`);
  };

  private onSubmit = (e: Event) => this.recordSubmit(e.target as Element);

  private onInput = (e: Event) => {
    this.lastProgressAt = Date.now();
    const key = this.questionKeyFor(e.target as Element);
    this.touched.add(key);
    this.setCurrent(key);
  };

  // Ctrl/Cmd+Enter is a common "run" shortcut in online IDEs.
  private onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) this.recordSubmit(e.target as Element);
  };

  private recordSubmit(el: Element) {
    const now = Date.now();
    // Clicking a button and the form's submit event fire together; count once.
    if (this.lastSubmit && now - this.lastSubmit.at < 500) return;
    const key = this.questionKeyFor(el);
    this.touched.add(key);
    this.setCurrent(key);
    const q = this.stats(key);
    q.submits.push(now);
    this.submitTotal++;
    const answer = this.answerValue(el);
    if (answer !== null) {
      if (q.lastAnswer !== null && answer !== q.lastAnswer) q.answerChanges.push(now);
      q.lastAnswer = answer;
    }
    this.lastSubmit = { at: now, key };
  }

  private onMutations = (records: MutationRecord[]) => {
    const now = Date.now();
    const afterSubmit = this.lastSubmit && now - this.lastSubmit.at < FEEDBACK_WINDOW_MS;
    for (const r of records) {
      const nodes: Node[] = r.type === 'characterData' ? [r.target] : Array.from(r.addedNodes);
      for (const node of nodes) {
        const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
        if (!el || el.closest('#myta-root')) continue;
        const text = (node.textContent ?? '').trim();
        if (!text || text.length > 2000) continue;

        if (afterSubmit && this.lastSubmit) {
          const looksWrong = INCORRECT_RE.test(text) || (ERROR_CLASS_RE.test(el.className?.toString?.() ?? '') && text.length < 200);
          if (CORRECT_RE.test(text) && !INCORRECT_RE.test(text)) {
            if (now - this.lastCorrectAt > 1000) {
              this.correctTotal++;
              this.lastCorrectAt = now;
            }
            this.resetQuestion(this.lastSubmit.key);
          } else if (looksWrong && now - this.lastIncorrectAt > 1000) {
            this.stats(this.lastSubmit.key).incorrect.push(now);
            this.incorrectTotal++;
            this.lastIncorrectAt = now;
          }
        }

        const m = text.match(ERROR_RE);
        if (m) this.recordError(m[1] ?? m[0].trim(), text);
      }
    }
  };

  private recordError(name: string, text: string) {
    // Same error, different line numbers → same hash.
    const firstLine = text.split('\n').find((l) => ERROR_RE.test(l)) ?? text;
    const key = firstLine.replace(/\d+/g, '#').replace(/\s+/g, ' ').slice(0, 160);
    const now = Date.now();
    const entry = this.errorCounts.get(key) ?? { name, times: [] };
    if (now - (entry.times[entry.times.length - 1] ?? 0) > 1000) entry.times.push(now);
    this.errorCounts.set(key, entry);
  }

  private resetQuestion(key: string) {
    const q = this.stats(key);
    q.incorrect = [];
    q.submits = [];
    q.answerChanges = [];
    this.errorCounts.clear();
    this.lastProgressAt = Date.now();
  }

  private setCurrent(key: string) {
    if (key !== this.current) {
      const prev = this.current;
      this.current = key;
      this.lastProgressAt = Date.now();
      if (this.touched.has(prev) && NUMBERED_QUESTION_RE.test(prev) && NUMBERED_QUESTION_RE.test(key)) {
        this.onMoveOn?.(`moved from ${prev} to ${key}`);
      }
    }
  }

  private stats(key: string): QuestionStats {
    let q = this.questions.get(key);
    if (!q) {
      q = { label: key, submits: [], incorrect: [], answerChanges: [], lastAnswer: null };
      this.questions.set(key, q);
    }
    return q;
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
      'input:not([type=submit]):not([type=button]):not([type=hidden]), textarea, [contenteditable=true]',
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
