// Orchestrates what myTA asks the model on a student's behalf: working the problem out privately, reading their work,
// writing hints and checking the final answer. Everything returned from here is safe to show the student; the hidden
// solution stays inside the session store.
import { missingConcept } from '../ai/concept';
import type { LlmCtx } from '../ai/llmClient';
import { FALLBACK_CHECK } from '../ai/prompts';
import { createSession, deleteSession, getSession, getSolved, getWork, saveSession, saveSolved, saveWork, type TutorSession } from '../ai/sessionStore';
import { solve } from '../ai/solver';
import { findVideoMoment } from '../ai/videoTimestamp';
import { reviewWork, type ReviewArgs, type WorkReview } from '../ai/work';
import { deterministicLeak } from '../leak/deterministic';
import { checkMessage, guardedTutorTurn } from '../leak/guard';
import { VideoCache } from '../serp/cache';
import { HINT_ESCALATE_MS } from '../shared/constants';
import { searchPractice } from '../serp/trustedSites';
import { searchYouTube } from '../serp/youtube';
import type { PageContext, StartSessionResult } from '../shared/messages';
import type { CallOutcome } from './callGate';
import type { ProblemTraits } from '../shared/settings';
import type { Box, CheckVerdict, CopyState, HintLevel, MistakeKind, Readability, SessionSummary, SolverResult, VideoMoment, WorkCheckResult, WorkState, WorkStatus } from '../shared/types';
import { conceptCount, recordSummary } from './metrics';

const cache = new VideoCache(chrome.storage.local);
const MAX_CHECK_REGENERATIONS = 2;

/**
 * Cache key for a numbered question ("Q4") on a page, or null when the page doesn't name its question
 * (without a label, two different problems could share a page and a cached answer would be wrong).
 */
export function solveKey(context: PageContext | null): string | null {
  if (!context?.url || !context.question || !/^(Q\d|Problem \d|Exercise \d)/.test(context.question)) return null;
  try {
    const u = new URL(context.url);
    return `${u.origin}${u.pathname}${u.search}|${context.question}`;
  } catch {
    return null;
  }
}

async function load(id: string): Promise<TutorSession> {
  const s = await getSession(id);
  if (!s) throw new Error('This session expired. Open the problem again and myTA will pick it back up.');
  return s;
}

/** What about the solved problem changes how patient and how attentive myTA is (the answer itself never leaves the session store). */
export function traitsFrom(h: SolverResult): ProblemTraits {
  return { difficulty: h.difficulty ?? null, domain: h.domain ?? null, workFormat: h.workFormat ?? null, expectedMinutes: h.expectedMinutes ?? null, problemKind: h.problemKind || null };
}

/** Works the problem out privately and opens a session: the one model call myTA makes when it starts following a problem. */
export async function startSession(ctx: LlmCtx, image: string, context: PageContext | null, triggeredAt: number | null, fresh = false): Promise<StartSessionResult> {
  const key = solveKey(context);
  // `fresh`: work it out again even if this question was solved before (the site may have put a different problem under the same label).
  const cached = !fresh && key ? await getSolved(key) : null;
  const hidden = cached ?? (await solve(ctx, image, context));
  if (!cached && key && hidden.problemDetected) await saveSolved(key, hidden);
  if (!hidden.problemDetected) {
    return { sessionId: '', problemDetected: false, message: 'I couldn\'t find a problem on that page.' };
  }
  const session = await createSession({
    triggeredAt,
    url: context?.url ?? '',
    hidden,
    history: [],
    hintLevel: 1,
    concepts: hidden.conceptTags.slice(0, 3),
    videos: [],
    hints: 0,
  });
  return { sessionId: session.id, problemDetected: true, message: '', difficulty: hidden.difficulty, traits: traitsFrom(hidden) };
}

/** Drops a session that left nothing worth a summary: myTA followed the problem and the student never needed it. */
export async function discardSession(sessionId: string): Promise<void> {
  await deleteSession(sessionId);
}

/**
 * The student looks stuck: read their work and write a short hint for the sprite. It goes through the same leak guard as every
 * message (a hint that can't be made safe becomes a generic guiding question). A second hint soon after the first goes one level
 * deeper (nudge → concept → next step). If the work shows a missing prerequisite, the name of the concept comes back too, so the
 * sprite can offer a short video on it.
 */
