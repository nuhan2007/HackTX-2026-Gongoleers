// What myTA asks the model about the student's work (readings, hints, the final check, copy errors, clips), run against an in-memory
// chrome.storage and a scripted Gemini (fetch). The point: whatever the model drafts, the student
// never gets the answer, and images only go out when there is a reason to send them.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LlmCtx } from '../src/ai/llmClient';
import { FALLBACK_CHECK, JUDGE_SYSTEM, SOLVER_SYSTEM, TUTOR_SYSTEM, VIDEO_MOMENT_SYSTEM, VIDEO_PICK_SYSTEM, WORK_SYSTEM } from '../src/ai/prompts';
import { WORK_SCHEMA } from '../src/ai/schemas';
import { normalizeSolution } from '../src/ai/solver';
import { clampSegment, findVideoMoment, parseClock } from '../src/ai/videoTimestamp';
import { playbookFor } from '../src/ai/playbooks';
import { deterministicLeak } from '../src/leak/deterministic';
import { normalizeBox, normalizeReview } from '../src/ai/work';
import type { SolverResult } from '../src/shared/types';

function memoryArea() {
  const data: Record<string, unknown> = {};
  return {
    get: async (keys?: string | string[] | null) => {
      if (keys == null) return { ...data };
      const list = typeof keys === 'string' ? [keys] : keys;
      return Object.fromEntries(list.filter((k) => k in data).map((k) => [k, data[k]]));
    },
    set: async (items: Record<string, unknown>) => void Object.assign(data, JSON.parse(JSON.stringify(items))),
    remove: async (keys: string | string[]) => void [keys].flat().forEach((k) => delete data[k]),
  };
}

const HIDDEN: SolverResult = {
  problemDetected: true,
  problemText: 'Differentiate f(x) = (3x^2 + 1)^5.',
  finalAnswer: '30x(3x^2+1)^4',
  keySteps: ['Outer: u^5 gives 5u^4', 'Inner: 3x^2+1 gives 6x', 'Multiply: 30x(3x^2+1)^4'],
  conceptTags: ['chain rule'],
  misconceptions: ['forgetting the inner derivative'],
  answerKeyPhrases: ['6x', '5(3x^2+1)^4'],
};

type Part = { text: string } | { inlineData: { mimeType: string; data: string } } | { fileData: { fileUri: string } };
type Script = { solver: object[]; work: object[]; tutor: object[]; judge: object[]; pick: object[]; moment: object[] };
let script: Script;
let requests: { system: string; parts: Part[]; config: Record<string, unknown> }[];

function stubGemini() {
  requests = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body);
      const system: string = body.systemInstruction.parts[0].text;
      requests.push({ system, parts: body.contents[0].parts, config: body.generationConfig });
      const queue =
        system === SOLVER_SYSTEM ? script.solver : system === WORK_SYSTEM ? script.work : system === TUTOR_SYSTEM ? script.tutor : system === JUDGE_SYSTEM ? script.judge : system === VIDEO_PICK_SYSTEM ? script.pick : system === VIDEO_MOMENT_SYSTEM ? script.moment : [];
      const next = queue.shift();
      if (!next) throw new Error(`unscripted model call (${system.slice(0, 30)}…)`);
      return new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(next) }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }),
        { status: 200 },
      );
    }),
  );
}

const ctx: LlmCtx = { apiKey: 'k', model: 'gemini-test' };
const review = (o: object) => ({ differentProblem: false, copyState: 'not_copied', status: 'mistake', observation: 'Dropped the inner derivative.', studentMessage: '', box: [], ...o });
const safeJudge = { leaks: false, reason: '' };
const texts = (parts: Part[]) => parts.filter((p): p is Extract<Part, { text: string }> => 'text' in p).map((p) => p.text);
const images = (parts: Part[]) => parts.filter((p): p is Extract<Part, { inlineData: unknown }> => 'inlineData' in p).map((p) => `data:image/jpeg;base64,${p.inlineData.data}`);

let svc: typeof import('../src/background/tutorService');
let store: typeof import('../src/ai/sessionStore');

beforeAll(async () => {
  (globalThis as { chrome?: unknown }).chrome = { storage: { session: memoryArea(), local: memoryArea() } };
  svc = await import('../src/background/tutorService');
  store = await import('../src/ai/sessionStore');
});

async function newSession() {
  return store.createSession({
    triggeredAt: null,
    url: 'https://hw.example/q4',
    hidden: HIDDEN,
    history: [],
    hintLevel: 1,
    concepts: ['chain rule'],
    videos: [],
    hints: 0,
  });
}

const shots = (over: object = {}) => ({ work: 'WORKJPEG', problem: null, problemContext: null, ...over });

beforeEach(() => {
  script = { solver: [], work: [], tutor: [], judge: [], pick: [], moment: [] };
  stubGemini();
});
afterEach(() => vi.unstubAllGlobals());

