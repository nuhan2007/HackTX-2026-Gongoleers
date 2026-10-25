import { describe, expect, it } from 'vitest';
import { CallGate, DEFAULT_GATE, type GateInput } from '../src/background/callGate';
import { changedFraction, isChange, NOISE_FRACTION, toGray, type Gray } from '../src/background/frameDiff';
import { MemoryFrameStore, survivors } from '../src/background/frameStore';
import type { Frame } from '../src/background/frames';
import { CARRY_MS, mergePage, type TabReports } from '../src/background/pageMerge';
import { MIN_WORK_INPUT, TabRoles, WORK_WINDOW_MS } from '../src/background/tabRoles';
import type { PageSignals, Signal } from '../src/shared/types';

// ---------- the call gate ----------

const T0 = 1_000_000;
const S = 1000;
const idle = (now: number, over: Partial<GateInput> = {}): GateInput => ({ now, workChanged: 0, score: 10, newIncorrect: 0, ...over });
/** Some real new work on screen: well above noise, below a "burst". */
const SOME = 0.004;
const BURST = 0.03;

describe('CallGate: nothing happening costs nothing', () => {
  it('never asks while the student just sits there, however long', () => {
    const g = new CallGate(T0);
    for (let t = 0; t < 600; t += 3) expect(g.push(idle(T0 + t * S))).toBeNull();
  });

  it('ignores flicker below the noise floor', () => {
    const g = new CallGate(T0);
    for (let t = 0; t < 300; t += 3) expect(g.push(idle(T0 + t * S, { workChanged: NOISE_FRACTION / 2 }))).toBeNull();
    expect(g.state(T0 + 300 * S).pendingWork).toBe(0);
  });
});

describe('CallGate: a wrong answer on the homework page', () => {
  it('asks once the page has settled, not the instant it appears', () => {
    const g = new CallGate(T0);
    expect(g.push(idle(T0 + 10 * S, { newIncorrect: 1 }))).toBeNull();
    expect(g.push(idle(T0 + 11 * S))).toBeNull(); // 1s: still settling
    expect(g.push(idle(T0 + 12 * S))?.reason).toBe('wrong-answer');
  });

  it('needs no new work on the work tab (the answer was typed on the problem page)', () => {
    const g = new CallGate(T0);
    g.push(idle(T0 + 10 * S, { newIncorrect: 1 }));
    expect(g.push(idle(T0 + 13 * S, { workChanged: 0 }))?.reason).toBe('wrong-answer');
  });

  it('asks again sooner for a fresh wrong answer than for anything else', () => {
    const g = new CallGate(T0);
    g.push(idle(T0 + 10 * S, { newIncorrect: 1 }));
    expect(g.push(idle(T0 + 13 * S))?.reason).toBe('wrong-answer');
    g.callStarted(T0 + 13 * S, 'wrong-answer', 20);
    g.callFinished('mistake');
    g.push(idle(T0 + 14 * S, { newIncorrect: 1 }));
    expect(g.push(idle(T0 + 17 * S))).toBeNull(); // only 4s since the last look
    expect(g.push(idle(T0 + 19 * S))?.reason).toBe('wrong-answer'); // 6s: allowed (wrong-answer gap is 5s)
  });
});

describe('CallGate: a wrong answer is never lost to routine reading', () => {
  const reading = (now: number, over: Partial<GateInput> = {}) => idle(now, { workInput: 30, progress: { everyMs: 5 * S }, score: 15, ...over });

  it('a reading that starts while the page\'s "incorrect" is still settling does not swallow it', () => {
    const g = new CallGate(T0);
    const first = g.push(reading(T0 + 20 * S));
    g.callStarted(T0 + 20 * S, first!.reason, 15);
    g.callFinished('on_track');
    // the page says "incorrect" just as the next routine reading comes due
    g.push(reading(T0 + 25 * S, { newIncorrect: 1 }));
    // (the reading itself is allowed to go first; it must not wipe the wrong answer)
    g.callStarted(T0 + 25 * S, 'progress', 15);
    g.callFinished('on_track');
    const r = g.push(reading(T0 + 28 * S, { workInput: 0 }));
    expect(r?.reason).toBe('wrong-answer');
  });

  it('is checked as soon as it has settled, not held back by the readings every few seconds', () => {
    const g = new CallGate(T0);
    const reads: string[] = [];
    for (let t = 20; t <= 40; t++) {
      const r = g.push(reading(T0 + t * S, { newIncorrect: t === 31 ? 1 : 0 }));
      if (r) {
        reads.push(`${t}:${r.reason}`);
        g.callStarted(T0 + t * S, r.reason, 15);
        g.callFinished('mistake');
      }
    }
    const at = Number(reads.find((x) => x.endsWith('wrong-answer'))?.split(':')[0]);
    expect(at).toBeGreaterThanOrEqual(33); // after the 2 s the page needs to settle
    expect(at).toBeLessThanOrEqual(34);
  });
});

