import { describe, expect, it } from 'vitest';
import { displayLabel, isNumbered, labelOf, looksLikeProblem, problemKey, ProblemTracker, severalQuestions, type TrackContext } from '../src/background/problemTracker';
import { AUTO_START_BUDGET, AUTO_START_DWELL_MS, MOVED_ON_AFTER_MS } from '../src/shared/constants';

const S = 1000;
const T0 = 5_000_000;
const HW = 'https://homework.example/set3';
const key = (label = 'Q4', url = HW) => problemKey(url, label)!;

describe('problemKey', () => {
  it('is the page plus the numbered question, without the #fragment', () => {
    expect(problemKey('https://homework.example/set3?x=1#top', 'Q4')).toBe('https://homework.example/set3?x=1|Q4');
    expect(problemKey('https://homework.example/set3#bottom', 'Q4')).toBe(problemKey('https://homework.example/set3', 'Q4'));
  });

  it('tells questions apart on one page, and pages apart', () => {
    expect(key('Q4')).not.toBe(key('Q5'));
    expect(key('Q4')).not.toBe(key('Q4', 'https://homework.example/set4'));
  });

  it('ignores labels that are not numbered questions, so typing into a box is not "moving to another problem"', () => {
    expect(problemKey(HW, 'Your answer')).toBe(problemKey(HW, 'Homework 3.4'));
    expect(problemKey(HW, 'Part 2')).toBe(problemKey(HW, ''));
    expect(problemKey(HW, 'Problem 2')).not.toBe(problemKey(HW, ''));
  });

  it('is null when there is nothing to identify', () => {
    expect(problemKey(undefined, 'Q1')).toBeNull();
    expect(problemKey('not a url', 'Q1')).toBeNull();
  });

  it('names the question for saying out loud', () => {
    expect(labelOf(key('Q4'))).toBe('Q4');
    expect(isNumbered(key('Q4'))).toBe(true);
    expect(isNumbered(problemKey(HW, 'Your answer')!)).toBe(false);
    expect(displayLabel({ question: 'Q4', title: 'Homework 3' })).toBe('Q4');
    expect(displayLabel({ question: 'Your answer', title: 'Homework 3' })).toBe('Homework 3');
    expect(displayLabel(null)).toBe('this problem');
  });
});

describe('severalQuestions', () => {
  it('spots a page with more than one numbered question, so it waits to be told which one', () => {
    expect(severalQuestions('Question 3 Differentiate g(x). Question 4 Find the derivative of f(x).')).toBe(true);
    expect(severalQuestions('Q3 g(x) = … Q4 f(x) = … Q5 h(x) = …')).toBe(true);
    expect(severalQuestions('Problem 2 and Exercise 7')).toBe(true);
  });
  it('does not mind a page with one question, however often it repeats it', () => {
    expect(severalQuestions('Question 4: Find the derivative. Hint for question 4. Check Q4.')).toBe(false);
    expect(severalQuestions('Find the derivative of f(x) = (3x^2+1)^5.')).toBe(false);
    expect(severalQuestions('Quiet quiz quotes')).toBe(false);
  });
});

describe('ProblemTracker: why a problem was passed over', () => {
  it('remembers whether it was not a problem, or one of several, and forgets after the time is up', () => {
    const t = new ProblemTracker();
    t.reject(key('Q1'), T0, 60_000, 'several');
    t.reject(key('Q2'), T0, 60_000);
    expect(t.rejectedWhy(key('Q1'), T0 + S)).toBe('several');
    expect(t.rejectedWhy(key('Q2'), T0 + S)).toBe('not-a-problem');
    expect(t.rejectedWhy(key('Q3'), T0 + S)).toBeNull();
    expect(t.rejectedWhy(key('Q1'), T0 + 61 * S)).toBeNull();
  });
});

