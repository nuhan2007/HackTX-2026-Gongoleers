import type { ChatMessage, HintLevel, SolverResult, TutorAction, TutorTurn, WorkState } from '../shared/types';
import { generateJson, type LlmCtx, type Part } from './llmClient';
import { playbookFor } from './playbooks';
import { JUDGE_SYSTEM, TUTOR_SYSTEM } from './prompts';
import { JUDGE_SCHEMA, TUTOR_SCHEMA } from './schemas';

export interface TutorTurnArgs {
  hidden: SolverResult;
  /** The hints already shown to the student, oldest first, so a new one doesn't repeat them. */
  history: ChatMessage[];
  action: TutorAction;
  minLevel: HintLevel;
  /**
   * The monitor's latest private read on the student's work. `image` is the work tab's screenshot and
   * `problemImage` the problem tab's (both base64 JPEG); they are attached only when the screen changed
   * since the last time the tutor saw it, so an unchanged screen costs no image tokens.
   */
  work?: Pick<WorkState, 'status' | 'observation'> & { reviewedAt?: number; image?: string; problemImage?: string };
  /** Set on a regeneration after the leak check rejected the previous draft. */
  leakFeedback?: string;
  /** What made myTA step in (the confusion signals), so the hint can be about the right thing. */
  situation?: string;
}

/**
 * The private key as the model sees it: the answer and the steps, plus what kind of problem it is, what its figure shows, the
 * milestones, how sure the key is, and the playbook of typical slips for that kind of problem. All of it is as secret as the answer.
 */
export function answerKeyBlock(h: SolverResult): string {
  const playbook = playbookFor(h.domain, h.problemKind, h.conceptTags);
  return [
    '=== PRIVATE ANSWER KEY (never reveal) ===',
    h.problemKind || h.domain ? `Kind of problem: ${[h.problemKind, h.domain && h.domain !== 'other' ? `(${h.domain.replace('_', ' ')})` : ''].filter(Boolean).join(' ')}` : '',
    h.givens ? `Given in the figure/table: ${h.givens}` : '',
    `Final answer: ${h.finalAnswer}`,
    `Steps:\n${h.keySteps.map((s, i) => `${i + 1}. ${s}`).join('\n')}`,
    h.checkpoints?.length ? `Milestones:\n${h.checkpoints.map((c) => `- ${c.label}: ${c.expected}`).join('\n')}` : '',
    `Concepts: ${h.conceptTags.join(', ')}`,
    `Common misconceptions: ${h.misconceptions.join('; ')}`,
    `How sure this key is: ${h.keyConfidence ?? 'high'}`,
    playbook && `What to watch for in this kind of problem:\n${playbook}`,
    '=== END ANSWER KEY ===',
  ]
    .filter(Boolean)
    .join('\n');
}

function shown(history: ChatMessage[]): string {
  return history
    .filter((m) => m.role === 'tutor' && !m.text.startsWith('['))
    .slice(-6)
    .map((m, i) => `${i + 1}. ${m.text}`)
    .join('\n') || '(none yet)';
}

const ACTION_NOTE: Record<TutorAction, string> = {
  auto:
    'The student did NOT ask for help. myTA noticed they seem stuck and is showing your message as a small pop-up next to their work. ' +
    'Look at their work (the screenshots and notes) and write ONE short hint: at most two short sentences, ending with one guiding question. ' +
    'Point to WHERE to look or what to reconsider in their own work, without saying what the right value, step or answer is. ' +
    'If their work looks right so far, say so and nudge them toward the next step instead.',
  another:
    'The student pressed "Another hint": the earlier hint was not enough. Come at it from a NEW angle, at the minimum level or higher, ' +
    'and do not repeat the earlier hints. Still at most two short sentences, still never the answer.',
};

/** How stale the notes are. When a screenshot is attached it is newer than the notes, and the model is told to trust it. */
function noteAge(reviewedAt?: number): string {
  if (!reviewedAt) return '';
  const s = Math.max(0, Math.round((Date.now() - reviewedAt) / 1000));
  return ` (from ${s < 90 ? `${s}s` : `${Math.round(s / 60)} min`} ago, so the screenshot may show newer work: trust the screenshot over them)`;
}

function workBlock(w: NonNullable<TutorTurnArgs['work']>): string | false {
  if (!w.observation && w.status === 'unknown' && !w.image && !w.problemImage) return false;
  return [
    '=== LATEST LOOK AT THE STUDENT\'S WORK (private) ===',
    `Status: ${w.status.replace(/_/g, ' ')}`,
    w.observation && `Notes${noteAge(w.reviewedAt)}: ${w.observation}`,
    (w.image || w.problemImage) && 'Labelled screenshots of their screen are attached.',
    '=== END ===',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Call 2: one hint (a draft: the leak guard decides whether it is shown). */
export async function tutorTurn(ctx: LlmCtx, a: TutorTurnArgs): Promise<TutorTurn> {
  // Static per session first (cache-friendly), then the images, then what changes every turn.
  const fixed = [answerKeyBlock(a.hidden), `Problem:\n${a.hidden.problemText}`].join('\n\n');
  const changing = [
    a.work && workBlock(a.work),
    `Hints already shown to the student:\n${shown(a.history)}`,
    ACTION_NOTE[a.action],
    a.situation && `What myTA noticed: ${a.situation}`,
    `Minimum hint level for this turn: ${a.minLevel}`,
    a.leakFeedback && `Your previous draft was REJECTED because it leaked: ${a.leakFeedback}. Write a new hint that reveals less.`,
  ]
    .filter(Boolean)
    .join('\n\n');

  const parts: Part[] = [{ text: fixed }];
  if (a.work?.image) parts.push({ text: 'Screenshot of the tab where the student writes their work:' }, { image: a.work.image });
  if (a.work?.problemImage) parts.push({ text: 'Screenshot of the problem tab:' }, { image: a.work.problemImage });
  parts.push({ text: changing });

  const r = await generateJson<TutorTurn>(ctx, {
    system: TUTOR_SYSTEM,
    parts,
    schema: TUTOR_SCHEMA,
    schemaName: 'tutor_turn',
    kind: 'tutor',
    // A hint about a hard problem is worth a little thinking; the answer key already did the heavy lifting.
    effort: (a.hidden.difficulty ?? 3) >= 4 ? 'medium' : 'low',
    maxTokens: 3000,
    temperature: 0.7,
    timeoutMs: a.work?.image || a.work?.problemImage ? 45_000 : 30_000,
  });
  const level = Math.min(3, Math.max(a.minLevel, Math.round(Number(r.hintLevel) || a.minLevel))) as HintLevel;
  return {
    replyAssessment: r.replyAssessment ?? 'none',
    hintLevel: level,
    message: (r.message ?? '').trim(),
    missingPrerequisite: (r.missingPrerequisite ?? '').trim(),
  };
}

export async function judgeLeak(ctx: LlmCtx, hidden: SolverResult, message: string): Promise<{ leaks: boolean; reason: string }> {
  return generateJson(ctx, {
    system: JUDGE_SYSTEM,
    parts: [{ text: `${answerKeyBlock(hidden)}\n\nProblem:\n${hidden.problemText}\n\nTutor message to audit:\n"""${message}"""` }],
    schema: JUDGE_SCHEMA,
    schemaName: 'leak_judgement',
    kind: 'judge',
    // The judge only compares a short message with the key: the cheapest and quickest thinking there is.
    effort: 'minimal',
    maxTokens: 1500,
    temperature: 0,
    timeoutMs: 25_000,
  });
}
