import { describe, expect, it } from 'vitest';
import { CORRECT_RE, INCORRECT_RE } from '../src/content/contentSignals';

// What homework sites say after "Check": the page's own verdict is the strongest signal there is, so the common phrasings matter.
describe('what a homework page says after you check', () => {
  const says = (text: string) => ({ right: CORRECT_RE.test(text) && !INCORRECT_RE.test(text), wrong: INCORRECT_RE.test(text) });

  it.each(['Correct!', 'Correct.', 'Correct', '  Correct!  ', '✓ Correct! Nice work.', 'Nice work!', 'Well done', 'Great job!', 'You got it!', "That's right!", 'All tests passed', '✓', '✅ Accepted'])(
    '"%s" is the page saying the answer is right',
    (text) => expect(says(text)).toEqual({ right: true, wrong: false }),
  );

  it.each(['Incorrect', 'Incorrect. Try again.', 'Not quite. Check your work and try again.', 'Not quite — try again', 'Wrong answer', "That's not right", '✗ Incorrect', '❌'])(
    '"%s" is the page saying the answer is wrong',
    (text) => expect(says(text).wrong).toBe(true),
  );

  it('does not take "incorrect" or "not correct" for a correct answer', () => {
    expect(says('Incorrect')).toEqual({ right: false, wrong: true });
    expect(says('That is not correct')).toEqual({ right: false, wrong: true });
  });

  it('does not take an instruction that happens to use the word for a verdict', () => {
    expect(says('Correct the errors in the sentence below').right).toBe(false);
    expect(says('Enter the correct value of x').right).toBe(false);
  });
});