describe('looksLikeProblem', () => {
  const text = 'Find the derivative of f(x) = (3x^2 + 1)^5 and simplify your answer completely.';
  const lp = (o: Partial<Parameters<typeof looksLikeProblem>[0]> & { url: string; viewportText: string }) => looksLikeProblem({ title: '', ...o });
  it('wants some text and either a numbered question or somewhere to answer', () => {
    expect(lp({ url: HW, viewportText: text, question: 'Q4', fields: 0 })).toBe(true);
    expect(lp({ url: HW, viewportText: text, question: 'Your answer', fields: 1 })).toBe(true);
    expect(lp({ url: HW, viewportText: text, question: 'Homework', fields: 0 })).toBe(false); // an article
    expect(lp({ url: HW, viewportText: 'Sign in', question: 'Q4', fields: 2 })).toBe(false); // a login box
  });

  it('never treats a search or chat page as a problem', () => {
    expect(lp({ url: 'https://www.google.com/search?q=chain+rule', viewportText: text, question: 'Q1', fields: 3 })).toBe(false);
    expect(lp({ url: 'https://chatgpt.com/c/abc', viewportText: text, fields: 1 })).toBe(false);
  });

  describe('with what the page looks like', () => {
    const board = { canvasShare: 0.9, editorShare: 0, toolButtons: 4, answerFields: 0, checkButton: false, questionLabels: 0, textLen: 80, problemCues: 0 };
    const doc = { canvasShare: 0, editorShare: 0.7, toolButtons: 0, answerFields: 0, checkButton: false, questionLabels: 0, textLen: 700, problemCues: 3 };
    const homework = { canvasShare: 0, editorShare: 0, toolButtons: 0, answerFields: 1, checkButton: true, questionLabels: 0, textLen: 400, problemCues: 4 };

    it('does not take a drawing board for the problem, even when it has text and a box to type in', () => {
      expect(lp({ url: 'https://sketch.io/sketchpad/', viewportText: text, fields: 1, roleHints: board })).toBe(false);
      expect(lp({ url: 'https://some-unknown-board.example/', viewportText: text, fields: 1, roleHints: board })).toBe(false);
    });
    it('does not take a document for the problem', () => {
      expect(lp({ url: 'https://docs.google.com/document/d/abc/edit', viewportText: text, fields: 1, roleHints: doc })).toBe(false);
    });
    it('takes a homework page for the problem, with or without a box to type in', () => {
      expect(lp({ url: 'https://www.khanacademy.org/math/algebra/x', viewportText: text, fields: 0, roleHints: homework })).toBe(true);
      expect(lp({ url: 'https://www.khanacademy.org/math/algebra/x', viewportText: text, fields: 0, roleHints: { ...homework, checkButton: false, answerFields: 0 } })).toBe(true); // the site alone says so
    });
    it('still takes a numbered question as a problem, wherever it is', () => {
      expect(lp({ url: 'https://sketch.io/', viewportText: text, question: 'Q4', fields: 1, roleHints: board })).toBe(true);
    });
  });
});

describe('ProblemTracker: settling on a problem', () => {
  const ctx = (over: Partial<TrackContext> = {}): TrackContext => ({ now: T0, focusedTabId: 1, canStart: true, session: null, declined: () => false, ...over });
  /** The page reports its problem every second for `seconds`. */
  function dwell(t: ProblemTracker, tab: number, k: string, seconds: number, from = T0) {
    for (let s = 0; s <= seconds; s++) t.observe(tab, k, from + s * S);
    return from + seconds * S;
  }

  it('starts following once the student has stayed on a problem long enough, and not before', () => {
    const t = new ProblemTracker();
    let now = dwell(t, 1, key(), AUTO_START_DWELL_MS / S - 1);
    expect(t.decide(ctx({ now }))).toEqual({ kind: 'none' });
    now = dwell(t, 1, key(), AUTO_START_DWELL_MS / S);
    expect(t.decide(ctx({ now }))).toEqual({ kind: 'start', tabId: 1, key: key() });
  });

  it('starts the count over when the problem changes', () => {
    const t = new ProblemTracker();
    dwell(t, 1, key('Q4'), 10);
    const now = dwell(t, 1, key('Q5'), 5, T0 + 11 * S);
    expect(t.decide(ctx({ now }))).toEqual({ kind: 'none' });
  });

  it('starts the count over when the page stops reporting (they switched away)', () => {
    const t = new ProblemTracker();
    dwell(t, 1, key(), 8);
    t.observe(1, key(), T0 + 30 * S); // back after 22 s away
    expect(t.decide(ctx({ now: T0 + 30 * S + AUTO_START_DWELL_MS - S }))).toEqual({ kind: 'none' });
  });

  it('only follows the tab the student is looking at', () => {
    const t = new ProblemTracker();
    const now = dwell(t, 2, key(), 20);
    expect(t.decide(ctx({ now, focusedTabId: 1 }))).toEqual({ kind: 'none' });
    expect(t.decide(ctx({ now, focusedTabId: 2 }))).toMatchObject({ kind: 'start', tabId: 2 });
  });

  it('waits while it is not allowed to start', () => {
    const t = new ProblemTracker();
    const now = dwell(t, 1, key(), 20);
    expect(t.decide(ctx({ now, canStart: false }))).toEqual({ kind: 'none' });
  });

  it('does not start a problem the student sent away, or one the model said is not a problem', () => {
    const t = new ProblemTracker();
    const now = dwell(t, 1, key(), 20);
    expect(t.decide(ctx({ now, declined: (k) => k === key() }))).toEqual({ kind: 'none' });
    t.reject(key(), now, 600_000);
    expect(t.isRejected(key(), now)).toBe(true);
    expect(t.decide(ctx({ now }))).toEqual({ kind: 'none' });
    const later = dwell(t, 1, key(), 15, now + 601 * S);
    expect(t.decide(ctx({ now: later }))).toMatchObject({ kind: 'start' }); // forgiven after a while
  });

  it('caps automatic starts, so flicking through pages cannot run up model calls', () => {
    const t = new ProblemTracker();
    let now = T0;
    let starts = 0;
    for (let i = 0; i < AUTO_START_BUDGET.max + 3; i++) {
      const k = key(`Q${i + 1}`);
      now = dwell(t, 1, k, 15, now + S);
      if (t.decide(ctx({ now })).kind === 'start') {
        starts++;
        t.started(now);
      }
    }
    expect(starts).toBe(AUTO_START_BUDGET.max);
  });

  it('reports how long they have been on a page, for the panel', () => {
    const t = new ProblemTracker();
    const now = dwell(t, 1, key(), 7);
    expect(t.candidate({ now, focusedTabId: 1 })).toEqual({ tabId: 1, key: key(), forMs: 7 * S });
    expect(t.candidate({ now: now + 10 * S, focusedTabId: 1 })).toBeNull();
  });
});