describe('CallGate: confusion rising', () => {
  it('asks when the score climbs, but only if there is new work to look at', () => {
    const g = new CallGate(T0);
    g.push(idle(T0 + 2 * S, { score: 10 })); // the score when the session began
    expect(g.push(idle(T0 + 5 * S, { score: 40 }))).toBeNull(); // risen by 30 but nothing new on screen
    const r = g.push(idle(T0 + 8 * S, { score: 40, workChanged: SOME }));
    expect(r?.reason).toBe('confusion-rise');
    expect(r?.detail).toContain('40');
  });

  it('asks when the score first reaches the high range', () => {
    const g = new CallGate(T0);
    g.push(idle(T0 + 5 * S, { score: 30, workChanged: SOME }));
    g.callStarted(T0 + 5 * S, 'confusion-rise', 30);
    g.callFinished('on_track');
    // 30 → 44 is below the 15-point rise, and 44 is below the high mark: no ask
    expect(g.push(idle(T0 + 60 * S, { score: 44, workChanged: SOME }))?.reason).not.toBe('confusion-rise');
    expect(g.push(idle(T0 + 61 * S, { score: 46, workChanged: SOME }))?.reason).toBe('confusion-rise');
  });

  it('does not ask again for the same elevated score', () => {
    const g = new CallGate(T0);
    g.push(idle(T0 + 2 * S, { score: 10 }));
    expect(g.push(idle(T0 + 5 * S, { score: 50, workChanged: SOME }))?.reason).toBe('confusion-rise');
    g.callStarted(T0 + 5 * S, 'confusion-rise', 50);
    g.callFinished('on_track');
    for (let t = 20; t < 55; t += 3) expect(g.push(idle(T0 + t * S, { score: 52, workChanged: SOME }))).toBeNull();
  });

  it('measures a rise from where the session started, not from zero', () => {
    // Sessions usually begin because the score was already high; being at 62 is not "a rise".
    const g = new CallGate(T0);
    g.push(idle(T0 + 2 * S, { score: 62 }));
    expect(g.push(idle(T0 + 5 * S, { score: 66, workChanged: SOME }))).toBeNull();
    expect(g.push(idle(T0 + 8 * S, { score: 78, workChanged: SOME }))?.reason).toBe('confusion-rise');
  });

  it('works without a score (no camera), falling back to the other triggers', () => {
    const g = new CallGate(T0);
    expect(g.push(idle(T0 + 5 * S, { score: null, workChanged: SOME }))).toBeNull();
  });
});

describe('CallGate: time on the problem', () => {
  it('checks at a checkpoint only when the work changed, then waits twice as long', () => {
    const g = new CallGate(T0);
    expect(g.push(idle(T0 + 61 * S))).toBeNull(); // a minute in but nothing new on screen
    const r = g.push(idle(T0 + 62 * S, { workChanged: SOME }));
    expect(r?.reason).toBe('time-on-problem');
    g.callStarted(T0 + 62 * S, 'time-on-problem', 10);
    g.callFinished('on_track');
    // next checkpoint is two minutes after that look, not one
    expect(g.push(idle(T0 + 130 * S, { workChanged: SOME }))).toBeNull();
    expect(g.push(idle(T0 + 183 * S, { workChanged: SOME }))?.reason).toBe('time-on-problem');
  });
});

describe('CallGate: a burst of writing, then a pause', () => {
  it('asks when the student stops after a real chunk of work', () => {
    const g = new CallGate(T0);
    g.push(idle(T0 + 20 * S, { workChanged: BURST }));
    expect(g.push(idle(T0 + 22 * S))).toBeNull(); // 2s of quiet: still writing, probably
    expect(g.push(idle(T0 + 25 * S))?.reason).toBe('work-pause');
  });

  it('does not ask while they are still writing', () => {
    const g = new CallGate(T0);
    for (let t = 20; t < 40; t += 3) expect(g.push(idle(T0 + t * S, { workChanged: BURST / 3 }))?.reason).not.toBe('work-pause');
  });

  it('does not ask for a few characters', () => {
    const g = new CallGate(T0);
    g.push(idle(T0 + 20 * S, { workChanged: 0.001 }));
    expect(g.push(idle(T0 + 30 * S))).toBeNull();
  });

  it('counts a handwritten line as a burst: a whole equation is only ~0.2% of a full screen', () => {
    const g = new CallGate(T0);
    g.push(idle(T0 + 20 * S, { workChanged: 0.002 }));
    expect(g.push(idle(T0 + 25 * S))?.reason).toBe('work-pause');
  });
});

describe('CallGate: writing input counts as work even when the pixels barely change', () => {
  it('a pen-written line (lots of drag events, almost no pixels) is a burst, then a pause → a look', () => {
    const g = new CallGate(T0);
    g.push(idle(T0 + 20 * S, { workChanged: 0, workInput: 60 }));
    expect(g.push(idle(T0 + 22 * S))).toBeNull(); // still writing, probably
    expect(g.push(idle(T0 + 25 * S))?.reason).toBe('work-pause');
  });

  it('a few strokes are not a burst, and not even "new work" for the other triggers', () => {
    const g = new CallGate(T0);
    g.push(idle(T0 + 20 * S, { workInput: 4 }));
    expect(g.push(idle(T0 + 30 * S))).toBeNull();
    expect(g.push(idle(T0 + 30 * S, { score: 60 }))).toBeNull(); // rising confusion needs real new work
  });

  it('enough input makes a confusion rise worth a look, with no pixel change at all', () => {
    const g = new CallGate(T0);
    g.push(idle(T0 + 2 * S, { score: 10 }));
    expect(g.push(idle(T0 + 20 * S, { score: 55, workInput: 12 }))?.reason).toBe('confusion-rise');
  });

  it('input is spent by a look, like ink', () => {
    const g = new CallGate(T0);
    g.push(idle(T0 + 20 * S, { workInput: 60 }));
    g.callStarted(T0 + 21 * S, 'work-pause', null);
    g.callFinished('on_track');
    expect(g.state(T0 + 22 * S).pendingInput).toBe(0);
    expect(g.push(idle(T0 + 200 * S))).toBeNull();
  });
});

