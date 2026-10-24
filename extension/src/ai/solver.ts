import type { PageContext } from '../shared/messages';
import type { SolverResult } from '../shared/types';
import { generateJson, type GeminiCtx, type Part } from './geminiClient';
import { SOLVER_SYSTEM } from './prompts';
import { SOLVER_SCHEMA } from './schemas';

/** Call 1: the hidden solver. Its output stays in storage.session and is never sent to the UI. */
export async function solve(ctx: GeminiCtx, image: string | null, context: PageContext | null, problemText?: string): Promise<SolverResult> {
  const parts: Part[] = [];
  if (image) parts.push({ inlineData: { mimeType: 'image/jpeg', data: image } });
  const textBits = [
    problemText && `Problem:\n${problemText}`,
    context?.selection && `Student-selected text:\n${context.selection}`,
    context?.viewportText && `Visible page text:\n${context.viewportText}`,
    context?.title && `Page title: ${context.title}`,
  ].filter(Boolean);
  parts.push({ text: textBits.length ? textBits.join('\n\n') : 'Solve the problem shown in the screenshot.' });

  const r = await generateJson<SolverResult>(ctx, {
    system: SOLVER_SYSTEM,
    parts,
    schema: SOLVER_SCHEMA,
    temperature: 0.1,
    timeoutMs: 30_000,
  });
  return {
    problemDetected: !!r.problemDetected,
    problemText: r.problemText ?? '',
    finalAnswer: r.finalAnswer ?? '',
    keySteps: r.keySteps ?? [],
    conceptTags: r.conceptTags ?? [],
    misconceptions: r.misconceptions ?? [],
    answerKeyPhrases: r.answerKeyPhrases ?? [],
  };
}
