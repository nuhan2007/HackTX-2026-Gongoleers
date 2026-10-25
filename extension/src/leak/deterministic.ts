// Deterministic answer-leak check: runs before the model judge and catches the obvious
// cases (equivalent numbers, the answer string, solution code lines, MC letters, key phrases).
import type { SolverResult } from '../shared/types';

export interface LeakVerdict {
  leaks: boolean;
  reason: string;
}

const OK: LeakVerdict = { leaks: false, reason: '' };

export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[−–—]/g, '-')
    .replace(/\*\*/g, '^')
    .replace(/[\s*\\$`'"]/g, '');
}

/** All numeric values in a string, with fractions and percents expanded to equivalent forms. */
export function extractNumbers(s: string): number[] {
  const text = s.replace(/[−–]/g, '-').replace(/(\d),(?=\d{3}\b)/g, '$1');
  const out: number[] = [];
  const re = /(-?\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)|(-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)\s*(%)?/gi;
  for (const m of text.matchAll(re)) {
    if (m[1] !== undefined) {
      const den = Number(m[2]);
      if (den !== 0) out.push(Number(m[1]) / den);
      // A fraction also contains its parts as plain numbers; keep them too.
      out.push(Number(m[1]), den);
    } else if (m[3] !== undefined) {
      const v = Number(m[3]);
      if (Number.isNaN(v)) continue;
      out.push(v);
      if (m[4]) out.push(v / 100);
    }
  }
  return out;
}

function sameNumber(answer: number, said: number): boolean {
  if (answer === said) return true;
  const scale = Math.max(1, Math.abs(answer));
  if (Math.abs(answer - said) <= 1e-9 * scale) return true;
  // A rounded version of a non-integer answer (3.14159 → 3.14) still gives it away.
  return !Number.isInteger(answer) && said !== 0 && Math.abs(answer - said) / Math.abs(answer) < 0.01;
}

const LOOKS_LIKE_CODE = /[;{}]|\breturn\b|\bfor\s*\(|\bwhile\s*\(|\bdef\s|\bpublic\s|=\s*new\s/;

/** Code, not maths written in LaTeX: "\\frac{12}{4}" and "x^{2}" have braces too, but they are formulas, and their numbers are the answer. */
function isCode(answer: string): boolean {
  const withoutLatex = answer
    .replace(/\$+[^$]*\$+/g, ' ')
    .replace(/\\[A-Za-z]+(?:\s*\{[^{}]*\})*/g, ' ')
    .replace(/[\^_]\{[^{}]*\}/g, ' ');
  return LOOKS_LIKE_CODE.test(withoutLatex);
}
const KEYWORDS = new Set(
  'public private protected static void return class new this while for else true false null final int double boolean string char long float print println system out args main length size'.split(' '),
);

/**
 * The values a milestone gives away ("V1 = 4.8 V"): numbers on the right of the last "=" in each checkpoint. Small whole numbers are left out,
 * since a hint that says "node 2" or "the 4 ohm resistor" must not be mistaken for one.
 */
function checkpointValues(hidden: SolverResult): number[] {
  const out: number[] = [];
  const secret = (n: number) => !Number.isInteger(n) || Math.abs(n) >= 5;
  for (const c of hidden.checkpoints ?? []) {
    const rhs = c.expected.includes('=') ? c.expected.slice(c.expected.lastIndexOf('=') + 1) : c.expected;
    // A whole milestone that is one short value is as good as the answer; an equation's right side is only the part after "=".
    for (const n of extractNumbers(rhs)) if (secret(n)) out.push(n);
    // A milestone that gives several values ("V1 = 4.8 V, V2 = 12 V") gives away the one after each "=", not just the last.
    for (const n of assignmentValues(c.expected)) if (secret(n)) out.push(n);
  }
  return out;
}

/** The values of an answer that gives several results ("V1 = 6 V, V2 = 12 V"): each one is as secret as a single answer would be. */
function assignmentValues(answer: string): number[] {
  if (isCode(answer)) return [];
  return [...answer.replace(/[−–]/g, '-').matchAll(/=\s*(-?\d+(?:\.\d+)?(?:e[-+]?\d+)?)/gi)].map((m) => Number(m[1])).filter(Number.isFinite);
}

export function deterministicLeak(message: string, hidden: SolverResult): LeakVerdict {
  const msg = normalize(message);
  const problem = normalize(hidden.problemText);
  const problemNums = [...extractNumbers(hidden.problemText), ...extractNumbers(hidden.givens ?? '')];
  const inProblem = (n: number) => problemNums.some((p) => p === n);

  // 1. Numbers from the final answer, key phrases and milestones (intermediate results), ignoring ones given in the problem.
  // Code and long expressions are matched as strings below instead; their constants (i = 0, 2x+3) are too common.
  const answerNums = extractNumbers(hidden.finalAnswer);
  const answerIsCode = isCode(hidden.finalAnswer);
  const numericAnswer = !answerIsCode && answerNums.length <= 3;
  // A long list of numbers (a table, a vector of results) can't have every small whole number in it counted, but its distinctive values still can.
  const distinct = !answerIsCode && answerNums.length > 3 ? answerNums.filter((n) => !Number.isInteger(n) || Math.abs(n) >= 10) : [];
  const secretNums = [...(numericAnswer ? answerNums : distinct), ...assignmentValues(hidden.finalAnswer), ...hidden.answerKeyPhrases.flatMap(extractNumbers), ...checkpointValues(hidden)].filter(
    (n) => !inProblem(n),
  );
  const saidNums = extractNumbers(message);
  for (const a of secretNums) {
    const hit = saidNums.find((s) => sameNumber(a, s));
    if (hit !== undefined) return { leaks: true, reason: `mentions ${hit}, which matches a value in the solution` };
  }

  // 2. The answer string itself (expressions like "2x+3", "O(n log n)").
  const ans = normalize(hidden.finalAnswer);
  const rhs = ans.includes('=') ? ans.slice(ans.lastIndexOf('=') + 1) : '';
  for (const a of [ans, rhs]) {
    if (a.length >= 3 && !problem.includes(a) && msg.includes(a)) return { leaks: true, reason: 'states the final answer' };
  }

  // 3. Multiple choice: the letter, or the option text paired with an endorsement.
  const mc0 = hidden.finalAnswer.match(/^\s*(?:\(|option\s+|choice\s+)?([A-Ea-e])(?:[).:]|\s|$)\s*(.*)$/i);
  // "d = 4" is a result for a variable called d, not the choice D.
  const mc = mc0 && !/^[=<>]/.test(mc0[2] ?? '') ? mc0 : null;
  if (mc) {
    const L = mc[1].toUpperCase();
    const letterRes = [
      new RegExp(`\\b(?:[Aa]nswer|[Oo]ption|[Cc]hoice)\\s*(?:is\\s*)?\\(?${L}\\)?(?![A-Za-z])`),
      new RegExp(`\\(${L}\\)`),
      new RegExp(`\\b${L}\\s+is\\s+(?:correct|right)`, 'i'),
    ];
    if (letterRes.some((re) => re.test(message))) return { leaks: true, reason: `points to choice ${L}` };
    const optText = normalize(mc[2] ?? '');
    if (optText.length >= 1) {
      const idx = msg.indexOf(optText);
      if (idx >= 0) {
        const around = msg.slice(Math.max(0, idx - 40), idx + optText.length + 40);
        if (/correct|rightanswer|theanswer|choose|pick|gowith|select/.test(around)) return { leaks: true, reason: 'endorses the correct option' };
      }
    }
  }

  // 4. Solution code: any substantial line, or several solution-specific identifiers in code-like text.
  if (answerIsCode) {
    for (const line of hidden.finalAnswer.split('\n')) {
      const l = normalize(line);
      if (l.length >= 10 && !problem.includes(l) && msg.includes(l)) return { leaks: true, reason: 'contains a line of the solution code' };
    }
    const problemLower = hidden.problemText.toLowerCase();
    const ids = new Set(
      (hidden.finalAnswer.match(/[A-Za-z_]\w{3,}/g) ?? []).filter((id) => !KEYWORDS.has(id.toLowerCase()) && !problemLower.includes(id.toLowerCase())),
    );
    const used = [...ids].filter((id) => new RegExp(`\\b${id}\\b`).test(message));
    if (used.length >= 2 && /[(=;]/.test(message)) return { leaks: true, reason: 'writes out solution code' };
  }

  // 5. Distinctive key phrases (intermediate results, key insight wording).
  // (The name of the method or concept isn't a secret: "node voltage analysis" is exactly what a good hint says.)
  const topics = [...(hidden.conceptTags ?? []), hidden.problemKind ?? ''].map(normalize).filter((t) => t.length >= 3);
  for (const p of hidden.answerKeyPhrases) {
    const np = normalize(p);
    if (topics.some((t) => np === t || (np.length <= t.length + 4 && t.includes(np)))) continue;
    if (np.length >= 4 && !problem.includes(np) && msg.includes(np)) return { leaks: true, reason: `reveals "${p}"` };
  }

  return OK;
}