describe('CallGate: the student looks finished', () => {
  // no new work for 10 s, while the confusion score is at or below 35
  const FIN = { idleMs: 10 * S, calmBelow: 35 };
  const calm = (now: number, over: Partial<GateInput> = {}) => idle(now, { finish: FIN, score: 20, ...over });
  /** A chunk of handwriting/typing at `at`. */
  const write = (g: CallGate, at: number, over: Partial<GateInput> = {}) => g.push(calm(at, { workInput: 60, ...over }));

  it('asks to check the answer once they wrote a chunk, then stopped for the idle time, while calm', () => {
    const g = new CallGate(T0);
    write(g, T0 + 20 * S);
    expect(g.push(calm(T0 + 25 * S))).toBeNull(); // 5 s of quiet: not long enough
    expect(g.push(calm(T0 + 29 * S))).toBeNull(); // 9 s
    const r = g.push(calm(T0 + 31 * S)); // 11 s
    expect(r?.reason).toBe('finished');
    expect(r?.detail).toMatch(/no new work for 11s/);
  });

  it('does not count someone who stopped but is still confused', () => {
    const g = new CallGate(T0);
    write(g, T0 + 20 * S, { score: 70 });
    for (let t = 25; t < 120; t += 3) expect(g.push(calm(T0 + t * S, { score: 70 }))?.reason).not.toBe('finished');
  });

  it('a calm pause is the finished check, not also a quiet look; a worried pause still gets the quiet look', () => {
    const calmOne = new CallGate(T0);
    write(calmOne, T0 + 20 * S);
    expect(calmOne.push(calm(T0 + 25 * S))?.reason).toBeUndefined(); // past the 4 s pause, but this one waits for "finished"
    const worried = new CallGate(T0);
    write(worried, T0 + 20 * S, { score: 40 });
    expect(worried.push(calm(T0 + 25 * S, { score: 40 }))?.reason).toBe('work-pause');
  });

  it('needs something to check: nothing written, or a few stray keystrokes, is never "finished"', () => {
    const g = new CallGate(T0);
    for (let t = 20; t < 200; t += 3) expect(g.push(calm(T0 + t * S))).toBeNull();
    const h = new CallGate(T0);
    h.push(calm(T0 + 20 * S, { workInput: 4 }));
    for (let t = 25; t < 200; t += 3) expect(h.push(calm(T0 + t * S))).toBeNull();
  });

  it('does not call the first seconds of a session "finished"', () => {
    const g = new CallGate(T0);
    write(g, T0 + 2 * S);
    expect(g.push(calm(T0 + 13 * S))).toBeNull(); // idle for 11 s, but the session is only 13 s old
    expect(g.push(calm(T0 + 16 * S))?.reason).toBe('finished');
  });

  it('checks the same work once, and again only after more work', () => {
    const g = new CallGate(T0);
    write(g, T0 + 20 * S);
    expect(g.push(calm(T0 + 31 * S))?.reason).toBe('finished');
    g.callStarted(T0 + 31 * S, 'finished', 20);
    g.callFinished('mistake');
    for (let t = 34; t < 200; t += 3) expect(g.push(calm(T0 + t * S))).toBeNull(); // they read the message; nothing new to check
    expect(g.checkedSinceLastWork()).toBe(true);
    write(g, T0 + 210 * S); // they fix their work
    expect(g.checkedSinceLastWork()).toBe(false);
    expect(g.push(calm(T0 + 222 * S))?.reason).toBe('finished');
  });

  it('is not held back by the spacing that follows looks that found nothing', () => {
    const g = new CallGate(T0);
    for (let i = 0; i < 4; i++) {
      g.callStarted(T0 + (20 + i) * S, 'work-pause', 20);
      g.callFinished('on_track'); // each empty look doubles the wait for the others
    }
    write(g, T0 + 40 * S);
    expect(g.state(T0 + 40 * S).backoff).toBe(3);
    expect(g.push(calm(T0 + 52 * S))?.reason).toBe('finished');
  });

  it('still checks once after a quiet look guessed it was solved, and stops only when the check agrees', () => {
    const g = new CallGate(T0);
    write(g, T0 + 20 * S);
    g.callStarted(T0 + 21 * S, 'work-pause', 20);
    g.callFinished('solved'); // a guess
    expect(g.push(idle(T0 + 40 * S, { workChanged: BURST }))).toBeNull(); // quiet looks have stopped
    write(g, T0 + 60 * S);
    expect(g.push(calm(T0 + 72 * S))?.reason).toBe('finished');
    g.callStarted(T0 + 72 * S, 'finished', 20);
    g.callFinished('solved'); // confirmed
    write(g, T0 + 100 * S);
    for (let t = 112; t < 400; t += 3) expect(g.push(calm(T0 + t * S))).toBeNull();
    expect(g.state(T0 + 400 * S).solved).toBe(true);
  });

  it('the homework page saying "wrong" overrules a quiet look that guessed "solved", and is checked promptly', () => {
    const g = new CallGate(T0);
    g.callStarted(T0 + 20 * S, 'progress', 20);
    g.callFinished('solved'); // a guess: the sprite may even have congratulated them
    expect(g.state(T0 + 21 * S).solved).toBe(true);
    expect(g.push(idle(T0 + 40 * S, { newIncorrect: 1 }))).toBeNull(); // settling
    expect(g.state(T0 + 40 * S).solved).toBe(false);
    expect(g.push(idle(T0 + 43 * S))?.reason).toBe('wrong-answer');
  });

  it('does not let leftover "incorrect" text on the page undo an answer the check or the page itself confirmed', () => {
    const g = new CallGate(T0);
    g.callStarted(T0 + 20 * S, 'finished', 20);
    g.callFinished('solved'); // confirmed by the real check
    for (let t = 30; t < 60; t++) expect(g.push(idle(T0 + t * S, { newIncorrect: 1 }))).toBeNull();
    expect(g.state(T0 + 60 * S).solved).toBe(true);
  });

  it('a mistake found by the check re-opens a problem a quiet look had called solved', () => {
    const g = new CallGate(T0);
    g.callStarted(T0 + 20 * S, 'work-pause', 20);
    g.callFinished('solved');
    write(g, T0 + 30 * S);
    expect(g.push(calm(T0 + 42 * S))?.reason).toBe('finished');
    g.callStarted(T0 + 42 * S, 'finished', 20);
    g.callFinished('mistake');
    expect(g.state(T0 + 43 * S).solved).toBe(false);
    expect(g.push(idle(T0 + 60 * S, { newIncorrect: 1 }))).toBeNull(); // settling
    expect(g.push(idle(T0 + 64 * S))?.reason).toBe('wrong-answer'); // quiet looks work again
  });

  it('is off when no finish settings are passed (automatic checking switched off)', () => {
    const g = new CallGate(T0);
    g.push(idle(T0 + 20 * S, { workInput: 60 }));
    expect(g.push(idle(T0 + 25 * S))?.reason).toBe('work-pause');
    for (let t = 40; t < 300; t += 3) expect(g.push(idle(T0 + t * S))?.reason).not.toBe('finished');
  });

  it('a check the student asked for counts as a check', () => {
    const g = new CallGate(T0);
    write(g, T0 + 20 * S);
    g.noteCheck();
    expect(g.checkedSinceLastWork()).toBe(true);
    for (let t = 40; t < 300; t += 3) expect(g.push(calm(T0 + t * S))?.reason).not.toBe('finished');
  });

  it('tells the panel whether there is something to check and how long they have been still', () => {
    const g = new CallGate(T0);
    expect(g.state(T0 + 10 * S)).toMatchObject({ finishWork: false, idleSec: null });
    write(g, T0 + 20 * S);
    expect(g.state(T0 + 27 * S)).toMatchObject({ finishWork: true, idleSec: 7 });
  });
});

