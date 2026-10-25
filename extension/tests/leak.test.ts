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
  studentWork: '',
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

describe('guardedTutorTurn', () => {
  const turn = (message: string, suggestions: string[] = []): TutorTurn => ({
    replyAssessment: 'none',
    hintLevel: 1,
    message,
    suggestions,
    missingPrerequisite: '',
  });
  const args = { hidden: math, history: [], action: 'start' as const, studentText: '', minLevel: 1 as const };
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

  it('rejects a draft whose suggestions leak even if the question is safe', async () => {
    const drafts = [turn('What equation fits?', ['Check that you get 2.02 s']), turn('What equation fits?', ['Write down what you know'])];
    const deps: GuardDeps = { draft: async () => drafts.shift()!, judge: async () => ({ leaks: false, reason: '' }) };
    const r = await guardedTutorTurn(ctx, args, deps);
    expect(r.fallback).toBe(false);
    expect(r.turn.suggestions).toEqual(['Write down what you know']);
    expect(r.attempts[0].verdict.leaks).toBe(true);
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
