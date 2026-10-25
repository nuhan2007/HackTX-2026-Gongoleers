// Which tab is the homework and which is where the student writes? Several indicators, none trusted alone.
import { describe, expect, it } from 'vitest';
import { EMPTY_HINTS, roleOf, scoreRole, type RoleHints } from '../src/shared/pageRole';
import { MIN_WORK_INPUT, STRONG_WORK_INPUT, TabRoles } from '../src/background/tabRoles';

const NO_INPUT = { recent: 0, min: MIN_WORK_INPUT, strong: STRONG_WORK_INPUT };
const TYPING = { recent: 12, min: MIN_WORK_INPUT, strong: STRONG_WORK_INPUT };
const LOTS = { recent: 90, min: MIN_WORK_INPUT, strong: STRONG_WORK_INPUT };
const hints = (o: Partial<RoleHints>): RoleHints => ({ ...EMPTY_HINTS, ...o });

const board = hints({ canvasShare: 0.85, toolButtons: 5, textLen: 120 });
const doc = hints({ editorShare: 0.7, textLen: 800 });
const homework = hints({ answerFields: 1, checkButton: true, questionLabels: 1, textLen: 600, problemCues: 5 });
const role = (url: string, title: string, h: RoleHints | null, input = NO_INPUT) => roleOf(scoreRole(url, title, h, input));

describe('known sites', () => {
  it('knows drawing boards, whiteboards, notes and documents as places to work', () => {
    for (const url of [
      'https://sketch.io/sketchpad/',
      'https://excalidraw.com/#room=abc',
      'https://miro.com/app/board/x/',
      'https://www.figma.com/board/x',
      'https://docs.google.com/document/d/abc/edit',
      'https://docs.google.com/drawings/d/abc/edit',
      'https://www.onenote.com/notebooks',
      'https://replit.com/@me/x',
      'https://www.desmos.com/calculator',
    ])
      expect(role(url, '', null), url).toBe('work');
  });

  it('knows homework platforms as places the problems are', () => {
    for (const url of [
      'https://www.khanacademy.org/math/algebra/x',
      'https://www.ixl.com/math/algebra-1',
      'https://brilliant.org/courses/x',
      'https://www.webassign.net/web/Student/Assignment',
      'https://leetcode.com/problems/two-sum/',
    ])
      expect(role(url, '', null), url).toBe('problem');
  });

  it('does not take the Google Docs home page (a list of files) for a document to work in', () => {
    expect(role('https://docs.google.com/document/u/0/', '', null)).toBe('unknown');
    expect(role('https://docs.google.com/document/d/abc/edit', '', null)).toBe('work');
  });
});

describe('what the page looks like', () => {
  it('takes a canvas with drawing tools for a board, on a site nobody has heard of', () => {
    expect(role('https://my-school-boards.example/b/12', 'Board', board)).toBe('work');
  });
  it('takes a big writing area for a place to work, and a page of answer boxes plus a Check button for homework', () => {
    expect(role('https://notes.example/p/1', '', doc)).toBe('work');
    expect(role('https://school.example/hw/3', '', homework)).toBe('problem');
  });
  it('is unsure about a page it can tell nothing about, rather than guessing', () => {
    expect(role('https://random.example/', '', null)).toBe('unknown');
    expect(role('https://random.example/', '', EMPTY_HINTS)).toBe('unknown');
  });
  it('is not fooled by a homework page that has a canvas widget (a graph) next to its Check button', () => {
    const graphHw = hints({ canvasShare: 0.4, answerFields: 1, checkButton: true, questionLabels: 1, textLen: 900, problemCues: 6 });
    expect(role('https://www.khanacademy.org/math/graphing', '', graphHw)).toBe('problem');
  });
});

describe('what the student does there', () => {
  it('counts typing or drawing as one indicator', () => {
    expect(role('https://unknown.example/', '', null, TYPING)).toBe('work');
    expect(role('https://unknown.example/', '', null, LOTS)).toBe('work');
  });
  it('never takes a homework site for a work page, however much is typed into it', () => {
    expect(role('https://www.khanacademy.org/math/x', '', homework, LOTS)).not.toBe('work');
  });
  it('is more sure with more indicators agreeing', () => {
    const one = scoreRole('https://unknown.example/', '', null, TYPING).work;
    const two = scoreRole('https://unknown.example/', 'Sketchpad', board, TYPING).work;
    const three = scoreRole('https://sketch.io/sketchpad', 'Sketchpad', board, TYPING).work;
    expect(two).toBeGreaterThan(one);
    expect(three).toBeGreaterThanOrEqual(two);
    expect(three).toBe(1);
  });
  it('explains itself: every indicator that counted is named', () => {
    const s = scoreRole('https://sketch.io/sketchpad', 'Sketchpad', board, TYPING);
    expect(s.workWhy.join(' ')).toMatch(/drawing board/);
    expect(s.workWhy.join(' ')).toMatch(/canvas fills 85%/);
    expect(s.workWhy.join(' ')).toMatch(/drawing tools/);
    expect(s.workWhy.join(' ')).toMatch(/writing or drawing here/);
    const h = scoreRole('https://www.khanacademy.org/x', '', homework, NO_INPUT);
    expect(h.problemWhy.join(' ')).toMatch(/homework site/);
    expect(h.problemWhy.join(' ')).toMatch(/Check/);
  });
});