describe('checkWork', () => {
  it('shows where the work went wrong, with the box, when the message is safe', async () => {
    const s = await newSession();
    script.work.push(review({ studentMessage: 'Your second line is where it slips: what happens to the inside of the parentheses when you differentiate?', box: [300, 100, 420, 700] }));
    script.judge.push(safeJudge);
    const r = await svc.checkWork(ctx, s.id, shots());
    expect(r).toMatchObject({ verdict: 'mistake', fallback: false, box: [300, 100, 420, 700] });
    expect(r.message).toContain('second line');
    // the answer key goes first (a stable prefix Gemini can cache), then the labelled image, then what changes
    const parts = requests[0].parts;
    expect(parts[0]).toHaveProperty('text');
    expect(texts(parts)[0]).toContain('PRIVATE ANSWER KEY');
    expect(images(parts)).toEqual(['data:image/jpeg;base64,WORKJPEG']);
    expect(texts(parts).join('\n')).toContain('FINAL');
    expect((await store.getSession(s.id))!.history.at(-1)!.text).toBe(r.message);
  });

  it('sends the problem tab as a second, labelled image when the work is in another tab', async () => {
    const s = await newSession();
    script.work.push(review({ studentMessage: 'Check the line where you took the outer derivative.', box: [100, 100, 300, 300] }));
    script.judge.push(safeJudge);
    await svc.checkWork(ctx, s.id, shots({ problem: 'PROBLEMJPEG', problemContext: { viewportText: 'Incorrect. Try again.', selection: '', url: 'https://hw.example', title: 'HW' } }));
    const parts = requests[0].parts;
    expect(images(parts)).toEqual(['data:image/jpeg;base64,WORKJPEG', 'data:image/jpeg;base64,PROBLEMJPEG']);
    const t = texts(parts);
    expect(t.some((x) => /IMAGE 1: the WORK tab/.test(x))).toBe(true);
    expect(t.some((x) => /IMAGE 2: the PROBLEM tab/.test(x))).toBe(true);
    expect(t.join('\n')).toContain('Incorrect. Try again.');
  });

  it('regenerates when the first draft states the answer, and never shows the leaky draft', async () => {
    const s = await newSession();
    script.work.push(
      review({ studentMessage: 'You should have gotten 30x(3x^2+1)^4 here.', box: [300, 100, 420, 700] }),
      review({ studentMessage: 'Look at the line where you took the derivative of the outer power. What is missing from it?', box: [300, 100, 420, 700] }),
    );
    script.judge.push(safeJudge);
    const r = await svc.checkWork(ctx, s.id, shots());
    expect(r.fallback).toBe(false);
    expect(r.message).not.toContain('30x');
    expect(requests.filter((q) => q.system === WORK_SYSTEM)).toHaveLength(2);
    expect(texts(requests[1].parts).join('\n')).toContain('REJECTED');
  });

  it('falls back to a generic message (still boxing the spot) when every draft leaks', async () => {
    const s = await newSession();
    const leaky = review({ studentMessage: 'The answer is 30x(3x^2+1)^4.', box: [300, 100, 420, 700] });
    script.work.push(leaky, leaky, leaky);
    const r = await svc.checkWork(ctx, s.id, shots());
    expect(r).toMatchObject({ verdict: 'mistake', fallback: true, box: [300, 100, 420, 700] });
    expect(FALLBACK_CHECK.mistake).toContain(r.message);
  });

  it('fails closed when the judge is unavailable (no unverified message is shown)', async () => {
    const s = await newSession();
    const ok = review({ studentMessage: 'Check the step where you differentiate the inside.', box: [] });
    script.work.push(ok, ok, ok); // judge queue empty → every judge call throws
    const r = await svc.checkWork(ctx, s.id, shots());
    expect(r.fallback).toBe(true);
    expect(FALLBACK_CHECK.mistake).toContain(r.message);
  });

  it('maps statuses to verdicts and drops the box unless it is a mistake', async () => {
    const s = await newSession();
    script.work.push(review({ status: 'solved', studentMessage: 'Nicely done: you kept track of every layer.', box: [100, 100, 300, 300] }));
    script.judge.push(safeJudge);
    expect(await svc.checkWork(ctx, s.id, shots())).toMatchObject({ verdict: 'correct', box: null });

    script.work.push(review({ status: 'on_track', studentMessage: 'So far so good, but you are not finished yet.' }));
    script.judge.push(safeJudge);
    expect((await svc.checkWork(ctx, s.id, shots())).verdict).toBe('incomplete');
  });

  it('surfaces a model failure on the first call instead of inventing a result', async () => {
    const s = await newSession();
    await expect(svc.checkWork(ctx, s.id, shots())).rejects.toThrow();
  });
});

describe('observeWork', () => {
  it('stores private notes without touching the hint history, and passes along why it looked', async () => {
    const s = await newSession();
    script.work.push(review({ status: 'mistake', observation: 'Forgot the 6x factor.' }));
    const w = await svc.observeWork(ctx, s.id, shots(), 'the homework page just said the answer was wrong');
    expect(w.state).toMatchObject({ status: 'possible_mistake', observation: 'Forgot the 6x factor.' });
    expect((await store.getWork(s.id)).status).toBe('possible_mistake');
    expect((await store.getSession(s.id))!.history).toEqual([]);
    expect(texts(requests[0].parts).join('\n')).toContain('the homework page just said the answer was wrong');
    expect(texts(requests[0].parts).join('\n')).toContain('PERIODIC');
  });

  it('flags a screen that moved to another problem', async () => {
    const s = await newSession();
    script.work.push(review({ differentProblem: true, status: 'no_work', observation: '' }));
    const r = await svc.observeWork(ctx, s.id, shots(), 'x');
    expect(r.state.status).toBe('different_problem');
    expect(r.differentProblem).toBe(true);
  });

  it('maps what it found to what the call gate needs to know', () => {
    expect(svc.outcomeOf('possible_mistake')).toBe('mistake');
    expect(svc.outcomeOf('solved')).toBe('solved');
    expect(svc.outcomeOf('on_track')).toBe('on_track');
    expect(svc.outcomeOf('no_work')).toBe('no_work');
    expect(svc.outcomeOf('different_problem')).toBe('different');
    expect(svc.outcomeOf('unknown')).toBe('unclear');
  });
});

