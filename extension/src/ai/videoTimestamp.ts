// Picks the best candidate video and the segment that explains the concept. OpenAI can't watch
// YouTube, so the choice uses what SerpApi returns: titles, descriptions, lengths and chapters.
import type { VideoCandidate } from '../serp/youtube';
import type { VideoMoment } from '../shared/types';
import { generateJson, type OpenAICtx } from './openaiClient';
import { VIDEO_PICK_SYSTEM } from './prompts';
import { VIDEO_PICK_SCHEMA } from './schemas';

function clampSegment(c: VideoCandidate, start: number, end: number): { start: number; end: number } {
  const len = c.lengthSec || Number.MAX_SAFE_INTEGER;
  const s = Math.max(0, Math.min(Math.round(start) || 0, len - 30));
  let e = Math.round(end) || s + 240;
  if (e <= s + 20) e = s + 180;
  return { start: s, end: Math.min(e, len, s + 10 * 60) };
}

async function pickFromMetadata(ctx: OpenAICtx, cands: VideoCandidate[], concept: string, problemText: string) {
  const list = cands
    .map(
      (c, i) =>
        `[${i}] "${c.title}" by ${c.channel}, ${c.lengthSec}s
${c.description.slice(0, 300)}${
          c.chapters.length ? `
Chapters: ${c.chapters.map((ch) => `${ch.startSec}s ${ch.title}`).join('; ')}` : ''
        }`,
    )
    .join('\n\n');
  return generateJson<{ index: number; startSec: number; endSec: number; why: string }>(ctx, {
    system: VIDEO_PICK_SYSTEM,
    parts: [
      {
        text: `Concept: ${concept}
The student's problem (avoid videos that solve it): ${problemText.slice(0, 400)}

Results:
${list}`,
      },
    ],
    schema: VIDEO_PICK_SCHEMA,
    temperature: 0.1,
    timeoutMs: 20_000,
  });
}

export async function findVideoMoment(
  ctx: OpenAICtx,
  candidates: VideoCandidate[],
  concept: string,
  problemText: string,
): Promise<VideoMoment> {
  if (candidates.length === 0) throw new Error('No suitable videos found for this concept.');
  const moment = (c: VideoCandidate, start: number, end: number, why: string): VideoMoment => ({
    videoId: c.videoId,
    title: c.title,
    channel: c.channel,
    ...clampSegment(c, start, end),
    why: why || `How ${concept} works`,
    concept,
    source: 'metadata',
  });

  try {
    const p = await pickFromMetadata(ctx, candidates.slice(0, 6), concept, problemText);
    const c = candidates[Math.max(0, Math.min(candidates.length - 1, p.index))];
    return moment(c, p.startSec, p.endSec, p.why);
  } catch {
    const c = candidates[0];
    return moment(c, c.chapters[0]?.startSec ?? 0, 300, '');
  }
}