describe('TabRoles.pickWork', () => {
  const NOW = 1_000_000;
  const problem = 1;
  const tabs = (...t: { tabId: number; url: string; title?: string }[]) => t;

  it('picks a drawing board the student has had on screen, before they draw anything', () => {
    const r = new TabRoles();
    r.recordHints(2, board, NOW - 5_000);
    expect(r.pickWork(tabs({ tabId: 2, url: 'https://sketch.io/sketchpad/', title: 'Sketchpad' }), problem, null, NOW)).toBe(2);
  });

  it('does not pick an old document tab just because it looks like one (it has not been on screen lately, and nothing is typed)', () => {
    const r = new TabRoles();
    r.recordHints(3, doc, NOW - 10 * 60_000);
    expect(r.pickWork(tabs({ tabId: 3, url: 'https://notes.example/p/1' }), problem, null, NOW)).toBeNull();
  });

  it('picks the tab being typed in, on typing alone', () => {
    const r = new TabRoles();
    r.record(4, NOW - 30_000, 0, 0);
    r.record(4, NOW, 20, 0);
    expect(r.pickWork(tabs({ tabId: 4, url: 'https://scratch.example/' }), problem, null, NOW)).toBe(4);
  });

  it('never picks the problem tab, a search or chat tab, or a homework site', () => {
    const r = new TabRoles();
    r.record(1, NOW - 30_000, 0, 0);
    r.record(1, NOW, 99, 0);
    r.record(5, NOW - 30_000, 0, 0);
    r.record(5, NOW, 99, 0);
    r.record(6, NOW - 30_000, 0, 0);
    r.record(6, NOW, 99, 0);
    r.recordHints(6, homework, NOW);
    expect(r.pickWork(tabs({ tabId: 1, url: 'https://www.khanacademy.org/x' }, { tabId: 5, url: 'https://chatgpt.com/c/1' }, { tabId: 6, url: 'https://www.ixl.com/math' }), problem, null, NOW)).toBeNull();
  });

  it('prefers a recognised board to a tab with a little stray typing', () => {
    const r = new TabRoles();
    r.recordHints(2, board, NOW);
    r.record(7, NOW - 30_000, 0, 0);
    r.record(7, NOW, 10, 0);
    expect(r.pickWork(tabs({ tabId: 7, url: 'https://notes.example/x' }, { tabId: 2, url: 'https://sketch.io/sketchpad/', title: 'Sketchpad' }), problem, null, NOW)).toBe(2);
  });

  it('keeps the work tab it has, unless another tab clearly out-works it', () => {
    const r = new TabRoles();
    r.recordHints(2, board, NOW);
    r.record(2, NOW - 30_000, 0, 0);
    r.record(2, NOW, 30, 0);
    r.record(8, NOW - 30_000, 0, 0);
    r.record(8, NOW, 40, 0);
    const both = tabs({ tabId: 2, url: 'https://sketch.io/sketchpad/', title: 'Sketchpad' }, { tabId: 8, url: 'https://scratch.example/' });
    expect(r.pickWork(both, problem, 2, NOW)).toBe(2); // 40 is not twice 30
    r.record(8, NOW + 10, 100, 0);
    expect(r.pickWork(both, problem, 2, NOW + 10)).toBe(2); // sketch.io still scores far higher than a bare typed-in page
  });

  it('says what it believes about a tab, and why, for the panel', () => {
    const r = new TabRoles();
    r.recordHints(2, board, NOW);
    r.record(2, NOW - 30_000, 0, 0);
    r.record(2, NOW, 0, 200);
    const a = r.assess(2, 'https://sketch.io/sketchpad/', 'Sketchpad', NOW);
    expect(a.looksLike).toBe('work');
    expect(a.confidence).toBeGreaterThan(0.9);
    expect(a.why.join(' ')).toMatch(/drawing board/);
  });
});