describe('flagging a mistake on every reading', () => {
  const where = 'In your second line, the inside of the parentheses seems to be missing a factor. What do you get when you differentiate it?';

  it('comes back with a message and the box, ready for the sprite, when the reading is asked to', async () => {
    const s = await newSession();
    script.work.push(review({ status: 'mistake', readability: 'clear', studentMessage: where, box: [300, 100, 420, 700] }));
    script.judge.push(safeJudge);
    const r = await svc.observeWork(ctx, s.id, shots(), 'you are writing: reading what is new', { wantMessage: true });
    expect(r).toMatchObject({ kind: 'step', message: where, box: [300, 100, 420, 700], copiedWrong: false });
    expect(r.state.status).toBe('possible_mistake');
  });

  it('is only guarded and returned when asked: a reading that nobody will see costs no extra call', async () => {
    const s = await newSession();
    script.work.push(review({ status: 'mistake', studentMessage: where, box: [300, 100, 420, 700] }));
    const r = await svc.observeWork(ctx, s.id, shots(), 'x');
    expect(r.message).toBe('');
    expect(requests.filter((q) => q.system === JUDGE_SYSTEM)).toHaveLength(0);
  });

  it('never lets the answer through: a leaky message is rewritten, and if every draft leaks a generic one is used', async () => {
    const s = await newSession();
    const leaky = review({ status: 'mistake', studentMessage: 'You should have 30x(3x^2+1)^4 there.', box: [300, 100, 420, 700] });
    script.work.push(leaky, leaky, leaky);
    const r = await svc.observeWork(ctx, s.id, shots(), 'x', { wantMessage: true });
    expect(r.message).not.toContain('30x');
    expect(FALLBACK_CHECK.mistake).toContain(r.message);
    expect(r.box).toEqual([300, 100, 420, 700]);
  });

  it('flags the problem having been copied down differently, as its own kind of mistake, with the box on the copy', async () => {
    const s = await newSession();
    const msg = 'The number after the x in your first line doesn\'t match the problem. Look at the problem again: what does it say there?';
    script.work.push(review({ status: 'on_track', copiedWrong: true, copyState: 'complete', readability: 'clear', studentMessage: msg, box: [50, 80, 150, 600] }));
    script.judge.push(safeJudge);
    const r = await svc.observeWork(ctx, s.id, shots(), 'you are writing: reading what is new', { wantMessage: true });
    // the model said "on track", but a wrong copy is a mistake whatever else it says
    expect(r).toMatchObject({ copiedWrong: true, kind: 'copy', message: msg, box: [50, 80, 150, 600] });
    expect(r.state).toMatchObject({ status: 'possible_mistake', copiedWrong: true });
    expect(svc.outcomeOf(r.state.status)).toBe('mistake');
  });

  it('uses a copy-specific generic message when a copy-error draft leaks', async () => {
    const s = await newSession();
    const leaky = review({ status: 'mistake', copiedWrong: true, copyState: 'complete', studentMessage: 'It should say 30x(3x^2+1)^4.', box: [50, 80, 150, 600] });
    script.work.push(leaky, leaky, leaky);
    const r = await svc.observeWork(ctx, s.id, shots(), 'x', { wantMessage: true });
    expect(FALLBACK_CHECK.copy).toContain(r.message);
  });

  it('writes a congratulation (checked, and never the answer) when the work is solved', async () => {
    const s = await newSession();
    script.work.push(review({ status: 'solved', readability: 'clear', studentMessage: 'Lovely: you kept track of every layer.', box: [] }));
    script.judge.push(safeJudge);
    const r = await svc.observeWork(ctx, s.id, shots(), 'x', { wantMessage: true });
    expect(r.state.status).toBe('solved');
    expect(r.message).toBe('Lovely: you kept track of every layer.');
    expect(r.box).toBeNull();
  });

  it('says nothing for work that is merely on track', async () => {
    const s = await newSession();
    script.work.push(review({ status: 'on_track', studentMessage: 'Good so far.' }));
    const r = await svc.observeWork(ctx, s.id, shots(), 'x', { wantMessage: true });
    expect(r.message).toBe('');
    expect(requests.filter((q) => q.system === JUDGE_SYSTEM)).toHaveLength(0);
  });

  it('asks the model, in every mode, for the copy check and a message for a mistake', () => {
    expect(WORK_SYSTEM).toMatch(/copiedWrong/);
    expect(WORK_SYSTEM).toMatch(/in BOTH modes/);
    expect(WORK_SYSTEM).toMatch(/do not call those later steps mistakes/);
  });
});

describe('what the hint writer is shown', () => {
  const hintOf = (message: string, hintLevel = 2) => ({ replyAssessment: 'none', hintLevel, message, missingPrerequisite: '' });

  it('gets the changed screens and the private notes, and still guards the hint', async () => {
    const s = await newSession();
    await store.saveWork(s.id, { status: 'possible_mistake', observation: 'Forgot the 6x factor.', reviewedAt: Date.now() });
    script.tutor.push(hintOf('Look again at your second line. What is the derivative of the inside?'));
    script.judge.push(safeJudge);
    const r = await svc.proactiveHint(ctx, s.id, { work: 'LIVEJPEG', problem: 'PROBLEMJPEG' }, 'their confusion score has stayed high');
    expect(r.message).toContain('second line');

    const draft = requests.find((q) => q.system === TUTOR_SYSTEM)!;
    expect(images(draft.parts)).toEqual(['data:image/jpeg;base64,LIVEJPEG', 'data:image/jpeg;base64,PROBLEMJPEG']);
    const t = texts(draft.parts);
    expect(t[0]).toContain('PRIVATE ANSWER KEY'); // stable prefix first
    expect(t.some((x) => /tab where the student writes their work/.test(x))).toBe(true);
    expect(t.some((x) => /problem tab/.test(x))).toBe(true);
    const joined = t.join('\n');
    expect(joined).toContain('LATEST LOOK AT THE STUDENT');
    expect(joined).toContain('possible mistake');
    expect(joined).toContain('Forgot the 6x factor.');
  });

  it('is told how old the private notes are and to trust the newer screenshot over them', async () => {
    const s = await newSession();
    await store.saveWork(s.id, { status: 'no_work', observation: 'The sketchpad is blank.', reviewedAt: Date.now() - 125_000 });
    script.tutor.push(hintOf('What have you written so far?', 1));
    script.judge.push(safeJudge);
    await svc.proactiveHint(ctx, s.id, { work: 'SKETCHJPEG', problem: null }, '');
    const prompt = texts(requests.find((q) => q.system === TUTOR_SYSTEM)!.parts).join('\n');
    expect(prompt).toContain('The sketchpad is blank.');
    expect(prompt).toMatch(/from 2 min ago/);
    expect(prompt).toMatch(/trust the screenshot over them/);
  });

  it('sends no image at all when nothing changed on screen', async () => {
    const s = await newSession();
    script.tutor.push(hintOf('What does the problem ask you to find?', 1));
    script.judge.push(safeJudge);
    await svc.proactiveHint(ctx, s.id, {}, '');
    expect(images(requests.find((q) => q.system === TUTOR_SYSTEM)!.parts)).toEqual([]);
  });

  it('can attach only the problem tab (its feedback changed, the work did not)', async () => {
    const s = await newSession();
    script.tutor.push(hintOf('What did the page say about your answer?', 1));
    script.judge.push(safeJudge);
    await svc.proactiveHint(ctx, s.id, { work: null, problem: 'PROBLEMONLY' }, '');
    const draft = requests.find((q) => q.system === TUTOR_SYSTEM)!;
    expect(images(draft.parts)).toEqual(['data:image/jpeg;base64,PROBLEMONLY']);
    expect(texts(draft.parts).some((x) => /Screenshot of the problem tab/.test(x))).toBe(true);
  });

  it('tells it never to open with a stock phrase like "looks tricky", so the hints do not all sound alike', () => {
    expect(TUTOR_SYSTEM).toMatch(/never use stock openers such as "This looks tricky"/);
  });
});

