import { describe, expect, it } from 'vitest';
import { VideoCache, type CacheKV } from '../src/serp/cache';
import { parseLength, rankCandidates, type VideoCandidate } from '../src/serp/youtube';
import type { VideoMoment } from '../src/shared/types';

class FakeKV implements CacheKV {
  data: Record<string, unknown> = {};
  async get(key: string) {
    return key in this.data ? { [key]: structuredClone(this.data[key]) } : {};
  }
  async set(items: Record<string, unknown>) {
    Object.assign(this.data, structuredClone(items));
  }
}

const moment: VideoMoment = {
  videoId: 'abcdefghijk',
  title: 'Chain rule explained',
  channel: 'Khan Academy',
  start: 72,
  end: 220,
  why: 'how the chain rule works',
  concept: 'chain rule',
  source: 'gemini-video',
};

describe('VideoCache', () => {
  it('misses, then hits after set (keyed loosely by concept)', async () => {
    const c = new VideoCache(new FakeKV(), {});
    expect(await c.get('Chain Rule')).toBeNull();
    await c.set('chain rule', moment);
    const hit = await c.get('  Chain-Rule ');
    expect(hit?.videoId).toBe('abcdefghijk');
    expect(hit?.source).toBe('cache');
  });

  it('falls back to the bundled demo cache only when allowed (SerpApi down)', async () => {
    const c = new VideoCache(new FakeKV(), { 'chain rule': moment });
    expect(await c.get('chain rule')).toBeNull();
    expect((await c.get('chain rule', true))?.videoId).toBe('abcdefghijk');
  });

  it('exports live entries for pre-caching', async () => {
    const c = new VideoCache(new FakeKV(), {});
    await c.set('chain rule', moment);
    expect(Object.keys(await c.export())).toEqual(['chain rule']);
  });
});

describe('YouTube candidate ranking', () => {
  const v = (title: string, channel: string, lengthSec: number): VideoCandidate => ({
    videoId: title.slice(0, 11).padEnd(11, 'x'),
    title,
    channel,
    lengthSec,
    description: '',
    chapters: [],
  });

  it('parses lengths', () => {
    expect(parseLength('5:31')).toBe(331);
    expect(parseLength('1:02:03')).toBe(3723);
  });

  it('drops answer dumps and very long videos, boosts educational channels', () => {
    const ranked = rankCandidates([
      v('Homework answers for chapter 3', 'Random', 300),
      v('Chain rule intro', 'Some Channel', 400),
      v('Full calculus course', 'Uni', 4 * 3600),
      v('The chain rule', 'Khan Academy', 500),
    ]);
    expect(ranked.map((r) => r.title)).toEqual(['The chain rule', 'Chain rule intro']);
  });
});
