// Deterministic answer-leak check: runs before the Gemini judge and catches the obvious
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
const KEYWORDS = new Set(
  'public private protected static void return class new this while for else true false null final int double boolean string char long float print println system out args main length size'.split(' '),
);

export function deterministicLeak(message: string, hidden: SolverResult): LeakVerdict {
  const msg = normalize(message);
  const problem = normalize(hidden.problemText);
  const problemNums = extractNumbers(hidden.problemText);
  const inProblem = (n: number) => problemNums.some((p) => p === n);

  // 1. Numbers from the final answer and key phrases (intermediate results), ignoring ones given in the problem.
  // Code and long expressions are matched as strings below instead; their constants (i = 0, 2x+3) are too common.
  const answerNums = extractNumbers(hidden.finalAnswer);
  const numericAnswer = !LOOKS_LIKE_CODE.test(hidden.finalAnswer) && answerNums.length <= 3;
  const secretNums = [...(numericAnswer ? answerNums : []), ...hidden.answerKeyPhrases.flatMap(extractNumbers)].filter(
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
  const mc = hidden.finalAnswer.match(/^\s*(?:\(|option\s+|choice\s+)?([A-Ea-e])(?:[).:]|\s|$)\s*(.*)$/i);
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
  if (LOOKS_LIKE_CODE.test(hidden.finalAnswer)) {
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
  for (const p of hidden.answerKeyPhrases) {
    const np = normalize(p);
    if (np.length >= 4 && !problem.includes(np) && msg.includes(np)) return { leaks: true, reason: `reveals "${p}"` };
  }

  return OK;
}