describe('starting a session', () => {
  const context = { selection: '', viewportText: 'Q4 Find the derivative…', url: 'https://hw.example/practice?set=3#q4', title: 'HW', question: 'Q4' };

  it('solves a numbered question once, however many times it is started on it', async () => {
    script.solver.push({ ...HIDDEN });
    const a = await svc.startSession(ctx, 'JPEG', context, null);
    const b = await svc.startSession(ctx, 'JPEG', { ...context, url: 'https://hw.example/practice?set=3#top' }, null); // same page, different hash
    expect(a.problemDetected && b.problemDetected).toBe(true);
    expect(requests.filter((q) => q.system === SOLVER_SYSTEM)).toHaveLength(1);
  });

  it('does not reuse an answer for a different question or a page that names no question', async () => {
    script.solver.push({ ...HIDDEN }, { ...HIDDEN }, { ...HIDDEN });
    await svc.startSession(ctx, 'JPEG', { ...context, url: 'https://hw.example/other', question: 'Q5' }, null);
    await svc.startSession(ctx, 'JPEG', { ...context, url: 'https://hw.example/other', question: 'Q6' }, null);
    await svc.startSession(ctx, 'JPEG', { ...context, url: 'https://hw.example/other', question: 'Calculus homework' }, null);
    expect(requests.filter((q) => q.system === SOLVER_SYSTEM)).toHaveLength(3);
  });

  it('keys the cache on the question, not on a page that names none', () => {
    expect(svc.solveKey(context)).toBe('https://hw.example/practice?set=3|Q4');
    expect(svc.solveKey({ ...context, question: 'Homework 3.4' })).toBeNull();
    expect(svc.solveKey({ ...context, question: undefined })).toBeNull();
    expect(svc.solveKey(null)).toBeNull();
  });

  it('puts the image first and asks for a hard think on the one call that makes the answer key', async () => {
    script.solver.push({ ...HIDDEN });
    await svc.startSession(ctx, 'PROBLEMJPEG', { ...context, url: 'https://hw.example/unique', question: 'Q9' }, null);
    const solver = requests.find((q) => q.system === SOLVER_SYSTEM)!;
    expect(images(solver.parts)).toEqual(['data:image/jpeg;base64,PROBLEMJPEG']);
    expect(texts(solver.parts).join('\n')).toContain('Question the student is working on: Q9');
  });

  it('reports a page with no problem on it', async () => {
    script.solver.push({ ...HIDDEN, problemDetected: false });
    const r = await svc.startSession(ctx, 'JPEG', null, null);
    expect(r.problemDetected).toBe(false);
    expect(r.sessionId).toBe('');
  });
});

describe('the sprite reads the work and writes the hint itself', () => {
  const hint = (message: string, hintLevel = 1) => ({ replyAssessment: 'none', hintLevel, message, missingPrerequisite: '' });

  it('sends the work screenshot and what myTA noticed, and says the student did not ask', async () => {
    const s = await newSession();
    script.tutor.push(hint('Look again at your second line. What happens to the inside of the parentheses?'));
    script.judge.push(safeJudge);
    const h = await svc.proactiveHint(ctx, s.id, { work: 'WORKJPEG', problem: null }, 'the confusion signals were: 2 incorrect submissions on Q4');
    expect(h).toMatchObject({ fallback: false, hintLevel: 1 });
    expect(h.message).toContain('second line');
    const req = requests.find((q) => q.system === TUTOR_SYSTEM)!;
    expect(images(req.parts)).toEqual(['data:image/jpeg;base64,WORKJPEG']);
    const t = texts(req.parts).join('\n');
    expect(t).toContain('did NOT ask for help');
    expect(t).toContain('Hints already shown to the student:\n(none yet)');
    expect(t).toContain('What myTA noticed: the confusion signals were: 2 incorrect submissions on Q4');
    expect(t).toContain('at most two short sentences');
  });

  it('never shows the answer: a hint that gives it away is replaced', async () => {
    const s = await newSession();
    script.tutor.push(hint('Try 30x(3x^2+1)^4.'), hint('Still 30x(3x^2+1)^4.'), hint('It equals 30x(3x^2+1)^4.'));
    script.judge.push(safeJudge, safeJudge, safeJudge);
    const h = await svc.proactiveHint(ctx, s.id, { work: 'WORKJPEG' }, '');
    expect(h.fallback).toBe(true);
    expect(h.message).not.toContain('30x');
  });

  it('goes a level deeper when a second hint follows soon after the first, or when asked for another', async () => {
    const s = await newSession();
    script.tutor.push(hint('Which two layers does this function have?', 1), hint('Name the rule for a function inside a function.', 2), hint('Differentiate the outside, then multiply by the derivative of the inside.', 3));
    script.judge.push(safeJudge, safeJudge, safeJudge);
    await svc.proactiveHint(ctx, s.id, { work: 'W' }, '');
    expect(texts(requests.filter((q) => q.system === TUTOR_SYSTEM)[0].parts).join('\n')).toContain('Minimum hint level for this turn: 1');
    await svc.proactiveHint(ctx, s.id, { work: 'W' }, ''); // soon after
    expect(texts(requests.filter((q) => q.system === TUTOR_SYSTEM)[1].parts).join('\n')).toContain('Minimum hint level for this turn: 2');
    await svc.proactiveHint(ctx, s.id, { work: 'W' }, '', true); // "Another hint"
    expect(texts(requests.filter((q) => q.system === TUTOR_SYSTEM)[2].parts).join('\n')).toContain('Minimum hint level for this turn: 3');
    expect((await store.getSession(s.id))!.hintLevel).toBe(3);
  });

  it('remembers each hint, so the next one does not repeat it', async () => {
    const s = await newSession();
    script.tutor.push(hint('Look again at your second line.'), hint('Think about what the inside contributes.', 2));
    script.judge.push(safeJudge, safeJudge);
    await svc.proactiveHint(ctx, s.id, { work: 'W' }, '');
    expect((await store.getSession(s.id))!.history.map((m) => m.text)).toEqual(['Look again at your second line.']);
    expect((await store.getSession(s.id))!.hints).toBe(1);
    await svc.proactiveHint(ctx, s.id, { work: 'W' }, '', true);
    const second = texts(requests.filter((q) => q.system === TUTOR_SYSTEM)[1].parts).join('\n');
    expect(second).toContain('1. Look again at your second line.');
    expect(second).toContain('pressed "Another hint"');
    expect((await store.getSession(s.id))!.hints).toBe(2);
  });

  it('hands back the missing prerequisite the hint noticed, so the sprite can offer a clip on it', async () => {
    const s = await newSession();
    script.tutor.push({ replyAssessment: 'none', hintLevel: 2, message: 'Which rule handles a function inside another?', missingPrerequisite: 'composite functions' });
    script.judge.push(safeJudge);
    const h = await svc.proactiveHint(ctx, s.id, { work: 'W' }, '');
    expect(h.missingPrerequisite).toBe('composite functions');
    expect((await store.getSession(s.id))!.concepts).toContain('composite functions');
  });

  it('keeps what another writer saved while the model was thinking', async () => {
    const s = await newSession();
    script.tutor.push(hint('Look again at your second line.'));
    script.judge.push(safeJudge);
    const slow = svc.proactiveHint(ctx, s.id, { work: 'W' }, '');
    const other = await store.getSession(s.id);
    other!.history.push({ role: 'tutor', text: '[Suggested video on chain rule: Chain rule intro]', t: Date.now() });
    await store.saveSession(other!);
    await slow;
    expect((await store.getSession(s.id))!.history.map((m) => m.text)).toContain('[Suggested video on chain rule: Chain rule intro]');
  });

  it('is told, in the prompt, that the answer must never come out and the hint must be short', () => {
    expect(TUTOR_SYSTEM).toMatch(/Never state the final answer/);
  });
});