describe('CallGate: keeping calls frugal', () => {
  it('never has two calls in flight', () => {
    const g = new CallGate(T0);
    g.push(idle(T0 + 2 * S, { score: 10 }));
    expect(g.push(idle(T0 + 20 * S, { score: 60, workChanged: SOME }))).not.toBeNull();
    g.callStarted(T0 + 20 * S, 'confusion-rise', 60);
    for (let t = 21; t < 200; t += 3) expect(g.push(idle(T0 + t * S, { score: 99, workChanged: BURST, newIncorrect: 1 }))).toBeNull();
    expect(g.state(T0 + 200 * S).inFlight).toBe(true);
  });

  it('spaces looks out further after each one that finds nothing, and resets when a mistake is found', () => {
    const g = new CallGate(T0);
    let now = T0;
    const gaps: number[] = [];
    for (let i = 0; i < 4; i++) {
      // wait for the gate to allow a look, with a wrong answer pending each time
      let asked: number | null = null;
      g.push(idle(now, { newIncorrect: 1 }));
      for (let t = 1; t < 600 && asked === null; t++) {
        const r = g.push(idle(now + t * S, i ? {} : {}));
        if (r) asked = now + t * S;
      }
      expect(asked).not.toBeNull();
      gaps.push(asked! - now);
      g.callStarted(asked!, 'wrong-answer', null);
      g.callFinished('on_track');
      now = asked!;
    }
    // the first wait is just the settle time; later ones grow only until a wrong answer resets them (each loop adds one)
    expect(gaps[0]).toBeLessThanOrEqual(3 * S);
    expect(g.state(now).backoff).toBeGreaterThanOrEqual(1);
    g.callStarted(now + 200 * S, 'work-pause', null);
    g.callFinished('mistake');
    expect(g.state(now + 200 * S).backoff).toBe(0);
  });

  it('stops entirely once the work is solved', () => {
    const g = new CallGate(T0);
    g.callStarted(T0 + 10 * S, 'work-pause', 30);
    g.callFinished('solved');
    for (let t = 20; t < 1000; t += 3) expect(g.push(idle(T0 + t * S, { score: 99, workChanged: BURST }))).toBeNull();
  });

  it('caps the quiet looks per ten minutes', () => {
    const g = new CallGate(T0, { ...DEFAULT_GATE, baseGapMs: 1000, maxGapMs: 1000 });
    let asked = 0;
    // every 6 s: a chunk of writing, then a pause that earns a quiet "work-pause" look
    for (let t = 0; t < 590; t += 6) {
      g.push(idle(T0 + t * S, { workInput: 60 }));
      const r = g.push(idle(T0 + (t + 5) * S));
      if (r) {
        asked++;
        g.callStarted(T0 + (t + 5) * S, r.reason, null);
        g.callFinished('mistake');
      }
    }
    expect(asked).toBe(DEFAULT_GATE.budget.max);
    // ...and the window slides: after ten minutes it may ask again
    g.push(idle(T0 + 700 * S, { workInput: 60 }));
    expect(g.push(idle(T0 + 705 * S))).not.toBeNull();
  });

  it('keeps a wrong answer and the finished check outside that cap, under a much larger one', () => {
    const g = new CallGate(T0, { ...DEFAULT_GATE, baseGapMs: 1000, wrongAnswerGapMs: 1000, maxGapMs: 1000, settleMs: 0 });
    let asked = 0;
    for (let t = 0; t < 590; t += 2) {
      const r = g.push(idle(T0 + t * S, { newIncorrect: 1 }));
      if (r) {
        asked++;
        g.callStarted(T0 + t * S, r.reason, null);
        g.callFinished('mistake');
      }
    }
    expect(asked).toBeGreaterThan(DEFAULT_GATE.budget.max);
    expect(asked).toBeLessThanOrEqual(DEFAULT_GATE.steadyBudget);
  });

  it('stops at the large cap too, so nothing can run away', () => {
    const g = new CallGate(T0, { ...DEFAULT_GATE, steadyBudget: 20, settleMs: 0, wrongAnswerGapMs: 1000 });
    let asked = 0;
    for (let t = 0; t < 590; t += 2) {
      const r = g.push(idle(T0 + t * S, { newIncorrect: 1 }));
      if (r) {
        asked++;
        g.callStarted(T0 + t * S, r.reason, null);
        g.callFinished('mistake');
      }
    }
    expect(asked).toBe(20);
  });
});

