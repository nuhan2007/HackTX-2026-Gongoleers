import { describe, expect, it } from 'vitest';
import { quotesProblem } from '../src/ai/concept';
import { deterministicLeak, extractNumbers } from '../src/leak/deterministic';
import { guardedTutorTurn, type GuardDeps } from '../src/leak/guard';
import type { SolverResult, TutorTurn } from '../src/shared/types';

const solved = (over: Partial<SolverResult>): SolverResult => ({
  problemDetected: true,
  problemText: '',
  finalAnswer: '',
  keySteps: [],
  conceptTags: [],
  misconceptions: [],
  answerKeyPhrases: [],
  ...over,
});

const math = solved({
  problemText: 'A ball is dropped from 20 m. Ignoring air resistance, how long until it hits the ground? Use g = 9.8 m/s^2.',
  finalAnswer: '2.02 s',
  answerKeyPhrases: ['t^2 = 4.08'],
});

describe('extractNumbers', () => {
  it('expands fractions and percents', () => {
    expect(extractNumbers('1/2')).toContain(0.5);
    expect(extractNumbers('50%')).toContain(0.5);
    expect(extractNumbers('1,000 m')).toContain(1000);
    expect(extractNumbers('x = −3')).toContain(-3);
  });
});

describe('deterministicLeak: math', () => {
  it('flags the exact answer', () => {
    expect(deterministicLeak('So the time is 2.02 seconds, right?', math).leaks).toBe(true);
  });
  it('flags a rounded answer', () => {
    expect(deterministicLeak('Do you get about 2.0 s? Close to 2.02?', math).leaks).toBe(true);
    expect(deterministicLeak('Is it around 2.019?', math).leaks).toBe(true);
  });
  it('flags an intermediate result from key phrases', () => {
    expect(deterministicLeak('Once you have t² = 4.08, what next?', math).leaks).toBe(true);
  });
  it('allows numbers that are given in the problem', () => {
    expect(deterministicLeak('What does the 20 m and the 9.8 tell you?', math).leaks).toBe(false);
  });
  it('allows naming the concept', () => {
    expect(deterministicLeak('Which kinematics equation connects distance, acceleration and time when starting from rest?', math).leaks).toBe(false);
  });
  it('treats 0.5, 1/2 and 50% as the same answer', () => {
    const p = solved({ problemText: 'What fraction of the coins are heads?', finalAnswer: '0.5' });
    expect(deterministicLeak('Is it 1/2?', p).leaks).toBe(true);
    expect(deterministicLeak('Maybe 50%?', p).leaks).toBe(true);
    const q = solved({ problemText: 'What percent are heads?', finalAnswer: '50%' });
    expect(deterministicLeak('so 0.5 of them', q).leaks).toBe(true);
  });
  it('flags an algebraic answer string', () => {
    const p = solved({ problemText: 'Differentiate f(x) = x^2 + 3x', finalAnswer: "f'(x) = 2x + 3" });
    expect(deterministicLeak('So the derivative is 2x+3, does that make sense?', p).leaks).toBe(true);
    expect(deterministicLeak('What does the power rule say about x^2?', p).leaks).toBe(false);
  });
});

describe('deterministicLeak: multiple choice', () => {
  const mc = solved({
    problemText: 'Which is a prime number? (A) 21 (B) 23 (C) 25 (D) 27',
    finalAnswer: 'B) 23',
  });
  it('flags the choice letter', () => {
    expect(deterministicLeak('The answer is B.', mc).leaks).toBe(true);
    expect(deterministicLeak('Take a look at (B) again.', mc).leaks).toBe(true);
    expect(deterministicLeak('I think option B is worth a second look', mc).leaks).toBe(true);
    expect(deterministicLeak('B is correct!', mc).leaks).toBe(true);
  });
  it('flags endorsing the option text', () => {
    expect(deterministicLeak('You should pick 23 here.', mc).leaks).toBe(true);
  });
  it('allows a guiding question', () => {
    expect(deterministicLeak('What does it mean for a number to be prime? Try dividing each choice by 3.', mc).leaks).toBe(false);
  });
  it('does not mistake the article "a" for choice A', () => {
    const a = solved({ problemText: 'Which is even? (A) 4 (B) 5', finalAnswer: 'A' });
    expect(deterministicLeak('What is a quick test for whether a number is even?', a).leaks).toBe(false);
  });
});

describe('deterministicLeak: code', () => {
  const code = solved({
    problemText: 'Write a method sumArray(int[] nums) that returns the sum of all elements.',
    finalAnswer: 'public int sumArray(int[] nums) {\n  int total = 0;\n  for (int n : nums) total += n;\n  return total;\n}',
  });
  it('flags a final code line', () => {
    expect(deterministicLeak('Try: for (int n : nums) total += n;', code).leaks).toBe(true);
    expect(deterministicLeak('Inside the loop, write `total += n` hmm', code).leaks).toBe(false); // too short to be a whole line
  });
  it('flags writing out the solution with its identifiers', () => {
    const offByOne = solved({
      problemText: 'Fix the bug: the loop skips the last element.',
      finalAnswer: 'for (int idx = 0; idx < values.length; idx++) { runningSum += values[idx]; }',
    });
    expect(deterministicLeak('Use runningSum += values[idx] with idx going up', offByOne).leaks).toBe(true);
  });
  it('allows conceptual questions about loops', () => {
    expect(deterministicLeak('What variable could keep track of the total as you visit each element?', code).leaks).toBe(false);
  });
});