describe('how hard a problem is', () => {
  it('is rated 1 to 5 by the private solution, and defaults to a standard problem if the model leaves it out', async () => {
    script.solver.push({ ...HIDDEN, difficulty: 4 }, { ...HIDDEN, difficulty: 11 }, { ...HIDDEN });
    const ctxQ = (q: string) => ({ selection: '', viewportText: 'Q find', url: `https://hw.example/diff-${q}`, title: 'HW', question: q });
    expect((await svc.startSession(ctx, 'J', ctxQ('Q21'), null)).difficulty).toBe(4);
    expect((await svc.startSession(ctx, 'J', ctxQ('Q22'), null)).difficulty).toBe(5); // clamped
    expect((await svc.startSession(ctx, 'J', ctxQ('Q23'), null)).difficulty).toBe(3); // left out
  });

  it('is asked for in the solver prompt', () => {
    expect(SOLVER_SYSTEM).toMatch(/difficulty: an integer 1-5/);
  });
});

describe('following a problem quietly', () => {
  const context = { selection: '', viewportText: 'Q11 Find the derivative…', url: 'https://hw.example/quiet', title: 'HW', question: 'Q11' };

  it('costs one model call to start: the problem is worked out, nothing is said to the student', async () => {
    script.solver.push({ ...HIDDEN });
    const r = await svc.startSession(ctx, 'JPEG', context, null);
    expect(r).toMatchObject({ problemDetected: true, message: '' });
    expect(requests).toHaveLength(1); // no opening, no leak judge
    const s = (await store.getSession(r.sessionId))!;
    expect(s.history).toEqual([]);
    expect(s.hidden.finalAnswer).toBe(HIDDEN.finalAnswer);
  });

  it('is dropped without a trace when it never needed a hint', async () => {
    script.solver.push({ ...HIDDEN });
    const r = await svc.startSession(ctx, 'JPEG', { ...context, question: 'Q14' }, null);
    expect(await svc.worthSummary(r.sessionId)).toBe(false);
    await svc.discardSession(r.sessionId);
    expect(await store.getSession(r.sessionId)).toBeNull();
  });

  it('is worth a line in the stats once a hint has been shown', async () => {
    const s = await newSession();
    script.tutor.push({ replyAssessment: 'none', hintLevel: 1, message: 'Which layers does it have?', missingPrerequisite: '' });
    script.judge.push(safeJudge);
    await svc.proactiveHint(ctx, s.id, { work: 'W' }, '');
    expect(await svc.worthSummary(s.id)).toBe(true);
    const summary = await svc.endSession(s.id, true);
    expect(summary).toMatchObject({ solved: true, turns: 1 });
    expect(summary!.timeToUnstuckSec).not.toBeNull();
    expect(await store.getSession(s.id)).toBeNull();
  });

  it('says why it is checking, so the model knows the student has stopped rather than clicked "move on"', async () => {
    const s = await newSession();
    script.work.push(review({ status: 'solved', studentMessage: 'Nice work: you kept track of the inside layer.' }));
    script.judge.push(safeJudge);
    await svc.checkWork(ctx, s.id, shots(), 'the student stopped working (no new work for 11s and the confusion score is low (20)), so they are probably finished');
    const t = texts(requests.find((q) => q.system === WORK_SYSTEM)!.parts).join('\n');
    expect(t).toContain('Why you are being asked now: the student stopped working');
    expect(t).toContain('FINAL');
  });

  it('maps a final check onto what the call gate needs to know', () => {
    expect(svc.outcomeOfVerdict('mistake')).toBe('mistake');
    expect(svc.outcomeOfVerdict('correct')).toBe('solved');
    expect(svc.outcomeOfVerdict('incomplete')).toBe('on_track');
    expect(svc.outcomeOfVerdict('unclear')).toBe('unclear');
  });
});

describe('what the model read from the student\'s work (so they can see whether it can read it)', () => {
  it('keeps a short transcription of their own writing, and how readable it was', async () => {
    const s = await newSession();
    script.work.push(review({ status: 'on_track', workRead: '  f(x) = (3x^2+1)^5  /  u = 3x^2+1  ', readability: 'clear' }));
    const w = (await svc.observeWork(ctx, s.id, shots(), 'a pause after writing a chunk')).state;
    expect(w).toMatchObject({ read: 'f(x) = (3x^2+1)^5 / u = 3x^2+1', readability: 'clear' });
    expect((await store.getWork(s.id)).readability).toBe('clear');
  });

  it('does not echo it back when it contains the answer key (the student, or the model, wrote the answer)', async () => {
    const s = await newSession();
    script.work.push(review({ status: 'solved', workRead: 'f\'(x) = 30x(3x^2+1)^4', readability: 'clear' }));
    const w = (await svc.observeWork(ctx, s.id, shots(), 'a pause after writing a chunk')).state;
    expect(w.read).toBe('');
    expect(w.readability).toBe('clear'); // it could read it; the panel just doesn't repeat it
  });

  it('is saved and returned by a final check too', async () => {
    const s = await newSession();
    script.work.push(review({ status: 'on_track', studentMessage: 'Good so far.', workRead: 'f(x) = (3x^2+1)^5', readability: 'hard_to_read' }));
    script.judge.push(safeJudge);
    const r = await svc.checkWork(ctx, s.id, shots());
    expect(r).toMatchObject({ read: 'f(x) = (3x^2+1)^5', readability: 'hard_to_read' });
    expect(await store.getWork(s.id)).toMatchObject({ read: 'f(x) = (3x^2+1)^5', readability: 'hard_to_read' });
  });

  it('asks the model for it, and tells it never to correct or complete what is written', () => {
    expect(WORK_SYSTEM).toMatch(/workRead/);
    expect(WORK_SYSTEM).toMatch(/Never correct, finish or improve it/);
  });

  describe('normalization', () => {
    it('collapses whitespace and caps the length', () => {
      const r = normalizeReview({ status: 'on_track', workRead: `x   =\n 1 ${'y'.repeat(400)}`, readability: 'clear' });
      expect(r.workRead.startsWith('x = 1 yyyy')).toBe(true);
      expect(r.workRead.length).toBe(240);
    });
    it('keeps the two fields consistent: no text cannot be "clear", and text cannot be "nothing written"', () => {
      expect(normalizeReview({ status: 'no_work', workRead: '', readability: 'clear' }).readability).toBe('nothing_written');
      expect(normalizeReview({ status: 'on_track', workRead: 'x = 1', readability: 'nothing_written' }).readability).toBe('hard_to_read');
      expect(normalizeReview({ status: 'on_track', workRead: '', readability: 'hard_to_read' }).readability).toBe('hard_to_read');
    });
    it('infers it when an older reply has neither field', () => {
      expect(normalizeReview({ status: 'on_track', workRead: 'x = 1' })).toMatchObject({ readability: 'clear', workRead: 'x = 1' });
      expect(normalizeReview({ status: 'no_work' })).toMatchObject({ readability: 'nothing_written', workRead: '' });
    });
  });
});

