import { describe, expect, it } from 'vitest';
import { PHRASES, PhraseDeck, type PhrasePool } from '../src/shared/phrases';

const pools = Object.keys(PHRASES) as PhrasePool[];

describe('what the sprite says in its own words', () => {
  it('has several phrasings for every situation', () => {
    for (const p of pools) expect(new Set(PHRASES[p]).size, p).toBeGreaterThanOrEqual(4);
  });

  it('never says "looks tricky" (or anything like it)', () => {
    for (const p of pools) for (const phrase of PHRASES[p]) expect(phrase, `${p}: ${phrase}`).not.toMatch(/tricky|think it through together/i);
  });

  it('never gives the same phrase twice in a row, however long it runs', () => {
    const deck = new PhraseDeck();
    for (const p of pools) {
      let last = '';
      for (let i = 0; i < 200; i++) {
        const next = deck.next(p);
        expect(next, `${p} #${i}`).not.toBe(last);
        last = next;
      }
    }
  });

  it('uses up the whole pool before it repeats anything', () => {
    const deck = new PhraseDeck();
    for (const p of pools) {
      const seen = new Set<string>();
      for (let i = 0; i < PHRASES[p].length; i++) seen.add(deck.next(p));
      expect(seen.size, p).toBe(PHRASES[p].length);
    }
  });

  it('is not the same order each time (it is shuffled)', () => {
    const orders = new Set<string>();
    for (let k = 0; k < 8; k++) {
      const deck = new PhraseDeck();
      orders.add(Array.from({ length: PHRASES.cheer.length }, () => deck.next('cheer')).join('|'));
    }
    expect(orders.size).toBeGreaterThan(1);
  });

  it('keeps pools apart: a hint heading is never a cheer', () => {
    const deck = new PhraseDeck();
    for (let i = 0; i < 30; i++) expect(PHRASES.cheer).toContain(deck.next('cheer'));
    for (let i = 0; i < 30; i++) expect(PHRASES.hint).toContain(deck.next('hint'));
  });

  it('works with a fixed random source too (and still does not repeat at the seam between two passes)', () => {
    const deck = new PhraseDeck(() => 0);
    let last = '';
    for (let i = 0; i < PHRASES.hint.length * 3; i++) {
      const next = deck.next('hint');
      expect(next).not.toBe(last);
      last = next;
    }
  });
});
