import { DEFAULT_DIFFICULTY, MAX_DIFFICULTY, MIN_DIFFICULTY } from '../shared/constants';
import type { PageContext } from '../shared/messages';
import type { Checkpoint, Domain, SolverResult, WorkFormat } from '../shared/types';
import { generateJson, type LlmCtx, type Part } from './llmClient';
import { SOLVER_SYSTEM } from './prompts';
import { DOMAINS, SOLVER_SCHEMA, WORK_FORMATS } from './schemas';

type Raw = Partial<Record<keyof SolverResult | 'verification', unknown>>;

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean) : []);
const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

function checkpoints(v: unknown): Checkpoint[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((c) => ({ label: text((c as Checkpoint)?.label), expected: text((c as Checkpoint)?.expected) }))
    .filter((c) => c.label && c.expected)
    .slice(0, 8);
}

/** Tidies what the model said into a SolverResult: unknown names fall back to safe values, numbers are clamped. */
export function normalizeSolution(r: Raw): SolverResult {
  const domain = DOMAINS.includes(r.domain as Domain) ? (r.domain as Domain) : 'other';
  const workFormat = WORK_FORMATS.includes(r.workFormat as WorkFormat) ? (r.workFormat as WorkFormat) : 'equations';
  const confidence = r.keyConfidence === 'low' || r.keyConfidence === 'medium' ? r.keyConfidence : 'high';
  const minutes = Math.round(Number(r.expectedMinutes));
  return {
    problemDetected: !!r.problemDetected,
    problemText: text(r.problemText),
    finalAnswer: text(r.finalAnswer),
    keySteps: strings(r.keySteps),
    conceptTags: strings(r.conceptTags),
    misconceptions: strings(r.misconceptions),
    answerKeyPhrases: strings(r.answerKeyPhrases),
    difficulty: Math.min(MAX_DIFFICULTY, Math.max(MIN_DIFFICULTY, Math.round(Number(r.difficulty) || DEFAULT_DIFFICULTY))),
    problemKind: text(r.problemKind),
    domain,
    workFormat,
    givens: text(r.givens),
    checkpoints: checkpoints(r.checkpoints),
    keyConfidence: confidence,
    expectedMinutes: Number.isFinite(minutes) && minutes > 0 ? Math.min(180, minutes) : undefined,
  };
}

/**
 * Call 1: the hidden solver. Its output stays in storage.session and is never sent to the UI. It runs on the stronger model, with
 * room to think, and reads figures (a circuit's schematic) from the screenshot, because every later message is checked against it.
 */
export async function solve(ctx: LlmCtx, image: string | null, context: PageContext | null, problemText?: string): Promise<SolverResult> {
  const parts: Part[] = [];
  if (image) parts.push({ image });
  const textBits = [
    problemText && `Problem:\n${problemText}`,
    context?.question && `Question the student is working on: ${context.question}`,
    context?.selection && `Student-selected text:\n${context.selection}`,
    context?.viewportText && `Visible page text:\n${context.viewportText}`,
    context?.title && `Page title: ${context.title}`,
  ].filter(Boolean);
  parts.push({ text: textBits.length ? textBits.join('\n\n') : 'Solve the problem shown in the screenshot.' });

  const r = await generateJson<Raw>(ctx, {
    system: SOLVER_SYSTEM,
    parts,
    schema: SOLVER_SCHEMA,
    schemaName: 'private_solution',
    kind: 'solve',
    tier: 'smart',
    effort: 'medium',
    maxTokens: 12_000,
    temperature: 0.1,
    timeoutMs: 120_000,
  });
  return normalizeSolution(r);
}