describe('review normalization', () => {
  it('accepts a sane box and clamps to 0..1000', () => {
    expect(normalizeBox([100, 200, 300, 400])).toEqual([100, 200, 300, 400]);
    expect(normalizeBox([-20, 0, 300, 1200])).toEqual([0, 0, 300, 1000]);
  });
  it('rejects malformed, tiny and whole-screen boxes', () => {
    for (const bad of [[], [1, 2, 3], ['a', 1, 2, 3], [100, 100, 102, 102], [0, 0, 1000, 1000], 'nope']) expect(normalizeBox(bad)).toBeNull();
  });
  it('keeps the box only for mistakes on the same problem', () => {
    const base = { observation: ' step 2 ', studentMessage: ' Look at line 2. ', box: [100, 100, 300, 300] };
    expect(normalizeReview({ ...base, status: 'mistake' })).toMatchObject({ status: 'mistake', box: [100, 100, 300, 300], observation: 'step 2' });
    expect(normalizeReview({ ...base, status: 'on_track' }).box).toBeNull();
    expect(normalizeReview({ ...base, status: 'mistake', differentProblem: true })).toMatchObject({ status: 'unclear', differentProblem: true, box: null });
  });
  it('treats a wrongly copied problem as a mistake, with the box, whatever status the model gave', () => {
    const base = { observation: 'copied 5 as 6', studentMessage: 'Compare your first line with the problem.', box: [100, 100, 300, 300], copiedWrong: true, copyState: 'complete' };
    expect(normalizeReview({ ...base, status: 'on_track' })).toMatchObject({ status: 'mistake', copiedWrong: true, box: [100, 100, 300, 300] });
    expect(normalizeReview({ ...base, status: 'no_work' }).status).toBe('mistake');
    expect(normalizeReview({ ...base, status: 'mistake', differentProblem: true })).toMatchObject({ status: 'unclear', copiedWrong: false, box: null });
    expect(normalizeReview({ status: 'on_track' }).copiedWrong).toBe(false);
  });
  it('falls back to unclear on an unknown status', () => {
    expect(normalizeReview({ status: 'banana' }).status).toBe('unclear');
  });
});


describe('a copy of the problem that is still being written is never called wrong', () => {
  const msg = 'The number after the x in your first line doesn\'t match the problem. Look at the problem again: what does it say there?';

  it('is not wrong while the model says the copy is in progress, whatever else it said', () => {
    const base = { observation: 'copied 5 as 6', studentMessage: msg, box: [100, 100, 300, 300], copiedWrong: true };
    for (const copyState of ['in_progress', 'not_copied', undefined, 'banana']) {
      expect(normalizeReview({ ...base, copyState, status: 'mistake' })).toMatchObject({ copiedWrong: false, status: 'on_track', box: null });
      expect(normalizeReview({ ...base, copyState, status: 'on_track' })).toMatchObject({ copiedWrong: false, status: 'on_track' });
    }
    expect(normalizeReview({ ...base, copyState: 'complete', status: 'on_track' })).toMatchObject({ copiedWrong: true, status: 'mistake', copyState: 'complete', box: [100, 100, 300, 300] });
  });

  it('keeps a real step mistake that has nothing to do with the copy', () => {
    expect(normalizeReview({ status: 'mistake', copiedWrong: false, copyState: 'in_progress', box: [100, 100, 300, 300] })).toMatchObject({ status: 'mistake', copiedWrong: false, box: [100, 100, 300, 300] });
  });

  it('is asked in the order that makes the model decide whether the copy is finished BEFORE it says it is wrong', () => {
    const keys = Object.keys(WORK_SCHEMA.properties);
    expect(keys.indexOf('workRead')).toBeLessThan(keys.indexOf('copyState'));
    expect(keys.indexOf('copyState')).toBeLessThan(keys.indexOf('copiedWrong'));
    expect(keys.indexOf('copiedWrong')).toBeLessThan(keys.indexOf('status'));
    expect(keys.indexOf('observation')).toBeLessThan(keys.indexOf('status'));
    expect(keys[keys.length - 1]).toBe('studentMessage'); // the words come last, after the reasoning
  });

  it('tells the model a half-written copy always differs, and that it is "in_progress"', () => {
    expect(WORK_SYSTEM).toMatch(/half-written copy ALWAYS differs/);
    expect(WORK_SYSTEM).toMatch(/copiedWrong is false/);
  });

  it('writes no message for a copy that will not be flagged by this reading (no extra guard call)', async () => {
    const s = await newSession();
    script.work.push(review({ status: 'on_track', copiedWrong: true, copyState: 'complete', readability: 'clear', studentMessage: msg, box: [50, 80, 150, 600] }));
    const r = await svc.observeWork(ctx, s.id, shots(), 'you finished a line: reading it', { wantMessage: true, copyReady: false, idleMs: 1200 });
    expect(r).toMatchObject({ copiedWrong: true, copyState: 'complete', message: '' });
    expect(requests.filter((q) => q.system === JUDGE_SYSTEM)).toHaveLength(0);
  });

  it('writes the message once this reading is the one that flags it', async () => {
    const s = await newSession();
    script.work.push(review({ status: 'on_track', copiedWrong: true, copyState: 'complete', readability: 'clear', studentMessage: msg, box: [50, 80, 150, 600] }));
    script.judge.push(safeJudge);
    const r = await svc.observeWork(ctx, s.id, shots(), 'x', { wantMessage: true, copyReady: true, idleMs: 3000 });
    expect(r).toMatchObject({ copiedWrong: true, kind: 'copy', message: msg });
  });

  it('a step mistake always gets its message, whether or not a copy would have been ready', async () => {
    const s = await newSession();
    script.work.push(review({ status: 'mistake', readability: 'clear', studentMessage: 'In your second line, what happened to the inside?', box: [300, 100, 420, 700] }));
    script.judge.push(safeJudge);
    const r = await svc.observeWork(ctx, s.id, shots(), 'x', { wantMessage: true, copyReady: false });
    expect(r.message).toContain('second line');
  });

  it('tells the model how long the student had been still, so it knows whether a line was just finished', async () => {
    const s = await newSession();
    script.work.push(review({ status: 'on_track' }));
    await svc.observeWork(ctx, s.id, shots(), 'you finished a line: reading it', { idleMs: 1300 });
    const t = texts(requests.find((q) => q.system === WORK_SYSTEM)!.parts).join('\n');
    expect(t).toContain('stopped writing 1 s before this snapshot');
    expect(t).toContain('Do not call a copy of the problem wrong unless it is complete');
    script.work.push(review({ status: 'on_track' }));
    await svc.observeWork(ctx, s.id, shots(), 'you are writing: reading what is new', { idleMs: 0 });
    expect(texts(requests.filter((q) => q.system === WORK_SYSTEM)[1].parts).join('\n')).toContain('the last line may be unfinished');
  });

  it('reports the first finding to the sprite BEFORE the message has been through the leak guard', async () => {
    const s = await newSession();
    script.work.push(review({ status: 'mistake', readability: 'clear', studentMessage: 'Look at the line where you took the outer derivative.', box: [300, 100, 420, 700] }));
    script.judge.push(safeJudge);
    const early: { judgeCallsSoFar: number; status: string; box: unknown }[] = [];
    const r = await svc.observeWork(ctx, s.id, shots(), 'you finished a line: reading it', {
      wantMessage: true,
      onEarly: (e) => early.push({ judgeCallsSoFar: requests.filter((q) => q.system === JUDGE_SYSTEM).length, status: e.status, box: e.box }),
    });
    expect(early).toEqual([{ judgeCallsSoFar: 0, status: 'possible_mistake', box: [300, 100, 420, 700] }]);
    expect(r.message).toContain('outer derivative');
  });
});

