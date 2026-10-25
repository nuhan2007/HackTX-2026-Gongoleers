// What each reading of the student's work means for the sprite.
import { describe, expect, it } from 'vitest';
import { decideRead, wantsMessage, type ReadFacts } from '../src/background/readPolicy';

const facts = (over: Partial<ReadFacts> = {}): ReadFacts => ({
  status: 'possible_mistake',
  readability: 'clear',
  mistakeStreak: 1,
  sprite: null,
  spriteOrigin: null,
  now: 1_000_000,
  reflagAfter: 0,
  flagMistakes: true,
  celebrated: false,
  ...over,
});

describe('flagging a mistake', () => {
  it('flags it at once when the handwriting could be read clearly', () => {
    expect(decideRead(facts())).toBe('flag');
  });

  it('waits for two readings in a row to agree when it could not read the handwriting clearly', () => {
    expect(decideRead(facts({ readability: 'hard_to_read', mistakeStreak: 1 }))).toBe('none');
    expect(decideRead(facts({ readability: 'hard_to_read', mistakeStreak: 2 }))).toBe('flag');
    expect(decideRead(facts({ readability: null, mistakeStreak: 1 }))).toBe('none');
  });

  it('does nothing with the switch off', () => {
    expect(decideRead(facts({ flagMistakes: false }))).toBe('none');
  });

  it('does not pile a second message on one that is already up (a mistake, or a cheer)', () => {
    expect(decideRead(facts({ sprite: 'mistake', spriteOrigin: 'read' }))).toBe('none');
    expect(decideRead(facts({ sprite: 'mistake', spriteOrigin: 'page' }))).toBe('none');
    expect(decideRead(facts({ sprite: 'cheer' }))).toBe('none');
  });

  it('replaces a hint or an offer to check, because where the work went wrong is the better help', () => {
    expect(decideRead(facts({ sprite: 'stuck' }))).toBe('flag');
    expect(decideRead(facts({ sprite: 'check-work' }))).toBe('flag');
  });

  it('does not nag: after the student dismissed one, the next waits', () => {
    const now = 1_000_000;
    expect(decideRead(facts({ now, reflagAfter: now + 60_000 }))).toBe('none');
    expect(decideRead(facts({ now: now + 60_000, reflagAfter: now + 60_000 }))).toBe('flag');
  });
});

describe('a problem copied down wrongly is only called out once it is finished', () => {
  const copy = (over: Partial<ReadFacts> = {}) => facts({ copyWrong: true, copyStreak: 1, idleMs: 1_500, mistakeStreak: 1, ...over });

  it('does not say anything on the first reading: a half-written copy always differs from the whole problem', () => {
    expect(decideRead(copy())).toBe('settle');
  });

  it('does not flag while the student is still writing, even when two readings agree', () => {
    expect(decideRead(copy({ copyStreak: 2, idleMs: 600 }))).toBe('settle');
    expect(decideRead(copy({ copyStreak: 3, idleMs: null }))).toBe('settle');
  });

  it('flags it once two readings agree and the student had stopped writing when the second was taken', () => {
    expect(decideRead(copy({ copyStreak: 2, idleMs: 2_600 }))).toBe('flag');
    expect(decideRead(copy({ copyStreak: 2, idleMs: 2_500 }))).toBe('flag');
  });

  it('does not need the handwriting to be clear to wait: it never flags early, whatever the readability', () => {
    expect(decideRead(copy({ readability: 'clear', copyStreak: 1, idleMs: 30_000 }))).toBe('settle');
  });

  it('still respects the switch, a message already up, and a dismissed flag', () => {
    expect(decideRead(copy({ copyStreak: 2, idleMs: 3_000, flagMistakes: false }))).toBe('none');
    expect(decideRead(copy({ copyStreak: 2, idleMs: 3_000, sprite: 'mistake' }))).toBe('none');
    expect(decideRead(copy({ copyStreak: 2, idleMs: 3_000, now: 5, reflagAfter: 99 }))).toBe('none');
  });

  it('a step mistake is not slowed down by any of this', () => {
    expect(decideRead(facts({ copyWrong: false, copyStreak: 0, idleMs: 100 }))).toBe('flag');
  });
});

describe('cheering', () => {
  it('cheers when a reading sees the finished correct answer, once per problem', () => {
    expect(decideRead(facts({ status: 'solved', mistakeStreak: 0 }))).toBe('cheer');
    expect(decideRead(facts({ status: 'solved', mistakeStreak: 0, celebrated: true }))).toBe('none');
  });

  it('cheers even over a hint that is up (they solved it, the hint is moot)', () => {
    expect(decideRead(facts({ status: 'solved', mistakeStreak: 0, sprite: 'stuck' }))).toBe('cheer');
  });
});

describe('a message that no longer applies', () => {
  it('takes down a mistake a reading flagged once a later reading says the work is fine', () => {
    expect(decideRead(facts({ status: 'on_track', mistakeStreak: 0, sprite: 'mistake', spriteOrigin: 'read' }))).toBe('clear');
  });

  it('does NOT take down a mistake the homework page or the check found (the page has the last word)', () => {
    expect(decideRead(facts({ status: 'on_track', mistakeStreak: 0, sprite: 'mistake', spriteOrigin: 'page' }))).toBe('none');
    expect(decideRead(facts({ status: 'on_track', mistakeStreak: 0, sprite: 'mistake', spriteOrigin: 'check' }))).toBe('none');
  });

  it('leaves everything else alone', () => {
    for (const status of ['no_work', 'unknown', 'different_problem'] as const) expect(decideRead(facts({ status, mistakeStreak: 0, sprite: 'mistake', spriteOrigin: 'read' }))).toBe('none');
  });
});

describe('asking for a message with the reading', () => {
  const w = (over: object = {}) => ({ sprite: null, now: 5, reflagAfter: 0, flagMistakes: true, celebrated: false, celebrate: true, ...over });
  it('is worth it while something could be shown', () => {
    expect(wantsMessage(w())).toBe(true);
  });
  it('is not when a mistake or cheer is up, the student just dismissed one, and there is nothing to cheer', () => {
    expect(wantsMessage(w({ sprite: 'mistake', celebrated: true }))).toBe(false);
    expect(wantsMessage(w({ reflagAfter: 99, celebrated: true }))).toBe(false);
  });
  it('is still worth it for a cheer when flagging is off or blocked', () => {
    expect(wantsMessage(w({ flagMistakes: false }))).toBe(true);
    expect(wantsMessage(w({ sprite: 'mistake' }))).toBe(true);
  });
  it('is not when both are off', () => {
    expect(wantsMessage(w({ flagMistakes: false, celebrate: false }))).toBe(false);
  });
});