export async function proactiveHint(
  ctx: LlmCtx,
  sessionId: string,
  shots: { work?: string | null; problem?: string | null },
  noticed: string,
  escalate = false,
): Promise<{ message: string; hintLevel: HintLevel; fallback: boolean; missingPrerequisite: string }> {
  const s = await load(sessionId);
  const work = await getWork(sessionId);
  const recent = !!s.lastAutoHintAt && Date.now() - s.lastAutoHintAt < HINT_ESCALATE_MS;
  const minLevel = Math.min(3, s.hintLevel + (recent || escalate ? 1 : 0)) as HintLevel;
  const g = await guardedTutorTurn(ctx, {
    hidden: s.hidden,
    history: s.history,
    action: escalate ? 'another' : 'auto',
    situation: noticed,
    minLevel,
    work: { status: work.status, observation: work.observation, reviewedAt: work.reviewedAt || undefined, image: shots.work ?? undefined, problemImage: shots.problem ?? undefined },
  });
  // Re-read before writing: a reading may have saved other notes while the model was thinking.
  const fresh = await load(sessionId);
  fresh.history.push({ role: 'tutor', text: g.turn.message, t: Date.now() });
  fresh.hintLevel = Math.max(fresh.hintLevel, g.turn.hintLevel) as HintLevel;
  fresh.lastAutoHintAt = Date.now();
  fresh.hints = (fresh.hints ?? 0) + 1;
  fresh.triggeredAt ??= Date.now();
  const prereq = g.turn.missingPrerequisite;
  if (prereq && !fresh.concepts.includes(prereq)) fresh.concepts.push(prereq);
  await saveSession(fresh);
  return { message: g.turn.message, hintLevel: fresh.hintLevel, fallback: g.fallback, missingPrerequisite: prereq };
}

const WORK_STATUS: Record<WorkReview['status'], WorkStatus> = {
  no_work: 'no_work',
  on_track: 'on_track',
  mistake: 'possible_mistake',
  solved: 'solved',
  unclear: 'unknown',
};

/** What the monitor hands over for one look at the student's work. */
export interface WorkShots {
  /** Base64 JPEG of the tab where the work is. */
  work: string;
  /** Base64 JPEG of the problem tab, when it is a different tab. */
  problem?: string | null;
  problemContext: PageContext | null;
  workContext?: PageContext | null;
  /** The work is in a different tab from the problem (the problem image is left out when it is unchanged). */
  separateTabs?: boolean;
}

/** What a finished look means for the call gate. */
export function outcomeOf(status: WorkStatus): CallOutcome {
  return status === 'possible_mistake'
    ? 'mistake'
    : status === 'solved'
      ? 'solved'
      : status === 'on_track'
        ? 'on_track'
        : status === 'no_work'
          ? 'no_work'
          : status === 'different_problem'
            ? 'different'
            : 'unclear';
}

/** What a final check means for the call gate. */
export function outcomeOfVerdict(verdict: CheckVerdict): CallOutcome {
  return verdict === 'mistake' ? 'mistake' : verdict === 'correct' ? 'solved' : verdict === 'incomplete' ? 'on_track' : 'unclear';
}

/**
 * What the model read from the student's work, in a form that is safe to show them. It has to be their own writing: if it
 * contains anything from the answer key (the student wrote the answer down, or the model filled in) it isn't echoed, and
 * the panel just says it could read the work.
 */
function echoable(read: string, hidden: SolverResult): string {
  return read && !deterministicLeak(read, hidden).leaks ? read : '';
}

const pick = (list: string[], seed: number): string => list[Math.abs(seed) % list.length];

type MessageKind = keyof typeof FALLBACK_CHECK;
const kindOf = (r: WorkReview): MistakeKind => (r.copiedWrong ? 'copy' : 'step');

/**
 * Makes sure what the student is told has passed the leak guard. A draft that leaks is rewritten (up to twice); if none is
 * safe, a generic message for that situation is used instead. `first` is a review already in hand (a reading while they wrote);
 * without one the model is asked here.
 */
async function reviewWithMessage(
  ctx: LlmCtx,
  s: TutorSession,
  base: Omit<ReviewArgs, 'leakFeedback'>,
  fallbackKind: (r: WorkReview) => MessageKind,
  first?: WorkReview,
): Promise<{ review: WorkReview; message: string; safe: boolean }> {
  let review: WorkReview | null = first ?? null;
  let leakFeedback: string | undefined;
  let safe = false;
  for (let i = 0; i <= MAX_CHECK_REGENERATIONS && !safe; i++) {
    if (!review || leakFeedback !== undefined) {
      try {
        review = await reviewWork(ctx, { ...base, leakFeedback });
      } catch (e) {
        if (!review) throw e; // nothing to show yet: surface the error (bad key, offline, …)
        break;
      }
    }
    if (!review.studentMessage) {
      leakFeedback = 'the message was empty';
      continue;
    }
    const { verdict } = await checkMessage(ctx, s.hidden, review.studentMessage);
    safe = !verdict.leaks;
    leakFeedback = verdict.reason;
  }
  if (!review) throw new Error('I couldn\'t look at your work just now.');
  const message = safe ? review.studentMessage : pick(FALLBACK_CHECK[fallbackKind(review)], s.history.length + Date.now());
  return { review, message, safe };
}

