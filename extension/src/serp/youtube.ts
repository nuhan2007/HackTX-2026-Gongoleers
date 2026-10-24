// SerpApi YouTube search → filtered, ranked candidate videos for a concept.

export interface VideoCandidate {
  videoId: string;
  title: string;
  channel: string;
  lengthSec: number;
  description: string;
  chapters: { title: string; startSec: number }[];
}

export class SerpError extends Error {
  constructor(public kind: 'auth' | 'quota' | 'network' | 'http', message: string) {
    super(message);
    this.name = 'SerpError';
  }
}

const ANSWER_DUMP_RE =
  /\b(answer key|answers?\s+(to|for)|solutions?\s+(to|for|manual)|homework (help|answers)|test answers|quiz answers|exam answers|chegg|course\s?hero|cheat)\b/i;

// Channels with a track record of clear concept explanations get a ranking boost.
const EDU_CHANNELS = [
  'khan academy', 'the organic chemistry tutor', '3blue1brown', 'professor leonard', 'crashcourse', 'crash course',
  'mit opencourseware', 'patrickjmt', 'michel van biezen', 'professor dave explains', 'numberphile', 'bro code',
  'freecodecamp', 'coding with john', 'computerphile', 'physics girl', 'flipping physics', 'eddie woo', 'math antics',
  'ali the dazzling', 'electroboom', 'neso academy', 'jesse mason',
];

export function parseLength(s: string | undefined): number {
  if (!s) return 0;
  return s.split(':').map(Number).reduce((acc, n) => acc * 60 + (Number.isNaN(n) ? 0 : n), 0);
}

function videoIdFrom(link: string): string | null {
  return link.match(/[?&]v=([\w-]{11})/)?.[1] ?? link.match(/youtu\.be\/([\w-]{11})/)?.[1] ?? null;
}

interface SerpVideo {
  title?: string;
  link?: string;
  channel?: { name?: string };
  length?: string;
  description?: string;
  chapters?: { title?: string; time_start?: number; time?: string }[];
}

export async function searchYouTube(serpKey: string, query: string): Promise<VideoCandidate[]> {
  if (!serpKey) throw new SerpError('auth', 'Missing SerpApi key. Add it on the options page.');
  const url = `https://serpapi.com/search.json?engine=youtube&search_query=${encodeURIComponent(query)}&api_key=${encodeURIComponent(serpKey)}`;
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new SerpError('network', 'Can\'t reach SerpApi.');
  }
  if (res.status === 401 || res.status === 403) throw new SerpError('auth', 'SerpApi rejected the API key.');
  if (res.status === 429) throw new SerpError('quota', 'SerpApi quota reached.');
  if (!res.ok) throw new SerpError('http', `SerpApi error ${res.status}`);
  const data = await res.json();
  if (data.error) throw new SerpError(/run out|limit|quota/i.test(data.error) ? 'quota' : 'http', data.error);

  const results: SerpVideo[] = data.video_results ?? [];
  return rankCandidates(
    results
      .map((v): VideoCandidate | null => {
        const id = v.link ? videoIdFrom(v.link) : null;
        if (!id) return null;
        return {
          videoId: id,
          title: v.title ?? '',
          channel: v.channel?.name ?? '',
          lengthSec: parseLength(v.length),
          description: v.description ?? '',
          chapters: (v.chapters ?? []).map((c) => ({ title: c.title ?? '', startSec: c.time_start ?? parseLength(c.time) })),
        };
      })
      .filter((v): v is VideoCandidate => v !== null),
  );
}

/** Drop answer dumps and very long/short videos; float known educational channels to the top. */
export function rankCandidates(cands: VideoCandidate[]): VideoCandidate[] {
  return cands
    .filter((v) => !ANSWER_DUMP_RE.test(`${v.title} ${v.channel}`))
    .filter((v) => v.lengthSec === 0 || (v.lengthSec >= 60 && v.lengthSec <= 25 * 60))
    .map((v, i) => ({ v, score: i - (EDU_CHANNELS.includes(v.channel.toLowerCase()) ? 5 : 0) - (v.lengthSec && v.lengthSec <= 12 * 60 ? 1 : 0) }))
    .sort((a, b) => a.score - b.score)
    .map((x) => x.v);
}