describe('CallGate: reading along while the student writes', () => {
  const PROGRESS = { everyMs: 5 * S };
  const writing = (now: number, over: Partial<GateInput> = {}) => idle(now, { workInput: 30, progress: PROGRESS, score: 15, ...over });

  it('reads as soon as there is new writing, then every interval for as long as they keep writing', () => {
    const g = new CallGate(T0);
    const reads: number[] = [];
    for (let t = 20; t <= 80; t += 1) {
      const r = g.push(writing(T0 + t * S));
      if (r) {
        expect(r.reason).toBe('progress');
        reads.push(t);
        g.callStarted(T0 + t * S, r.reason, 15);
        g.callFinished('on_track');
      }
    }
    expect(reads[0]).toBe(20);
    expect(reads.slice(1).map((t, i) => t - reads[i]).every((gap) => gap === 5)).toBe(true);
    expect(reads.length).toBeGreaterThanOrEqual(12);
  });

  it('is not slowed down by earlier reads that found nothing (the old spacing doubled to two minutes)', () => {
    const g = new CallGate(T0);
    let reads = 0;
    for (let t = 20; t <= 200; t += 1) {
      const r = g.push(writing(T0 + t * S));
      if (r) {
        reads++;
        g.callStarted(T0 + t * S, r.reason, 15);
        g.callFinished('no_work');
      }
    }
    expect(reads).toBeGreaterThanOrEqual(30);
  });

  it('does not read when there is nothing new: sitting still costs nothing', () => {
    const g = new CallGate(T0);
    const first = g.push(writing(T0 + 20 * S));
    g.callStarted(T0 + 20 * S, first!.reason, 15);
    g.callFinished('on_track');
    for (let t = 21; t < 300; t++) expect(g.push(idle(T0 + t * S, { progress: PROGRESS, score: 60 }))?.reason).not.toBe('progress');
  });

  it('never has two reads in flight, however long one takes', () => {
    const g = new CallGate(T0);
    const first = g.push(writing(T0 + 20 * S));
    g.callStarted(T0 + 20 * S, first!.reason, 15);
    for (let t = 21; t < 120; t++) expect(g.push(writing(T0 + t * S))).toBeNull();
    g.callFinished('on_track');
    expect(g.push(writing(T0 + 121 * S))?.reason).toBe('progress');
  });

  it('is off without a reading interval', () => {
    const g = new CallGate(T0);
    for (let t = 20; t < 40; t++) expect(g.push(idle(T0 + t * S, { workInput: 30, score: 15 }))?.reason).not.toBe('progress');
  });

  it('stands aside for the finished check when they stop and are calm', () => {
    const g = new CallGate(T0);
    const FIN = { idleMs: 8 * S, calmBelow: 35 };
    const first = g.push(writing(T0 + 20 * S, { workInput: 60 }));
    g.callStarted(T0 + 20 * S, first!.reason, 15);
    g.callFinished('on_track');
    g.push(writing(T0 + 22 * S, { workInput: 60, finish: FIN }));
    expect(g.push(writing(T0 + 31 * S, { workInput: 0, finish: FIN }))?.reason).toBe('finished');
  });

  it('keeps going after the quiet-look cap is used up', () => {
    const g = new CallGate(T0);
    let reads = 0;
    for (let t = 20; t <= 400; t += 1) {
      const r = g.push(writing(T0 + t * S));
      if (r) {
        reads++;
        g.callStarted(T0 + t * S, r.reason, 15);
        g.callFinished('on_track');
      }
    }
    expect(reads).toBeGreaterThan(DEFAULT_GATE.budget.max * 3);
  });

  it('the homework page saying "correct" ends the asking for good', () => {
    const g = new CallGate(T0);
    g.markSolvedByPage();
    expect(g.checkedSinceLastWork()).toBe(true);
    for (let t = 20; t < 100; t++) expect(g.push(writing(T0 + t * S, { newIncorrect: 1 }))).toBeNull();
    expect(g.state(T0 + 100 * S).solved).toBe(true);
  });
});

