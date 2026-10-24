// Every tutor message passes through here: draft → deterministic check → Gemini judge.
// A rejected draft is regenerated up to twice, then we fall back to a safe generic question.
import { GeminiError, type GeminiCtx } from '../ai/geminiClient';
import { FALLBACK_QUESTIONS } from '../ai/prompts';
import { judgeLeak, tutorTurn, type TutorTurnArgs } from '../ai/tutor';
import type { HintLevel, SolverResult, TutorTurn } from '../shared/types';
import { deterministicLeak, type LeakVerdict } from './deterministic';

const MAX_REGENERATIONS = 2;

export interface GuardedTurn {
  turn: TutorTurn;
  fallback: boolean;
  /** Each draft's verdict, for the leak eval. */
  attempts: { message: string; verdict: LeakVerdict; by: 'deterministic' | 'judge' | 'none' }[];
}

/** Injected so the eval can count drafts; the extension uses the real calls. */
export interface GuardDeps {
  draft: (ctx: GeminiCtx, a: TutorTurnArgs) => Promise<TutorTurn>;
  judge: (ctx: GeminiCtx, hidden: SolverResult, message: string) => Promise<LeakVerdict>;
}
const realDeps: GuardDeps = { draft: tutorTurn, judge: judgeLeak };

export function fallbackQuestion(level: HintLevel, seed = Date.now()): string {
  const options = FALLBACK_QUESTIONS[level];
  return options[seed % options.length];
}

/** Checks one message (deterministic first, then the judge). Fails closed if the judge errors. */
export async function checkMessage(ctx: GeminiCtx, hidden: SolverResult, message: string, deps = realDeps) {
  const det = deterministicLeak(message, hidden);
  if (det.leaks) return { verdict: det, by: 'deterministic' as const };
  try {
    const j = await deps.judge(ctx, hidden, message);
    return { verdict: { leaks: !!j.leaks, reason: j.reason ?? '' }, by: j.leaks ? ('judge' as const) : ('none' as const) };
  } catch {
    return { verdict: { leaks: true, reason: 'could not verify the message is safe' }, by: 'judge' as const };
  }
}

export async function guardedTutorTurn(ctx: GeminiCtx, args: TutorTurnArgs, deps = realDeps): Promise<GuardedTurn> {
  const attempts: GuardedTurn['attempts'] = [];
  let leakFeedback: string | undefined;
  let lastTurn: TutorTurn | null = null;

  for (let i = 0; i <= MAX_REGENERATIONS; i++) {
    let draft: TutorTurn;
    try {
      draft = await deps.draft(ctx, { ...args, leakFeedback });
    } catch (e) {
      // Auth/rate errors should surface to the UI; timeouts and the rest fall back to a generic question.
      if (e instanceof GeminiError && (e.kind === 'auth' || e.kind === 'network')) throw e;
      break;
    }
    lastTurn = draft;
    if (!draft.message) {
      leakFeedback = 'the message was empty';
      continue;
    }
    const { verdict, by } = await checkMessage(ctx, args.hidden, draft.message, deps);
    attempts.push({ message: draft.message, verdict, by });
    if (!verdict.leaks) return { turn: draft, fallback: false, attempts };
    leakFeedback = verdict.reason;
  }

  const level = lastTurn?.hintLevel ?? args.minLevel;
  return {
    turn: {
      replyAssessment: lastTurn?.replyAssessment ?? 'none',
      hintLevel: level,
      message: fallbackQuestion(level, args.history.length),
      missingPrerequisite: lastTurn?.missingPrerequisite ?? '',
    },
    fallback: true,
    attempts,
  };
}