describe('ProblemTracker: a problem is already being followed', () => {
  const session = { key: key('Q4'), tabId: 1 };
  const ctx = (now: number, over: Partial<TrackContext> = {}): TrackContext => ({ now, focusedTabId: 1, canStart: true, session, declined: () => false, ...over });
  function dwell(t: ProblemTracker, tab: number, k: string, seconds: number, from = T0) {
    for (let s = 0; s <= seconds; s++) t.observe(tab, k, from + s * S);
    return from + seconds * S;
  }

  it('does not start the problem it is already following', () => {
    const t = new ProblemTracker();
    expect(t.decide(ctx(dwell(t, 1, key('Q4'), 30)))).toEqual({ kind: 'none' });
  });

  it('notices the next question, says so once, then follows it when they settle', () => {
    const t = new ProblemTracker();
    let now = dwell(t, 1, key('Q5'), MOVED_ON_AFTER_MS / S);
    expect(t.decide(ctx(now))).toEqual({ kind: 'moved', key: key('Q5') });
    now = dwell(t, 1, key('Q5'), 6, now + S);
    expect(t.decide(ctx(now))).toEqual({ kind: 'none' }); // reported once, not every second
    now = dwell(t, 1, key('Q5'), AUTO_START_DWELL_MS / S, now + S);
    expect(t.decide(ctx(now))).toEqual({ kind: 'start', tabId: 1, key: key('Q5') });
  });

  it('does not call a flicker a move', () => {
    const t = new ProblemTracker();
    t.observe(1, key('Q5'), T0);
    expect(t.decide(ctx(T0 + S))).toEqual({ kind: 'none' });
  });

  it('notices they came back', () => {
    const t = new ProblemTracker();
    let now = dwell(t, 1, key('Q5'), 3);
    expect(t.decide(ctx(now)).kind).toBe('moved');
    now = dwell(t, 1, key('Q4'), 1, now + S);
    expect(t.decide(ctx(now))).toEqual({ kind: 'back' });
    expect(t.decide(ctx(now + S))).toEqual({ kind: 'none' });
  });

  it('is not fooled by the tab where the student writes their work', () => {
    // A notes page or sketchpad can look like "a page with a box to type in". Only a numbered question elsewhere counts.
    const t = new ProblemTracker();
    const notes = problemKey('https://notes.example/doc', 'Your answer')!;
    let now = dwell(t, 2, notes, 30);
    expect(t.decide(ctx(now, { focusedTabId: 2 }))).toEqual({ kind: 'none' });
    const q6 = key('Q6', 'https://other.example/quiz');
    now = dwell(t, 2, q6, 20, now + S);
    expect(t.decide(ctx(now, { focusedTabId: 2 }))).toMatchObject({ kind: 'start', tabId: 2 });
  });

  it('treats a page that starts naming its question as the same problem, not a move', () => {
    // Followed from a page that named no question (the label only appears once the student types into one).
    const pageLevel = { key: problemKey(HW, '')!, tabId: 1 };
    const t = new ProblemTracker();
    const now = dwell(t, 1, key('Q4'), MOVED_ON_AFTER_MS / S);
    expect(t.decide(ctx(now, { session: pageLevel }))).toEqual({ kind: 'refine', key: key('Q4') });
  });

  it('but a different page, or going back to no question, is still a move', () => {
    const t = new ProblemTracker();
    const pageLevel = { key: problemKey(HW, '')!, tabId: 1 };
    const now = dwell(t, 1, key('Q4', 'https://homework.example/set4'), 3);
    expect(t.decide(ctx(now, { session: pageLevel })).kind).toBe('moved');
    const u = new ProblemTracker();
    const later = dwell(u, 1, problemKey(HW, '')!, 3);
    expect(u.decide(ctx(later)).kind).toBe('moved'); // the session is on Q4, the page now names none
  });

  it('forgets the "moved" report when the session changes', () => {
    const t = new ProblemTracker();
    const now = dwell(t, 1, key('Q5'), 3);
    expect(t.decide(ctx(now)).kind).toBe('moved');
    t.sessionChanged();
    expect(t.decide(ctx(now)).kind).toBe('moved'); // against a new session, it is news again
  });
});
