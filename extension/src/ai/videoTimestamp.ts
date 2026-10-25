// Picks the best candidate video and the moment that explains the concept. SerpApi finds the videos; Gemini then chooses one
// from the search results (titles, descriptions, lengths and chapters), and, when the video has no chapters to say where the
// explanation starts, actually WATCHES it (Gemini takes a public YouTube address) and reports the minute the concept is explained.
// The sprite shows that moment in parentheses next to "Watch it", and the clip opens at it.
import type { VideoCandidate } from '../serp/youtube';
import type { VideoMoment } from '../shared/types';
import { generateJson, type LlmCtx } from './llmClient';
import { VIDEO_MOMENT_SYSTEM, VIDEO_PICK_SYSTEM } from './prompts';
import { VIDEO_MOMENT_SCHEMA, VIDEO_PICK_SCHEMA } from './schemas';

/** Longest video Gemini is asked to watch: past this the time and cost aren't worth it for one moment. */
const MAX_WATCH_SEC = 25 * 60;

/** "2:14", "1:02:03", "134", "2m14s" and "134s" all mean the same kind of thing; anything else is NaN. */
export function parseClock(s: unknown): number {
  if (typeof s === 'number') return Number.isFinite(s) ? Math.max(0, Math.round(s)) : NaN;
  if (typeof s !== 'string') return NaN;
  const t = s.trim().toLowerCase();
  const units = t.match(/^(?:(\d+)h)?\s*(?:(\d+)m(?:in)?)?\s*(?:(\d+)s(?:ec)?)?$/);
  if (units && (units[1] || units[2] || units[3])) return Number(units[1] ?? 0) * 3600 + Number(units[2] ?? 0) * 60 + Number(units[3] ?? 0);
  const clock = t.match(/^(\d+):(\d{1,2})(?::(\d{1,2}))?$/);
  if (clock) return clock[3] !== undefined ? Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3]) : Number(clock[1]) * 60 + Number(clock[2]);
  return /^\d+$/.test(t) ? Number(t) : NaN;
}

/** Keeps a segment inside the video and a sensible length. */
export function clampSegment(c: Pick<VideoCandidate, 'lengthSec'>, start: number, end: number): { start: number; end: number } {
  const len = c.lengthSec || Number.MAX_SAFE_INTEGER;
  const s = Math.max(0, Math.min(Math.round(start) || 0, len - 30));
  let e = Math.round(end) || s + 240;
  if (e <= s + 20) e = s + 180;
  return { start: s, end: Math.min(e, len, s + 10 * 60) };
}

async function pickFromMetadata(ctx: LlmCtx, cands: VideoCandidate[], concept: string) {
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
    schemaName: 'video_pick',
    kind: 'video',
    effort: 'minimal',
    maxTokens: 1500,
    temperature: 0.1,
    timeoutMs: 30_000,
  });
}

/** Gemini watches the video and says where the concept is explained. Null when it can't, or the video doesn't explain it. */
export async function watchForMoment(ctx: LlmCtx, c: VideoCandidate, concept: string): Promise<{ start: number; end: number; why: string } | null> {
  const r = await generateJson<{ explainsIt: boolean; start: string; end: string; why: string }>(ctx, {
    system: VIDEO_MOMENT_SYSTEM,
    parts: [{ video: `https://www.youtube.com/watch?v=${c.videoId}` }, { text: `Concept the student needs: ${concept}\nThe video is ${c.lengthSec ? `${Math.round(c.lengthSec / 60)} minutes long` : 'of unknown length'}.` }],
    schema: VIDEO_MOMENT_SCHEMA,
    schemaName: 'video_moment',
    kind: 'video-watch',
    effort: 'low',
    maxTokens: 2000,
    temperature: 0.1,
    lowMediaResolution: true,
    timeoutMs: 60_000,
  });
  const start = parseClock(r.start);
  if (!r.explainsIt || !Number.isFinite(start)) return null;
  if (c.lengthSec && start >= c.lengthSec - 20) return null;
  const end = parseClock(r.end);
  return { start, end: Number.isFinite(end) && end > start ? end : start + 180, why: (r.why ?? '').trim() };
}

export async function findVideoMoment(ctx: LlmCtx, candidates: VideoCandidate[], concept: string): Promise<VideoMoment> {
  if (candidates.length === 0) throw new Error('No suitable videos found for this concept.');
  const moment = (c: VideoCandidate, start: number, end: number, why: string, source: VideoMoment['source']): VideoMoment => ({
    videoId: c.videoId,
    title: c.title,
    channel: c.channel,
    ...clampSegment(c, start, end),
    why: why || `How ${concept} works`,
    concept,
    source,
    lengthSec: c.lengthSec || undefined,
  });

  let pick: { index: number; startSec: number; endSec: number; why: string } | null = null;
  try {
    pick = await pickFromMetadata(ctx, candidates.slice(0, 6), concept);
  } catch {
    /* the text pick failed: the first candidate is still a fine guess */
  }
  const c = candidates[Math.max(0, Math.min(candidates.length - 1, pick?.index ?? 0))];
  const chapterStart = c.chapters.find((ch) => pick && Math.abs(ch.startSec - pick.startSec) <= 3);

  // The video's own chapters say where an explanation starts, when the pick landed on one.
  if (pick && chapterStart) return moment(c, chapterStart.startSec, pick.endSec, pick.why, 'chapters');

  // Otherwise, watch it. A long video, or one Gemini can't open, falls back to what the search result said.
  if (!c.lengthSec || c.lengthSec <= MAX_WATCH_SEC) {
    try {
      const w = await watchForMoment(ctx, c, concept);
      if (w) return moment(c, w.start, w.end, w.why || pick?.why || '', 'video');
    } catch {
      /* the metadata pick below is the fallback */
    }
  }
  return moment(c, pick?.startSec ?? c.chapters[0]?.startSec ?? 0, pick?.endSec ?? 300, pick?.why ?? '', 'metadata');
}