describe('CallGate: a finished line is read right away', () => {
  const PROGRESS = { everyMs: 5 * S };
  const write = (now: number, input = 30, over: Partial<GateInput> = {}) => idle(now, { workInput: input, progress: PROGRESS, score: 15, ...over });
  const still = (now: number, over: Partial<GateInput> = {}) => idle(now, { progress: PROGRESS, score: 15, ...over });
  const read = (g: CallGate, at: number) => {
    const r = g.push(still(at));
    return r;
  };

  it('reads about a second after they stop writing, not at the next periodic read', () => {
    const g = new CallGate(T0);
    const first = g.push(write(T0 + 20 * S));
    g.callStarted(T0 + 20 * S, first!.reason, 15);
    g.callFinished('on_track');
    g.push(write(T0 + 21 * S));
    g.push(write(T0 + 22 * S)); // the last stroke of the line
    expect(read(g, T0 + 22.5 * S)).toBeNull(); // not yet: could still be writing
    const r = read(g, T0 + 23 * S);
    expect(r?.reason).toBe('progress');
    expect(r?.detail).toMatch(/finished a line/);
  });

  it('reads the line once, not again and again while they sit still', () => {
    const g = new CallGate(T0);
    g.push(write(T0 + 20 * S));
    const r = g.push(still(T0 + 21 * S));
    expect(r?.detail).toMatch(/finished a line/);
    g.callStarted(T0 + 21 * S, r!.reason, 15);
    g.callFinished('on_track');
    for (let t = 22; t < 60; t++) expect(g.push(still(T0 + t * S))?.reason).not.toBe('progress');
  });

  it("does not read while they are still writing: that is the periodic read's job", () => {
    const g = new CallGate(T0);
    const first = g.push(write(T0 + 20 * S));
    g.callStarted(T0 + 20 * S, first!.reason, 15);
    g.callFinished('on_track');
    for (let t = 21; t < 25; t++) expect(g.push(write(T0 + t * S))).toBeNull();
    expect(g.push(write(T0 + 25 * S))?.detail).toMatch(/writing: reading what is new/);
  });

  it("needs a word's worth of writing: a stray keystroke or two is not a line", () => {
    const g = new CallGate(T0);
    g.push(idle(T0 + 20 * S, { workInput: 2, progress: PROGRESS, score: 15 }));
    for (let t = 21; t < 40; t++) expect(g.push(still(T0 + t * S))).toBeNull();
  });

  it('is never closer than the minimum gap to the previous read', () => {
    const g = new CallGate(T0);
    const first = g.push(write(T0 + 20 * S));
    g.callStarted(T0 + 20 * S, first!.reason, 15);
    g.callFinished('on_track');
    g.push(write(T0 + 20.4 * S)); // a quick second line right after
    expect(read(g, T0 + 21.4 * S)).toBeNull(); // 1.4 s since the last read: too soon
    expect(read(g, T0 + 21.6 * S)?.detail).toMatch(/finished a line/);
  });

  it('is off without continuous reading', () => {
    const g = new CallGate(T0);
    g.push(idle(T0 + 20 * S, { workInput: 30, score: 15 }));
    for (let t = 21; t < 40; t++) expect(g.push(idle(T0 + t * S, { score: 15 }))?.reason).not.toBe('progress');
  });

  it('a wrong answer on the page still comes first', () => {
    const g = new CallGate(T0);
    g.push(write(T0 + 20 * S, 30, { newIncorrect: 1 }));
    const r = g.push(still(T0 + 23 * S));
    expect(r?.reason).toBe('wrong-answer');
  });

  describe('looking again once they are still (a copy of the problem that may be unfinished)', () => {
    it('waits for the stillness it asked for, even when nothing new was written', () => {
      const g = new CallGate(T0);
      const first = g.push(write(T0 + 20 * S));
      g.callStarted(T0 + 20 * S, first!.reason, 15);
      g.callFinished('mistake');
      g.requestSettledRead();
      expect(g.push(still(T0 + 21 * S))).toBeNull();
      expect(g.push(still(T0 + 22 * S))).toBeNull();
      const r = g.push(still(T0 + 22.6 * S));
      expect(r?.reason).toBe('progress');
      expect(r?.detail).toMatch(/copied/);
    });

    it('happens once, then goes quiet again', () => {
      const g = new CallGate(T0);
      const first = g.push(write(T0 + 20 * S));
      g.callStarted(T0 + 20 * S, first!.reason, 15);
      g.callFinished('mistake');
      g.requestSettledRead();
      const r = g.push(still(T0 + 23 * S))!;
      g.callStarted(T0 + 23 * S, r.reason, 15);
      g.callFinished('mistake');
      for (let t = 24; t < 60; t++) expect(g.push(still(T0 + t * S))).toBeNull();
    });

    it('is satisfied by a full check of the answer: no extra look follows it', () => {
      const g = new CallGate(T0);
      const first = g.push(write(T0 + 20 * S));
      g.callStarted(T0 + 20 * S, first!.reason, 15);
      g.callFinished('mistake');
      g.requestSettledRead();
      g.callStarted(T0 + 21 * S, 'wrong-answer', 15);
      g.callFinished('mistake');
      expect(g.nextWakeMs(T0 + 22 * S)).toBeNull();
      for (let t = 22; t < 40; t++) expect(g.push(still(T0 + t * S))?.detail ?? '').not.toMatch(/copied/);
    });

    it('does not fire while they keep writing, and fires once they stop', () => {
      const g = new CallGate(T0);
      const first = g.push(write(T0 + 20 * S));
      g.callStarted(T0 + 20 * S, first!.reason, 15);
      g.callFinished('mistake');
      g.requestSettledRead();
      for (let t = 21; t < 24; t++) expect(g.push(write(T0 + t * S, 2))?.detail ?? '').not.toMatch(/copied/);
      expect(g.push(still(T0 + 26.6 * S))?.detail).toMatch(/finished a line|copied/);
    });
  });

  it('says how long the student has been still', () => {
    const g = new CallGate(T0);
    expect(g.idleMs(T0 + 5 * S)).toBeNull();
    g.push(write(T0 + 20 * S));
    expect(g.idleMs(T0 + 23 * S)).toBe(3 * S);
  });
});

// ---------- which tab is the work tab ----------