/** What one reading of the student's work found, with what to tell them if it found a mistake or a finished answer. */
export interface ReadResult {
  state: WorkState;
  differentProblem: boolean;
  copiedWrong: boolean;
  /** Where the student is with copying the problem down (a copy is only called wrong once it is complete). */
  copyState: CopyState;
  kind: MistakeKind;
  /** Passed the leak guard. Empty unless asked for and there is a mistake or a solved answer to say something about. */
  message: string;
  box: Box | null;
}

/** The first thing a reading found, known before the message has been through the leak guard. */
export interface EarlyRead {
  status: WorkStatus;
  readability: Readability;
  copiedWrong: boolean;
  differentProblem: boolean;
  kind: MistakeKind;
  box: Box | null;
}

export interface ObserveOptions {
  /** Something could be shown for a mistake or a finished answer: write the message too (it goes through the leak guard). */
  wantMessage?: boolean;
  /** How long the student had been still when the snapshot was taken. */
  idleMs?: number | null;
  /** A wrong copy of the problem would be flagged by this reading, so it is worth writing a message for. Without it, the copy is only noted. */
  copyReady?: boolean;
  /**
   * Called the moment the model has read the work, before the message has been through the leak guard (one more call). The sprite can
   * flag a mistake from this right away, and put the words in a moment later.
   */
  onEarly?: (e: EarlyRead) => void;
}

/**
 * A look at the student's screens, asked for by the call gate while they write. It always updates the private work notes. With
 * `wantMessage`, a mistake (including a wrongly copied problem) or a solved answer also comes back with something to tell them,
 * checked by the leak guard, so the sprite can flag it on the spot.
 */
export async function observeWork(ctx: LlmCtx, sessionId: string, shots: WorkShots, why: string, opts: ObserveOptions = {}): Promise<ReadResult> {
  const { wantMessage = false, idleMs = null, copyReady = true, onEarly } = opts;
  const s = await load(sessionId);
  const prev = await getWork(sessionId);
  const base: Omit<ReviewArgs, 'leakFeedback'> = {
    hidden: s.hidden,
    workImage: shots.work,
    problemImage: shots.problem ?? undefined,
    separateTabs: shots.separateTabs,
    problemContext: shots.problemContext,
    workContext: shots.workContext,
    previous: prev.observation,
    final: false,
    why,
    idleSec: idleMs === null ? null : Math.round(idleMs / 1000),
  };
  let review = await reviewWork(ctx, base);
  onEarly?.({
    status: review.differentProblem ? 'different_problem' : WORK_STATUS[review.status],
    readability: review.readability,
    copiedWrong: review.copiedWrong,
    differentProblem: review.differentProblem,
    kind: kindOf(review),
    box: review.status === 'mistake' ? review.box : null,
  });
  let message = '';
  // A wrong copy is only worth the guard's extra call when this reading is the one that will flag it.
  const speakable = !review.differentProblem && (review.status === 'solved' || (review.status === 'mistake' && (!review.copiedWrong || copyReady)));
  if (wantMessage && speakable) {
    const r = await reviewWithMessage(ctx, s, base, (x) => (x.status === 'solved' ? 'correct' : x.copiedWrong ? 'copy' : 'mistake'), review);
    review = r.review;
    message = r.message;
  }
  const next: WorkState = {
    status: review.differentProblem ? 'different_problem' : WORK_STATUS[review.status],
    observation: review.observation,
    reviewedAt: Date.now(),
    read: echoable(review.workRead, s.hidden),
    readability: review.readability,
    copiedWrong: review.copiedWrong,
    copyState: review.copyState,
  };
  await saveWork(sessionId, next);
  return {
    state: next,
    differentProblem: review.differentProblem,
    copiedWrong: review.copiedWrong,
    copyState: review.copyState,
    kind: kindOf(review),
    message,
    box: review.status === 'mistake' ? review.box : null,
  };
}

const VERDICT: Record<WorkReview['status'], CheckVerdict> = { solved: 'correct', mistake: 'mistake', on_track: 'incomplete', no_work: 'unclear', unclear: 'unclear' };

const WHY_MOVING_ON = 'the student says they are finished and are moving on';

