// Orchestrates a tutor session. Everything returned from here is safe to show the student;
// the hidden solution stays inside the session store.
import { missingConcept } from '../ai/concept';
import type { GeminiCtx } from '../ai/geminiClient';
import { UNDERSTANDING_QUESTION } from '../ai/prompts';
import { createSession, deleteSession, getSession, saveSession, type TutorSession } from '../ai/sessionStore';
import { solve } from '../ai/solver';
import { gradeExplanation } from '../ai/tutor';
import { findVideoMoment } from '../ai/videoTimestamp';
import { deterministicLeak } from '../leak/deterministic';
import { checkMessage, guardedTutorTurn } from '../leak/guard';
import { VideoCache } from '../serp/cache';
import { searchPractice } from '../serp/trustedSites';
import { searchYouTube } from '../serp/youtube';
import type { PageContext, StartSessionResult, TutorReply } from '../shared/messages';
import type { HintLevel, SessionSummary, TutorAction, VideoMoment } from '../shared/types';
import { conceptCount, recordSummary } from './metrics';

const cache = new VideoCache(chrome.storage.local);
const STRUGGLE_FOR_VIDEO = 3;

async function load(id: string): Promise<TutorSession> {
  const s = await getSession(id);
  if (!s) throw new Error('This session expired. Click "I\'m stuck" to start a new one.');
  return s;
}

export async function startSession(
  ctx: GeminiCtx,
  image: string,
  context: PageContext | null,
  triggeredAt: number | null,
): Promise<StartSessionResult> {
  const hidden = await solve(ctx, image, context);
  if (!hidden.problemDetected) {
    return {
      sessionId: '',
      problemDetected: false,
      message: 'I couldn\'t find a problem in that capture. Try dragging the box around just the question.',
      hintLevel: 1,
      replyAssessment: 'none',
      suggestVideo: false,
      fallback: false,
    };
  }
  const session = await createSession({
    triggeredAt,
    url: context?.url ?? '',
    hidden,
    history: [],
    hintLevel: 1,
    struggleStreak: 0,
    concepts: hidden.conceptTags.slice(0, 3),
    videos: [],
    awaitingUnderstanding: false,
  });
  const g = await guardedTutorTurn(ctx, { hidden, history: [], action: 'start', studentText: '', minLevel: 1 });
  session.history.push({ role: 'tutor', text: g.turn.message, t: Date.now() });
  await saveSession(session);
  return {
    sessionId: session.id,
    problemDetected: true,
    message: g.turn.message,
    hintLevel: g.turn.hintLevel,
    replyAssessment: 'none',
    suggestVideo: false,
    fallback: g.fallback,
  };
}

const STUDENT_TEXT: Partial<Record<TutorAction, string>> = {
  dont_know: 'I don\'t know at all.',
  different_hint: '(asked for a different hint)',
};

export async function tutorTurn(ctx: GeminiCtx, sessionId: string, action: TutorAction, text: string): Promise<TutorReply> {
  const s = await load(sessionId);
  const studentText = text.trim() || STUDENT_TEXT[action] || '';
  if (studentText) s.history.push({ role: 'student', text: studentText, t: Date.now() });

  const bump = action === 'different_hint' || action === 'dont_know';
  const minLevel = Math.min(3, s.hintLevel + (bump ? 1 : 0)) as HintLevel;
  const g = await guardedTutorTurn(ctx, { hidden: s.hidden, history: s.history.slice(0, -1), action, studentText, minLevel });

  const struggling = action === 'dont_know' || g.turn.replyAssessment === 'dont_know' || g.turn.replyAssessment === 'misconception';
  s.struggleStreak = struggling ? s.struggleStreak + 1 : 0;
  s.hintLevel = Math.max(s.hintLevel, g.turn.hintLevel) as HintLevel;
  if (g.turn.missingPrerequisite && !s.concepts.includes(g.turn.missingPrerequisite)) s.concepts.push(g.turn.missingPrerequisite);
  s.history.push({ role: 'tutor', text: g.turn.message, t: Date.now() });
  await saveSession(s);

  return {
    message: g.turn.message,
    hintLevel: s.hintLevel,
    replyAssessment: g.turn.replyAssessment,
    suggestVideo: action === 'dont_know' || s.struggleStreak >= STRUGGLE_FOR_VIDEO || !!g.turn.missingPrerequisite,
    fallback: g.fallback,
  };
}

export async function checkUnderstanding(ctx: GeminiCtx, sessionId: string, explanation: string) {
  const s = await load(sessionId);
  s.history.push({ role: 'tutor', text: UNDERSTANDING_QUESTION, t: Date.now() }, { role: 'student', text: explanation, t: Date.now() });
  let result: { understood: boolean; feedback: string };
  try {
    result = await gradeExplanation(ctx, s.hidden, s.history, explanation);
    const { verdict } = await checkMessage(ctx, s.hidden, result.feedback);
    if (verdict.leaks) {
      result.feedback = result.understood
        ? 'Yes, that\'s the key idea. Nice work!'
        : 'Not quite yet. Which part of that step are you least sure about?';
    }
  } catch {
    result = { understood: false, feedback: 'I couldn\'t check that just now. Can you say it one more way?' };
  }
  s.history.push({ role: 'tutor', text: result.feedback, t: Date.now() });
  await saveSession(s);
  return result;
}

export async function findVideo(ctx: GeminiCtx, serpKey: string, sessionId: string): Promise<VideoMoment> {
  const s = await load(sessionId);
  const prereq = s.concepts[s.concepts.length - 1] ?? '';
  const { concept, query } = await missingConcept(ctx, s.hidden, s.history, prereq);

  let moment = await cache.get(concept);
  if (!moment) {
    try {
      const candidates = await searchYouTube(serpKey, query);
      moment = await findVideoMoment(ctx, candidates, concept, s.hidden.problemText);
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
  if (!s.concepts.includes(concept)) s.concepts.push(concept);
  s.videos.push(`${moment.title} (${moment.videoId})`);
  s.history.push({ role: 'tutor', text: `[Suggested video on ${concept}: ${moment.title}]`, t: Date.now() });
  await saveSession(s);
  return moment;
}

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
    turns: s.history.filter((m) => m.role === 'student').length,
    url: s.url ? new URL(s.url).hostname : '',
  };
  await recordSummary(summary);
  await deleteSession(sessionId);
  return summary;
}

export async function exportVideoCache() {
  return cache.export();
}