describe('deterministicLeak: harder problems (several values, LaTeX, lists)', () => {
  it('treats a LaTeX answer as maths, not code: its numbers are still secret', () => {
    const p = solved({ problemText: 'A 12 V source drives 5 ohms of resistance. Find the current.', finalAnswer: '$I = \\frac{12}{5} = 2.4\\text{ A}$' });
    expect(deterministicLeak('Do you get about 2.4 amps?', p).leaks).toBe(true);
    expect(deterministicLeak('Which law relates the voltage and the resistance?', p).leaks).toBe(false);
  });
  it('guards every value of an answer that gives several results', () => {
    const p = solved({ problemText: 'Find the node voltages.', finalAnswer: 'V1 = 6.4 V, V2 = 12.5 V' });
    expect(deterministicLeak('Is V1 about 6.4?', p).leaks).toBe(true);
    expect(deterministicLeak('Check V2 against 12.5 volts', p).leaks).toBe(true);
  });
  it('guards every value of a milestone that gives several, not only the last', () => {
    const p = solved({
      problemText: 'Find the node voltages.',
      finalAnswer: 'see checkpoints',
      checkpoints: [{ label: 'both nodes', expected: 'V1 = 4.8 V, V2 = 7.3 V' }],
    });
    expect(deterministicLeak('Your V1 should come out near 4.8.', p).leaks).toBe(true);
    expect(deterministicLeak('Your V2 should be 7.3.', p).leaks).toBe(true);
    expect(deterministicLeak('Write KCL at node 1 first.', p).leaks).toBe(false);
  });
  it('still guards the distinctive values of an answer that is a long list of numbers', () => {
    const p = solved({ problemText: 'Compute the vector.', finalAnswer: '(1, 2, 3, 4, 17.25)' });
    expect(deterministicLeak('The last entry should be 17.25.', p).leaks).toBe(true);
    expect(deterministicLeak('There are five entries; start with the first.', p).leaks).toBe(false);
  });
  it('does not take "d = 4" for the multiple-choice answer D', () => {
    const p = solved({ problemText: 'Find the distance d between the points.', finalAnswer: 'd = 4.5' });
    expect(deterministicLeak('Try labelling each point (D) and (E) on the sketch.', p).leaks).toBe(false);
  });
  it('lets a hint name the method or concept even if the key lists it as a phrase', () => {
    const p = solved({
      problemText: 'Find the voltage at each node of the circuit.',
      finalAnswer: 'V1 = 6.4 V',
      conceptTags: ['node voltage analysis'],
      problemKind: 'node voltage analysis',
      answerKeyPhrases: ['node voltage analysis', 'V1 = 6.4'],
    });
    expect(deterministicLeak('This is a job for node voltage analysis: where would you start?', p).leaks).toBe(false);
    expect(deterministicLeak('So V1 = 6.4, then?', p).leaks).toBe(true);
  });
});

describe('guardedTutorTurn', () => {
  const turn = (message: string): TutorTurn => ({ replyAssessment: 'none', hintLevel: 1, message, missingPrerequisite: '' });
  const args = { hidden: math, history: [], action: 'auto' as const, minLevel: 1 as const };
  const ctx = { apiKey: 'test', model: 'test' };

  it('regenerates a leaking draft and returns the safe one', async () => {
    const drafts = ['It takes 2.02 s.', 'What equation relates distance and time from rest?'];
    const deps: GuardDeps = { draft: async () => turn(drafts.shift()!), judge: async () => ({ leaks: false, reason: '' }) };
    const r = await guardedTutorTurn(ctx, args, deps);
    expect(r.fallback).toBe(false);
    expect(r.turn.message).toMatch(/equation/);
    expect(r.attempts).toHaveLength(2);
    expect(r.attempts[0].by).toBe('deterministic');
  });

  it('respects the judge', async () => {
    const deps: GuardDeps = {
      draft: async () => turn('The ball falls for a bit over two seconds.'),
      judge: async () => ({ leaks: true, reason: 'approximate answer' }),
    };
    const r = await guardedTutorTurn(ctx, args, deps);
    expect(r.fallback).toBe(true);
    expect(r.attempts).toHaveLength(3);
  });

  it('fails closed when the judge errors', async () => {
    const deps: GuardDeps = {
      draft: async () => turn('What do you know?'),
      judge: async () => {
        throw new Error('timeout');
      },
    };
    expect((await guardedTutorTurn(ctx, args, deps)).fallback).toBe(true);
  });
});

describe('quotesProblem', () => {
  it('rejects queries that copy the problem wording', () => {
    expect(quotesProblem('ball is dropped from 20 m', math.problemText)).toBe(true);
    expect(quotesProblem('free fall kinematics explained', math.problemText)).toBe(false);
  });
});
