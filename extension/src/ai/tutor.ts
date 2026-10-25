import type { ChatMessage, HintLevel, SolverResult, TutorAction, TutorTurn } from '../shared/types';
import { generateJson, type OpenAICtx } from './openaiClient';
import { GRADE_SYSTEM, JUDGE_SYSTEM, TUTOR_SYSTEM } from './prompts';
import { GRADE_SCHEMA, JUDGE_SCHEMA, TUTOR_SCHEMA } from './schemas';

export interface TutorTurnArgs {
  hidden: SolverResult;
  history: ChatMessage[];
  action: TutorAction | 'start';
  studentText: string;
  minLevel: HintLevel;
  /** Set on a regeneration after the leak check rejected the previous draft. */
  leakFeedback?: string;
}

export function answerKeyBlock(h: SolverResult): string {
  return [
    '=== PRIVATE ANSWER KEY (never reveal) ===',
    `Final answer: ${h.finalAnswer}`,
    `Steps:\n${h.keySteps.map((s, i) => `${i + 1}. ${s}`).join('\n')}`,
    `Concepts: ${h.conceptTags.join(', ')}`,
    `Common misconceptions: ${h.misconceptions.join('; ')}`,
    '=== END ANSWER KEY ===',
    h.studentWork && `What the student has done so far (from their tab): ${h.studentWork}`,
  ]
    .filter(Boolean)
    .join('\n');
}

function transcript(history: ChatMessage[]): string {
  return history.slice(-12).map((m) => `${m.role === 'tutor' ? 'Tutor' : 'Student'}: ${m.text}`).join('\n') || '(no messages yet)';
}

const ACTION_NOTE: Record<TutorAction | 'start', string> = {
  start: 'This is the start of the session. Open with a short, friendly insight into what they seem to be stuck on.',
  reply: 'The student wrote something (below). Assess it and give the next insight.',
  different_hint: 'The student asked for a different hint. Approach it from a new angle at the minimum level or higher.',
  dont_know: 'The student said "I don\'t know at all". Break it into much smaller, more concrete pieces.',
};

/** Call 2: one Socratic tutor turn (a draft — the leak guard decides whether it's shown). */
export async function tutorTurn(ctx: OpenAICtx, a: TutorTurnArgs): Promise<TutorTurn> {
  const prompt = [
    answerKeyBlock(a.hidden),
    `Problem:\n${a.hidden.problemText}`,
    `Conversation so far:\n${transcript(a.history)}`,
    ACTION_NOTE[a.action],
    a.studentText && `Student's latest reply: """${a.studentText}"""`,
    `Minimum hint level for this turn: ${a.minLevel}`,
    a.leakFeedback && `Your previous draft was REJECTED because it leaked: ${a.leakFeedback}. Write a new question that reveals less.`,
  ]
    .filter(Boolean)
    .join('\n\n');

  const r = await generateJson<TutorTurn>(ctx, {
    system: TUTOR_SYSTEM,
    parts: [{ text: prompt }],
    schema: TUTOR_SCHEMA,
    timeoutMs: 25_000,
  });
  const level = Math.min(3, Math.max(a.minLevel, Math.round(Number(r.hintLevel) || a.minLevel))) as HintLevel;
  return {
    replyAssessment: r.replyAssessment ?? 'none',
    hintLevel: level,
    message: (r.message ?? '').trim(),
    suggestions: (r.suggestions ?? []).map((s) => s.trim()).filter(Boolean).slice(0, 3),
    missingPrerequisite: (r.missingPrerequisite ?? '').trim(),
  };
}

export async function judgeLeak(ctx: OpenAICtx, hidden: SolverResult, message: string): Promise<{ leaks: boolean; reason: string }> {
  return generateJson(ctx, {
    system: JUDGE_SYSTEM,
    parts: [{ text: `${answerKeyBlock(hidden)}\n\nProblem:\n${hidden.problemText}\n\nTutor message to audit:\n"""${message}"""` }],
    schema: JUDGE_SCHEMA,
    temperature: 0,
    timeoutMs: 20_000,
  });
}

export async function gradeExplanation(
  ctx: OpenAICtx,
  hidden: SolverResult,
  history: ChatMessage[],
  explanation: string,
): Promise<{ understood: boolean; feedback: string }> {
  return generateJson(ctx, {
    system: GRADE_SYSTEM,
    parts: [{ text: `${answerKeyBlock(hidden)}\n\nProblem:\n${hidden.problemText}\n\nConversation:\n${transcript(history)}\n\nStudent's explanation: """${explanation}"""` }],
    schema: GRADE_SCHEMA,
    temperature: 0.2,
    timeoutMs: 25_000,
  });
}
