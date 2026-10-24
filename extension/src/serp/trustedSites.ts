// Optional practice links when a student keeps getting stuck on the same concept.
// Restricted to trusted free sites; answer-sharing sites are always blocked.
import { SerpError } from './youtube';

const TRUSTED = ['khanacademy.org', 'openstax.org', 'tutorial.math.lamar.edu'];
const BLOCKED = /chegg\.com|coursehero\.com|brainly\.|quizlet\.com|studocu\.com|numerade\.com/i;

export interface PracticeLink {
  title: string;
  link: string;
  site: string;
}

export async function searchPractice(serpKey: string, concept: string): Promise<PracticeLink[]> {
  const q = `${concept} practice (${TRUSTED.map((s) => `site:${s}`).join(' OR ')})`;
  const url = `https://serpapi.com/search.json?engine=google&num=10&q=${encodeURIComponent(q)}&api_key=${encodeURIComponent(serpKey)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) }).catch(() => {
    throw new SerpError('network', 'Can\'t reach SerpApi.');
  });
  if (!res.ok) throw new SerpError(res.status === 429 ? 'quota' : 'http', `SerpApi error ${res.status}`);
  const data = await res.json();
  const results: { title?: string; link?: string }[] = data.organic_results ?? [];
  return results
    .filter((r) => r.link && !BLOCKED.test(r.link))
    .map((r) => ({ title: r.title ?? '', link: r.link!, site: new URL(r.link!).hostname.replace(/^www\./, '') }))
    .filter((r) => TRUSTED.some((t) => r.site.endsWith(t)))
    .slice(0, 3);
}