describe('hard problems: circuits', () => {
  const CIRCUIT: SolverResult = {
    problemDetected: true,
    problemText: 'Use node-voltage analysis to find V1 and V2 in the circuit shown.',
    givens: 'R1 = 2 kOhm between node 1 and node 2; R2 = 4 kOhm from node 2 to ground; 12 V source, + at node 1; R3 = 6 kOhm from node 1 to ground.',
    finalAnswer: 'V1 = 12 V, V2 = 7.5 V',
    keySteps: ['Pick ground', 'KCL at node 2', 'Solve'],
    checkpoints: [
      { label: 'KCL at node 2', expected: '(V2 - V1)/2k + V2/4k = 0' },
      { label: 'node 2 voltage', expected: 'V2 = 7.5 V' },
    ],
    conceptTags: ['node voltage analysis', "Kirchhoff's current law"],
    misconceptions: ['sign of the current from the resistor'],
    answerKeyPhrases: [],
    domain: 'circuits',
    problemKind: 'node voltage analysis',
    workFormat: 'mixed',
    difficulty: 4,
    expectedMinutes: 12,
    keyConfidence: 'medium',
  };

  it('reads what the solver says about the problem into traits, and keeps everything it says private', async () => {
    script.solver.push({ ...CIRCUIT, verification: 'substituted back', keyConfidence: 'medium' });
    const r = await svc.startSession(ctx, 'J', { selection: '', viewportText: 'Q3 circuit', url: 'https://hw.example/c1', title: 'HW', question: 'Q3' }, null);
    expect(r.traits).toEqual({ difficulty: 4, domain: 'circuits', workFormat: 'mixed', expectedMinutes: 12, problemKind: 'node voltage analysis' });
    expect(JSON.stringify(r)).not.toContain('7.5');
  });

  it('asks the solver to read the figure, check its answer, and say how sure it is', () => {
    expect(SOLVER_SYSTEM).toMatch(/node-voltage/);
    expect(SOLVER_SYSTEM).toMatch(/FIGURE/);
    expect(SOLVER_SYSTEM).toMatch(/CHECK your answer/);
    expect(SOLVER_SYSTEM).toMatch(/keyConfidence/);
    expect(SOLVER_SYSTEM).toMatch(/checkpoints/);
  });

  it('tidies a sloppy solution: unknown names and out-of-range numbers get safe values', () => {
    const r = normalizeSolution({ problemDetected: true, domain: 'banana', workFormat: 'interpretive dance', keyConfidence: 'sure', expectedMinutes: -4, difficulty: 99, checkpoints: [{ label: 'x', expected: '' }, { label: 'ok', expected: '3' }, 'junk'] } as never);
    expect(r).toMatchObject({ domain: 'other', workFormat: 'equations', keyConfidence: 'high', difficulty: 5, expectedMinutes: undefined });
    expect(r.checkpoints).toEqual([{ label: 'ok', expected: '3' }]);
    expect(normalizeSolution({ expectedMinutes: 9999 } as never).expectedMinutes).toBe(180);
  });

  it('gives every reading of the work the circuit playbook, the givens, the milestones and how sure the key is', async () => {
    const s = await store.createSession({ triggeredAt: null, url: 'https://hw.example/c', hidden: CIRCUIT, history: [], hintLevel: 1, concepts: [], videos: [], hints: 0 });
    script.work.push(review({ status: 'on_track' }));
    await svc.observeWork(ctx, s.id, shots(), 'x');
    const t = texts(requests.find((q) => q.system === WORK_SYSTEM)!.parts)[0];
    expect(t).toContain('Kind of problem: node voltage analysis (circuits)');
    expect(t).toContain('Given in the figure/table: R1 = 2 kOhm');
    expect(t).toContain('Milestones:');
    expect(t).toContain('How sure this key is: medium');
    expect(t).toContain('supernode');
    expect(t).toContain('reference (ground) node');
  });

  it('picks a playbook by the method even when the solver labelled the domain something else', () => {
    expect(playbookFor('physics', 'node voltage analysis')).toContain('supernode');
    expect(playbookFor('other', undefined, ["Kirchhoff's current law"])).toContain('supernode');
    expect(playbookFor('calculus', 'chain rule')).toContain('chain-rule');
    expect(playbookFor('other')).toBe('');
    expect(playbookFor(undefined)).toBe('');
  });

  it("judges a student's different but valid method on its merits, and does not cry mistake when the key itself is unsure", () => {
    expect(WORK_SYSTEM).toMatch(/method may differ from the key's/);
    expect(WORK_SYSTEM).toMatch(/not by whether it matches the key's steps/);
    expect(WORK_SYSTEM).toMatch(/When it is "low"/);
    expect(WORK_SYSTEM).toMatch(/recomputing it from the step before/);
  });

  it('a hint about a circuit may not give away a node voltage, even one only reached on the way', () => {
    // 7.5 is a milestone value: leaking it is leaking a step.
    expect(deterministicLeak('Your V2 should come out to 7.5 volts, so check the sign.', CIRCUIT).leaks).toBe(true);
    // Numbers from the figure, node numbers and component names are fine.
    expect(deterministicLeak('Look at the KCL equation for node 2: which way does the current through the 2 kOhm resistor point?', CIRCUIT).leaks).toBe(false);
    expect(deterministicLeak('The 12 V source fixes node 1, so what does that tell you about the other equation?', CIRCUIT).leaks).toBe(false);
  });

  it('an answer that gives several values (V1 = 6 V, V2 = 12 V) protects every one of them', () => {
    const two: SolverResult = { ...CIRCUIT, givens: 'Vs = 5 V; R1 = 1 kOhm; R2 = 2 kOhm; R3 = 3 kOhm; R4 = 3 kOhm; a 7 mA source.', finalAnswer: 'V1 = 6 V, V2 = 12 V', checkpoints: [] };
    expect(deterministicLeak('So V2 should be 12 volts. Check your signs.', two).leaks).toBe(true);
    expect(deterministicLeak("Your V1 comes out as 6 V, does it not?", two).leaks).toBe(true);
    // what the problem itself gives, and the names of nodes and parts, are fine
    expect(deterministicLeak('Look at the equation for node 2: which way does the current through the 3 kOhm resistor go?', two).leaks).toBe(false);
    expect(deterministicLeak('The 7 mA source adds a term to node 2. Did you include it?', two).leaks).toBe(false);
  });

  it('the hint writer is shown the answer key with the circuit details', async () => {
    const s = await store.createSession({ triggeredAt: null, url: 'https://hw.example/c', hidden: CIRCUIT, history: [], hintLevel: 1, concepts: [], videos: [], hints: 0 });
    script.tutor.push({ replyAssessment: 'none', hintLevel: 1, message: 'Which node would you pick as the reference, and why?', missingPrerequisite: '' });
    script.judge.push(safeJudge);
    await svc.proactiveHint(ctx, s.id, { work: 'W' }, '');
    expect(texts(requests.find((q) => q.system === TUTOR_SYSTEM)!.parts)[0]).toContain('node voltage analysis');
  });
});

describe('a short clip, and the minute to start it at', () => {
  const cand = (over: object = {}) => ({ videoId: 'abcdefghijk', title: 'Node voltage analysis, explained', channel: 'Neso Academy', lengthSec: 600, description: 'Learn it.', chapters: [] as { title: string; startSec: number }[], ...over });

  it('reads clock times the way the model writes them', () => {
    expect(parseClock('2:14')).toBe(134);
    expect(parseClock('02:14')).toBe(134);
    expect(parseClock('1:02:03')).toBe(3723);
    expect(parseClock('134')).toBe(134);
    expect(parseClock('2m14s')).toBe(134);
    expect(parseClock('134s')).toBe(134);
    expect(parseClock(95)).toBe(95);
    expect(parseClock('soon')).toBeNaN();
    expect(parseClock('')).toBeNaN();
    expect(parseClock(undefined)).toBeNaN();
  });

  it('keeps the segment inside the video and a sensible length', () => {
    expect(clampSegment({ lengthSec: 600 }, 590, 700)).toEqual({ start: 570, end: 600 });
    expect(clampSegment({ lengthSec: 600 }, 100, 105)).toEqual({ start: 100, end: 280 });
    expect(clampSegment({ lengthSec: 0 }, 10, 5000)).toEqual({ start: 10, end: 610 });
  });

  it("uses the video's own chapter when the pick lands on one (no need to watch the video)", async () => {
    script.pick.push({ index: 0, startSec: 90, endSec: 240, why: 'how KCL is written at a node' });
    const m = await findVideoMoment(ctx, [cand({ chapters: [{ title: 'Intro', startSec: 0 }, { title: 'KCL at a node', startSec: 90 }] })], 'node voltage analysis');
    expect(m).toMatchObject({ videoId: 'abcdefghijk', start: 90, end: 240, source: 'chapters', why: 'how KCL is written at a node', lengthSec: 600 });
    expect(requests.some((q) => q.system === VIDEO_MOMENT_SYSTEM)).toBe(false);
  });

  it('WATCHES a video that has no chapters (Gemini takes the YouTube address) and uses the minute it reports', async () => {
    script.pick.push({ index: 0, startSec: 0, endSec: 300, why: 'an intro' });
    script.moment.push({ explainsIt: true, start: '2:14', end: '4:05', why: 'how KCL is written at each node' });
    const m = await findVideoMoment(ctx, [cand()], 'node voltage analysis');
    expect(m).toMatchObject({ start: 134, end: 245, source: 'video', why: 'how KCL is written at each node' });
    const watch = requests.find((q) => q.system === VIDEO_MOMENT_SYSTEM)!;
    expect(watch.parts[0]).toEqual({ fileData: { fileUri: 'https://www.youtube.com/watch?v=abcdefghijk' } });
    expect(texts(watch.parts).join('\n')).toContain('node voltage analysis');
    expect(watch.config.mediaResolution).toBe('MEDIA_RESOLUTION_LOW');
  });

  it('falls back to what the search result said when the video cannot be watched, or does not explain the concept', async () => {
    script.pick.push({ index: 0, startSec: 30, endSec: 200, why: 'covers the idea' });
    script.moment.push({ explainsIt: false, start: '0:00', end: '0:00', why: '' });
    expect(await findVideoMoment(ctx, [cand()], 'x')).toMatchObject({ start: 30, source: 'metadata' });
    script.pick.push({ index: 0, startSec: 45, endSec: 200, why: 'covers the idea' });
    // no moment scripted: the call fails
    expect(await findVideoMoment(ctx, [cand({ videoId: 'bbbbbbbbbbb' })], 'x')).toMatchObject({ start: 45, source: 'metadata' });
  });

  it('does not try to watch a very long video', async () => {
    script.pick.push({ index: 0, startSec: 0, endSec: 300, why: 'a lecture' });
    const m = await findVideoMoment(ctx, [cand({ lengthSec: 3 * 3600 })], 'x');
    expect(m.source).toBe('metadata');
    expect(requests.some((q) => q.system === VIDEO_MOMENT_SYSTEM)).toBe(false);
  });

  it('still picks something when the text pick itself fails', async () => {
    const m = await findVideoMoment(ctx, [cand({ chapters: [{ title: 'Start', startSec: 12 }] })], 'x');
    expect(m).toMatchObject({ videoId: 'abcdefghijk', start: 12 });
  });

  it('refuses a list with no videos', async () => {
    await expect(findVideoMoment(ctx, [], 'x')).rejects.toThrow(/No suitable videos/);
  });
});
