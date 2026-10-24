// Video moments cached per concept in chrome.storage.local (the SerpApi free quota is small).
// demoCache.json ships pre-filled results for the demo concepts; export the live cache from
// the options page and paste it there before demo day.
import type { VideoMoment } from '../shared/types';
import demoCache from './demoCache.json';

const KEY = 'videoCache';
const TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface CacheKV {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

type Entry = { moment: VideoMoment; at: number };

export function conceptKey(concept: string): string {
  return concept.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export class VideoCache {
  constructor(private kv: CacheKV, private bundled: Record<string, VideoMoment> = demoCache as Record<string, VideoMoment>) {}

  private async all(): Promise<Record<string, Entry>> {
    const { [KEY]: v } = await this.kv.get(KEY);
    return (v as Record<string, Entry>) ?? {};
  }

  /** Fresh live entry first; `allowStale` (used when SerpApi fails) also accepts old entries and the bundled demo cache. */
  async get(concept: string, allowStale = false): Promise<VideoMoment | null> {
    const k = conceptKey(concept);
    const e = (await this.all())[k];
    if (e && (allowStale || Date.now() - e.at < TTL_MS)) return { ...e.moment, source: 'cache' };
    const b = this.bundled[k];
    if (b && allowStale) return { ...b, source: 'cache' };
    return null;
  }

  async set(concept: string, moment: VideoMoment): Promise<void> {
    const all = await this.all();
    all[conceptKey(concept)] = { moment, at: Date.now() };
    await this.kv.set({ [KEY]: all });
  }

  async export(): Promise<Record<string, VideoMoment>> {
    const out: Record<string, VideoMoment> = {};
    for (const [k, e] of Object.entries(await this.all())) out[k] = e.moment;
    return out;
  }
}
