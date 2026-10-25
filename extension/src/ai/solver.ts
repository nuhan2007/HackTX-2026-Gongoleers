import type { PageContext } from '../shared/messages';
import type { SolverResult } from '../shared/types';
import { generateJson, type OpenAICtx, type Part } from './openaiClient';
import { SOLVER_SYSTEM } from './prompts';
import { SOLVER_SCHEMA } from './schemas';

export interface SolveInput {
  /** base64 JPEG of the visible tab. */
  tabImage?: string | null;
  /** Merged context from every frame of the tab (drawings included). */
  context?: PageContext | null;
  /** Plain problem text (used by the leak eval, which has no tab). */
  problemText?: string;
  /** Human-readable reasons the confusion engine fired. */
  stuckReasons?: string[];
}

function contextText(c: PageContext): string[] {
  return [
    `Page: ${c.title} (${c.url})`,
    c.selection && `Text the student selected:\n${c.selection}`,
    c.math.length ? `Math on the page (TeX source):\n${c.math.join('\n')}` : '',
    c.fields.length ? `Answer fields right now:\n${c.fields.map((f) => `- ${f.label}: ${f.value}`).join('\n')}` : '',
    c.workLog.length ? `What the student has been doing (oldest first):\n${c.workLog.map((w) => `- ${w}`).join('\n')}` : '',
    c.drawings.length ? `${c.drawings.length} snapshot(s) of what the student drew are attached after the tab image.` : '',
    c.viewportText && `Visible page text:\n${c.viewportText}`,
  ].filter(Boolean) as string[];
}

/** Call 1: the hidden solver. Its output stays in storage.session and is never sent to the UI. */
export async function solve(ctx: OpenAICtx, input: SolveInput): Promise<SolverResult> {
  const parts: Part[] = [];
  if (input.tabImage) parts.push({ imageBase64: input.tabImage });
  for (const d of input.context?.drawings ?? []) parts.push({ imageBase64: d });
  const textBits = [
    input.problemText && `Problem:\n${input.problemText}`,
    input.stuckReasons?.length && `Why we think the student is stuck: ${input.stuckReasons.join('; ')}`,
    ...(input.context ? contextText(input.context) : []),
  ].filter(Boolean);
  parts.push({ text: textBits.length ? textBits.join('\n\n') : 'Solve the problem shown in the tab image.' });

  const r = await generateJson<SolverResult>(ctx, {
    system: SOLVER_SYSTEM,
    parts,
    schema: SOLVER_SCHEMA,
    temperature: 0.1,
    effort: 'medium',
    timeoutMs: 60_000,
  });
  return {
    problemDetected: !!r.problemDetected,
    problemText: r.problemText ?? '',
    finalAnswer: r.finalAnswer ?? '',
    keySteps: r.keySteps ?? [],
    conceptTags: r.conceptTags ?? [],
    misconceptions: r.misconceptions ?? [],
    answerKeyPhrases: r.answerKeyPhrases ?? [],
    studentWork: r.studentWork ?? '',
  };
}