describe('TabRoles.pickWork', () => {
  const NOW = 10_000_000;
  const tabs = [
    { tabId: 1, url: 'https://homework.example/q4' },
    { tabId: 2, url: 'https://docs.google.com/document/d/abc' },
    { tabId: 3, url: 'https://www.google.com/search?q=chain+rule' },
    { tabId: 4, url: 'chrome-extension://abc/page.html' },
  ];
  const type = (r: TabRoles, id: number, keys: number, at = NOW) => {
    r.record(id, at - 30_000, 0, 0);
    r.record(id, at, keys, 0);
  };

  it('picks the other tab where the student is typing, never the problem tab', () => {
    const r = new TabRoles();
    type(r, 1, 200); // lots of typing in the answer box on the problem tab
    type(r, 2, 40);
    expect(r.pickWork(tabs, 1, null, NOW)).toBe(2);
  });

  it('ignores search/chat tabs, extension pages and tabs with barely any input', () => {
    const r = new TabRoles();
    type(r, 3, 300); // typing in a Google search is looking for help, not working
    type(r, 4, 300);
    type(r, 2, MIN_WORK_INPUT - 1);
    expect(r.pickWork(tabs, 1, null, NOW)).toBeNull();
  });

  it('counts pen and mouse drawing, at a quarter weight (a stroke is dozens of events)', () => {
    const r = new TabRoles();
    r.record(2, NOW - 20_000, 0, 0);
    r.record(2, NOW, 0, 4 * MIN_WORK_INPUT);
    expect(r.recentInput(2, NOW)).toBe(MIN_WORK_INPUT);
    expect(r.pickWork(tabs, 1, null, NOW)).toBe(2);
  });

  it('finds a tab where the student only draws (no keystrokes at all)', () => {
    const r = new TabRoles();
    r.record(2, NOW - 20_000, 0, 0);
    r.record(2, NOW, 0, 300); // one handwritten line
    expect(r.pickWork(tabs, 1, null, NOW)).toBe(2);
  });

  it('starts over when a drawing page reloads (its drag totals restart)', () => {
    const r = new TabRoles();
    r.record(2, NOW - 40_000, 0, 5000);
    r.record(2, NOW - 20_000, 0, 10); // reloaded
    r.record(2, NOW, 0, 90);
    expect(r.recentInput(2, NOW)).toBe(0.25 * 80);
  });

  it('forgets input older than the window', () => {
    const r = new TabRoles();
    type(r, 2, 100, NOW - WORK_WINDOW_MS - 5_000);
    expect(r.recentInput(2, NOW)).toBe(0);
  });

  it('keeps the current work tab unless another one clearly out-works it', () => {
    const r = new TabRoles();
    const three = [{ tabId: 1, url: 'https://homework.example/q4' }, { tabId: 2, url: 'https://scratch.example/a' }, { tabId: 5, url: 'https://notes.example/page' }];
    type(r, 2, 60);
    type(r, 5, 90);
    expect(r.pickWork(three, 1, 2, NOW)).toBe(2); // 90 is not twice 60
    const r2 = new TabRoles();
    type(r2, 2, 30);
    type(r2, 5, 90);
    expect(r2.pickWork(three, 1, 2, NOW)).toBe(5); // three times as much
  });

  it('does not give up a tab it recognises as a place to write (a Google Doc) for a page with more typing but nothing else going for it', () => {
    const r = new TabRoles();
    const three = [...tabs, { tabId: 5, url: 'https://notes.example/page' }];
    type(r, 2, 30);
    type(r, 5, 90);
    expect(r.pickWork(three, 1, 2, NOW)).toBe(2);
  });

  it('holds on to a pinned or current tab that has gone quiet rather than dropping it', () => {
    const r = new TabRoles();
    expect(r.pickWork(tabs, 1, 2, NOW)).toBe(2);
  });

  it('starts over when a page reloads (its running totals restart)', () => {
    const r = new TabRoles();
    r.record(2, NOW - 40_000, 500, 0);
    r.record(2, NOW - 20_000, 3, 0); // reloaded
    r.record(2, NOW, 13, 0);
    expect(r.recentInput(2, NOW)).toBe(10);
  });
});

// ---------- what the confusion engine sees across tabs ----------