/**
 * The student finished (or is moving on): review their final work and say where it went off track.
 * The message passes the same leak guard as every message; if it can't be made safe it falls back to a generic one.
 * `why` says what made myTA check now (the homework page saying "wrong", or seeing them stop and look calm).
 */
export async function checkWork(ctx: LlmCtx, sessionId: string, shots: WorkShots, why = WHY_MOVING_ON): Promise<WorkCheckResult> {
  const s = await load(sessionId);
  const prev = await getWork(sessionId);
  const { review, message: raw, safe } = await reviewWithMessage(
    ctx,
    s,
    {
      hidden: s.hidden,
      workImage: shots.work,
      problemImage: shots.problem ?? undefined,
      separateTabs: shots.separateTabs,
      problemContext: shots.problemContext,
      workContext: shots.workContext,
      previous: prev.observation,
      final: true,
      why,
    },
    (r) => (r.copiedWrong ? 'copy' : VERDICT[r.status]),
  );

  const verdict = review.differentProblem ? 'unclear' : VERDICT[review.status];
  const message = raw;
  // Re-read before writing: a hint may have been saved while the model was thinking, and writing the old copy back would lose it.
  const fresh = await load(sessionId);
  fresh.history.push({ role: 'tutor', text: message, t: Date.now() });
  await saveSession(fresh);
  const read = echoable(review.workRead, s.hidden);
  await saveWork(sessionId, {
    status: review.differentProblem ? 'different_problem' : WORK_STATUS[review.status],
    observation: review.observation || prev.observation,
    reviewedAt: Date.now(),
    read,
    readability: review.readability,
    copiedWrong: review.copiedWrong,
  });
  return {
    verdict,
    message,
    box: verdict === 'mistake' ? review.box : null,
    fallback: !safe,
    read,
    readability: review.readability,
    differentProblem: review.differentProblem,
    kind: verdict === 'mistake' ? kindOf(review) : undefined,
  };
}

/** A short video on the idea behind the student's trouble: found with SerpApi, the moment picked by the model, cached per concept. */
export async function findVideo(ctx: LlmCtx, serpKey: string, sessionId: string, hint = ''): Promise<VideoMoment> {
  const s = await load(sessionId);
  const prereq = hint || (s.concepts[s.concepts.length - 1] ?? '');
  const { concept, query } = await missingConcept(ctx, s.hidden, s.history, prereq);

  let moment = await cache.get(concept);
  if (!moment) {
    try {
      const candidates = await searchYouTube(serpKey, query);
      moment = await findVideoMoment(ctx, candidates, concept);
      await cache.set(concept, moment);
    } catch (e) {
      // SerpApi quota/network trouble: serve anything cached, including the bundled demo cache.
      moment = await cache.get(concept, true);
      if (!moment) throw e;
    }
  }
  if (deterministicLeak(moment.why, s.hidden).leaks) moment = { ...moment, why: `How ${concept} works` };

  if ((await conceptCount(concept)) >= 2 && serpKey) {
    moment.practice = await searchPractice(serpKey, concept).catch(() => []);
  }
  // Re-read before writing, for the same reason as above.
  const latest = await load(sessionId);
  if (!latest.concepts.includes(concept)) latest.concepts.push(concept);
  latest.videos.push(`${moment.title} (${moment.videoId})`);
  latest.history.push({ role: 'tutor', text: `[Suggested video on ${concept}: ${moment.title}]`, t: Date.now() });
  await saveSession(latest);
  return moment;
}

/** Records how the problem went (for the Stats tab) and forgets the session. */
export async function endSession(sessionId: string, solved: boolean): Promise<SessionSummary | null> {
  const s = await getSession(sessionId);
  if (!s) return null;
  const now = Date.now();
  const start = s.triggeredAt ?? s.createdAt;
  const summary: SessionSummary = {
    id: s.id,
    startedAt: s.createdAt,
    triggeredAt: s.triggeredAt,
    endedAt: now,
    solved,
    timeToUnstuckSec: solved ? Math.round((now - start) / 1000) : null,
    concepts: s.concepts,
    videosWatched: s.videos,
    turns: s.hints ?? 0,
    url: s.url ? new URL(s.url).hostname : '',
  };
  await recordSummary(summary);
  await deleteSession(sessionId);
  return summary;
}

/** True when the session has anything worth a line in the stats (a hint was shown, or it was solved). */
export async function worthSummary(sessionId: string): Promise<boolean> {
  const s = await getSession(sessionId);
  return !!s && ((s.hints ?? 0) > 0 || s.videos.length > 0);
}

export async function exportVideoCache() {
  return cache.export();
}
