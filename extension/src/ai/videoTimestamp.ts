// Picks the best candidate video and the exact segment that explains the concept.
// Primary path: Gemini watches the public YouTube URL. Fallback: titles/descriptions/chapters only.
import type { VideoCandidate } from '../serp/youtube';
import type { VideoMoment } from '../shared/types';
import { generateJson, type GeminiCtx } from './geminiClient';
import { VIDEO_PICK_SYSTEM, VIDEO_SYSTEM } from './prompts';
import { VIDEO_PICK_SCHEMA, VIDEO_SCHEMA } from './schemas';

interface VideoReview {
  relevance: number;
  startSec: number;
  endSec: number;
  why: string;
  showsSolutionToProblem: boolean;
}

function clampSegment(c: VideoCandidate, start: number, end: number): { start: number; end: number } {
  const len = c.lengthSec || Number.MAX_SAFE_INTEGER;
  const s = Math.max(0, Math.min(Math.round(start) || 0, len - 30));
  let e = Math.round(end) || s + 240;
  if (e <= s + 20) e = s + 180;
  return { start: s, end: Math.min(e, len, s + 10 * 60) };
}

async function reviewVideo(ctx: GeminiCtx, c: VideoCandidate, concept: string, problemText: string): Promise<VideoReview> {
  return generateJson<VideoReview>(ctx, {
    system: VIDEO_SYSTEM,
    parts: [
      { fileData: { fileUri: `https://www.youtube.com/watch?v=${c.videoId}` } },
      { text: `Concept the student needs: ${concept}\nThe student's problem (do not pick a segment that solves it): ${problemText.slice(0, 600)}` },
    ],
    schema: VIDEO_SCHEMA,
    temperature: 0.1,
    timeoutMs: 45_000,
    lowMediaResolution: true,
  });
}

async function pickFromMetadata(ctx: GeminiCtx, cands: VideoCandidate[], concept: string) {
  const list = cands
    .map(
      (c, i) =>
        `[${i}] "${c.title}" by ${c.channel}, ${c.lengthSec}s\n${c.description.slice(0, 300)}${
          c.chapters.length ? `\nChapters: ${c.chapters.map((ch) => `${ch.startSec}s ${ch.title}`).join('; ')}` : ''
        }`,
    )
    .join('\n\n');
  return generateJson<{ index: number; startSec: number; endSec: number; why: string }>(ctx, {
    system: VIDEO_PICK_SYSTEM,
    parts: [{ text: `Concept: ${concept}\n\nResults:\n${list}` }],
    schema: VIDEO_PICK_SCHEMA,
    temperature: 0.1,
    timeoutMs: 12_000,
  });
}

export async function findVideoMoment(
  ctx: GeminiCtx,
  candidates: VideoCandidate[],
  concept: string,
  problemText: string,
): Promise<VideoMoment> {
  if (candidates.length === 0) throw new Error('No suitable videos found for this concept.');
  const top = candidates.slice(0, 3);
  const moment = (c: VideoCandidate, start: number, end: number, why: string, source: VideoMoment['source']): VideoMoment => ({
    videoId: c.videoId,
    title: c.title,
    channel: c.channel,
    ...clampSegment(c, start, end),
    why: why || `How ${concept} works`,
    concept,
    source,
  });

  // Gemini watches the top candidates in parallel; any failure (unsupported, too long, timeout) just drops that one.
  const reviews = await Promise.allSettled(top.map((c) => reviewVideo(ctx, c, concept, problemText)));
  let best: { c: VideoCandidate; r: VideoReview } | null = null;
  reviews.forEach((res, i) => {
    if (res.status !== 'fulfilled' || res.value.showsSolutionToProblem) return;
    if (!best || res.value.relevance > best.r.relevance) best = { c: top[i], r: res.value };
  });
  const chosen = best as { c: VideoCandidate; r: VideoReview } | null;
  if (chosen && chosen.r.relevance >= 0.4) return moment(chosen.c, chosen.r.startSec, chosen.r.endSec, chosen.r.why, 'gemini-video');

  try {
    const p = await pickFromMetadata(ctx, candidates.slice(0, 6), concept);
    const c = candidates[Math.max(0, Math.min(candidates.length - 1, p.index))];
    return moment(c, p.startSec, p.endSec, p.why, 'metadata');
  } catch {
    const c = candidates[0];
    return moment(c, c.chapters[0]?.startSec ?? 0, 300, '', 'metadata');
  }
}