describe('mergePage', () => {
  const NOW = 5_000_000;
  const sig = (id: string, value: number, reason = id): Signal => ({ id: id as never, value, reason });
  const page = (over: Partial<PageSignals> = {}): PageSignals => ({ content: [], activity: [], idleMs: 0, dwellMs: 0, questionLabel: 'Q4', ...over });
  const reports = (entries: [number, PageSignals, number][]): TabReports => {
    const m: TabReports = new Map();
    for (const [tab, signals, at] of entries) m.set(tab, new Map([[0, { signals, at }]]));
    return m;
  };

  it('uses the active tab as before', () => {
    const r = reports([[1, page({ content: [sig('incorrect', 0.85)], activity: [sig('rereading', 0.5)], idleMs: 7000 }), NOW - 500]]);
    const m = mergePage(r, 1, NOW)!;
    expect(m.content.map((s) => s.id)).toEqual(['incorrect']);
    expect(m.activity.map((s) => s.id)).toEqual(['rereading']);
    expect(m.idleMs).toBe(7000);
  });

  it('keeps a wrong answer from the homework tab counting while the student works in another tab, fading with time', () => {
    const wrong = page({ content: [sig('incorrect', 0.85, '2 incorrect submissions on Q4')] });
    const typing = page({ activity: [sig('backspace', 0.4)], idleMs: 1000 });
    const recent = mergePage(reports([[1, wrong, NOW - 60_000], [2, typing, NOW - 200]]), 2, NOW)!;
    expect(recent.content[0].id).toBe('incorrect');
    expect(recent.content[0].value).toBeCloseTo(0.85 * (1 - 60_000 / CARRY_MS), 5);
    expect(recent.activity.map((s) => s.id)).toEqual(['backspace']); // activity is the active tab's alone
    expect(recent.idleMs).toBe(1000);

    const old = mergePage(reports([[1, wrong, NOW - CARRY_MS - 1], [2, typing, NOW - 200]]), 2, NOW)!;
    expect(old.content).toEqual([]);
  });

  it('keeps scoring from the carried cue even when the active tab has no content script (a PDF or the side panel)', () => {
    const wrong = page({ content: [sig('incorrect', 0.85)], questionLabel: 'Q4' });
    const m = mergePage(reports([[1, wrong, NOW - 10_000]]), 99, NOW)!;
    expect(m.content[0].id).toBe('incorrect');
    expect(m.idleMs).toBe(0);
    expect(m.questionLabel).toBe('Q4');
  });

  it('is null when there is nothing to say', () => {
    expect(mergePage(new Map(), 1, NOW)).toBeNull();
    expect(mergePage(reports([[1, page(), NOW - 9_000]]), 1, NOW)).toBeNull(); // stale, and no content to carry
  });

  it('takes the strongest signal of each kind across frames', () => {
    const m: TabReports = new Map([[1, new Map([[0, { signals: page({ content: [sig('incorrect', 0.55)] }), at: NOW }], [7, { signals: page({ content: [sig('incorrect', 1)] }), at: NOW }]])]]);
    expect(mergePage(m, 1, NOW)!.content[0].value).toBe(1);
  });
});

// ---------- frame diffing ----------

const gray = (fill: number, w = 40, h = 20): Gray => ({ data: new Uint8Array(w * h).fill(fill), w, h });

describe('changedFraction', () => {
  it('is 0 for the same screen and 1 for frames that cannot be compared', () => {
    expect(changedFraction(gray(200), gray(200))).toBe(0);
    expect(changedFraction(null, gray(200))).toBe(1);
    expect(changedFraction(gray(200, 40, 20), gray(200, 30, 20))).toBe(1);
  });

  it('measures how much of the screen moved', () => {
    const a = gray(240);
    const b = gray(240);
    for (let i = 0; i < 80; i++) b.data[i] = 20; // 80 of 800 pixels (10%) turned dark: writing
    expect(changedFraction(a, b)).toBeCloseTo(0.1, 5);
  });

  it('ignores small brightness drift (antialiasing, a hover tint)', () => {
    const b = gray(200);
    b.data.fill(190);
    expect(changedFraction(gray(200), b)).toBe(0);
  });

  it('treats a few pixels as noise but a typed line as change', () => {
    const big = gray(240, 192, 108); // a realistic frame size: 20,736 pixels
    const caret = gray(240, 192, 108);
    for (let i = 0; i < 3; i++) caret.data[i] = 0; // blinking caret
    expect(isChange(changedFraction(big, caret))).toBe(false);
    const typed = gray(240, 192, 108);
    for (let i = 0; i < 60; i++) typed.data[i] = 0; // a few characters
    expect(isChange(changedFraction(big, typed))).toBe(true);
  });

  it('converts RGBA to luma', () => {
    const rgba = new Uint8Array([255, 255, 255, 255, 0, 0, 0, 255, 255, 0, 0, 255]);
    const g = toGray(rgba);
    expect(g[0]).toBeGreaterThan(250);
    expect(g[1]).toBe(0);
    expect(g[2]).toBeGreaterThan(60);
    expect(g[2]).toBeLessThan(90);
  });
});

// ---------- the local snapshot store ----------

const frame = (tabId: number, at: number, jpeg = 'x'.repeat(100)): Frame => ({ jpeg, at, tabId, windowId: 1, url: `https://e.example/${tabId}`, title: `tab ${tabId}`, changed: 1 });

describe('frame store', () => {
  it('keeps only the newest frames per tab', async () => {
    const s = new MemoryFrameStore(() => 100_000);
    for (let i = 0; i < 20; i++) await s.put(frame(1, 90_000 + i));
    const st = await s.stats();
    expect(st.perTab[1]).toBe(12);
    expect((await s.latest(1))!.at).toBe(90_019);
    expect((await s.recent(1, 3)).map((f) => f.at)).toEqual([90_019, 90_018, 90_017]);
  });

  it('drops frames older than the retention window', async () => {
    let now = 0;
    const s = new MemoryFrameStore(() => now);
    await s.put(frame(1, 0));
    now = 31 * 60_000;
    await s.put(frame(1, now));
    expect((await s.stats()).perTab[1]).toBe(1);
  });

  it('keeps tabs separate, and can forget one or everything', async () => {
    const s = new MemoryFrameStore(() => 1000);
    await s.put(frame(1, 900));
    await s.put(frame(2, 950));
    expect((await s.latest(1))!.url).toContain('/1');
    expect((await s.latest(2))!.url).toContain('/2');
    await s.dropTab(1);
    expect(await s.latest(1)).toBeNull();
    expect(await s.latest(2)).not.toBeNull();
    await s.clear();
    expect((await s.stats()).frames).toBe(0);
  });

  it('counts bytes', async () => {
    const s = new MemoryFrameStore(() => 1000);
    await s.put(frame(1, 900, 'y'.repeat(500)));
    expect((await s.stats()).bytes).toBe(500);
  });

  it('survivors() is order-preserving', () => {
    expect(survivors([{ at: 1 }, { at: 2 }, { at: 3 }], 4, 2, 100)).toEqual([{ at: 2 }, { at: 3 }]);
  });
});
