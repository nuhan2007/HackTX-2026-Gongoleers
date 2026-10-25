// When is it worth asking the model to look at the student's work? Almost never, if the cheap local
// signals are quiet. Snapshots are taken every few seconds and kept on this device; this gate decides
// which of them (if any) become a model call. It is pure, so every rule is unit-tested.
//
// A call needs a reason, and (except for a wrong answer on the homework page) new work since the last call,
// so an unchanged screen never costs anything. "New work" is either typing/drawing input on the work tab
// (exact, and the only thing that reliably sees thin handwriting) or enough of the screen changing:
//   wrong-answer     the homework page just said "incorrect" (a DOM change)
//   confusion-rise   the confusion score climbed since the last look, or crossed into the high range
//   time-on-problem  a checkpoint passed (1 min, then 2, then 4, capped) while the student kept working
//   work-pause       a real burst of new work, then the student stopped for a few seconds
//   finished         the student wrote a chunk of work, then stopped for the idle time while the confusion score
//                    is low: the one look that is a real CHECK of the answer, not a quiet observation
//   progress         the student is writing: the model reads the work every few seconds (a setting) as long as
//                    there is something new on screen since its last read. This is what keeps it following along. It also
//                    reads right after each finished line (new writing, then a second of stillness), so a slip is flagged
//                    a couple of seconds after the line was written rather than at the next periodic read.
// Then the rest of the rules keep it frugal: one call in flight, a minimum gap that doubles after each
// look that found nothing (not for progress reads, which have their own fixed cadence), a cap per ten minutes,
// and nothing at all once the work is solved.
import { COPY_IDLE_MS, LINE_MIN_INPUT, LINE_SETTLE_MS, MIN_READ_GAP_MS } from '../shared/constants';
import { NOISE_FRACTION } from './frameDiff';

export type CallReason = 'wrong-answer' | 'confusion-rise' | 'time-on-problem' | 'work-pause' | 'finished' | 'progress';

/** `different`: the screens show another problem than the one being followed. */
export type CallOutcome = 'on_track' | 'mistake' | 'solved' | 'no_work' | 'unclear' | 'failed' | 'different';

export interface GateConfig {
  /** Minimum time between model looks; doubles after each look that found nothing, up to maxGapMs. */
  baseGapMs: number;
  maxGapMs: number;
  /** A new wrong answer may ask again sooner. */
  wrongAnswerGapMs: number;
  /** Wait this long after "incorrect" appears so the snapshot catches the finished screen. */
  settleMs: number;
  /** Fraction of the work screen that must have changed since the last look to count as new work. */
  inkMin: number;
  /** ...and to count as a "burst" worth a look when the student pauses. A handwritten line is only ~0.2% of a full screen. */
  inkBurst: number;
  /** The same two thresholds in input: keystrokes plus a quarter of the pen/mouse drag events on the work tab. */
  inputMin: number;
  inputBurst: number;
  pauseMs: number;
  riseDelta: number;
  highScore: number;
  firstCheckpointMs: number;
  maxCheckpointMs: number;
  /** A finished-check may follow any other look this soon (finishing is deliberate, so it ignores the doubling gap). */
  finishGapMs: number;
  /** Nothing counts as "finished" in the first seconds of a session. */
  minSessionMs: number;
  /** Quiet looks (the ones that only update private notes) are capped per window... */
  budget: { max: number; windowMs: number };
  /** ...but reading the work as it is written, wrong answers and the final check have their own, much larger allowance. */
  steadyBudget: number;
  /** A line is finished when something new was written and then nothing for this long. */
  lineSettleMs: number;
  /** The least new writing (keystrokes plus a quarter of the pen events) that makes a pause worth a read. */
  lineMinInput: number;
  /** Reads right after a finished line are never closer together than this. */
  minReadGapMs: number;
  /** A look that has to see the student standing still (checking a copy of the problem) waits for this much stillness. */
  settleReadMs: number;
}

export const DEFAULT_GATE: GateConfig = {
  baseGapMs: 12_000,
  maxGapMs: 120_000,
  wrongAnswerGapMs: 5_000,
  settleMs: 2_000,
  inkMin: 0.0008,
  inkBurst: 0.0015,
  inputMin: 10, // ~10 characters, or a few strokes
  inputBurst: 40, // ~a line of text, or a handwritten line
  pauseMs: 4_000,
  riseDelta: 15,
  highScore: 45,
  firstCheckpointMs: 60_000,
  maxCheckpointMs: 240_000,
  finishGapMs: 8_000,
  minSessionMs: 15_000,
  budget: { max: 12, windowMs: 10 * 60_000 },
  steadyBudget: 200,
  lineSettleMs: LINE_SETTLE_MS,
  lineMinInput: LINE_MIN_INPUT,
  minReadGapMs: MIN_READ_GAP_MS,
  settleReadMs: COPY_IDLE_MS,
};

export interface GateInput {
  now: number;
  /** Fraction of the work screen that changed since the previous snapshot (0 when it wasn't captured this tick). */
  workChanged: number;
  /** Typing/drawing input on the work tab since the previous tick (keys + drag events / 4). Optional: 0 when unknown. */
  workInput?: number;
  /** Confusion score 0..100, or null when there is no fresh one. */
  score: number | null;
  /** "Incorrect" feedback newly seen on the homework page since the previous tick. */
  newIncorrect: number;
  /**
   * How to decide the student is finished: no new work for `idleMs` while the score is at or below `calmBelow`.
   * Null or missing switches the finished-check off (settings), and the gate behaves as it did before it existed.
   */
  finish?: { idleMs: number; calmBelow: number } | null;
  /** Read the work every `everyMs` while new work keeps appearing. Null or missing switches continuous reading off. */
  progress?: { everyMs: number } | null;
}

export interface GateState {
  inFlight: boolean;
  /** Fraction of new work accumulated since the last look. */
  pendingWork: number;
  /** Typing/drawing input accumulated since the last look. */
  pendingInput: number;
  /** A chunk of new work has been written since the last check of the answer, so there is something to check. */
  finishWork: boolean;
  /** Seconds since the student last wrote or typed anything (null before they have). */
  idleSec: number | null;
  /** Earliest time the next look is allowed (0 = no limit right now). */
  nextAllowedAt: number;
  backoff: number;
  callsInWindow: number;
  solved: boolean;
}

export class CallGate {
  private inFlight = false;
  private ink = 0;
  private input = 0;
  /** Work since the last CHECK of the answer (the periodic counters above restart at every look; these only at a check). */
  private checkInk = 0;
  private checkInput = 0;
  private checks = 0;
  private lastInkAt = 0;
  private incorrectAt = 0; // when the first unchecked wrong answer was seen (0 = none)
  private lastCallAt = 0;
  /** When the answer was last checked (a wrong answer on the page, or the student finishing). */
  private lastCheckAt = -Infinity;
  private callTimes: number[] = [];
  private backoff = 0;
  private scoreAtCall: number | null = null;
  /** The first score seen: a rise is measured from here until the first look, then from the score at each look. */
  private baseScore: number | null = null;
  private nextTimeCheckAt: number;
  private timeChecks = 0;
  /** A look thought the work was solved: quiet looks stop, but the check when the student finishes still runs. */
  private solved = false;
  /** The check of the finished answer said it is right: nothing more to ask about this problem. */
  private confirmed = false;
  private lastReason: CallReason | null = null;
  /** A reading wants another look once the student is still (see `requestSettledRead`). */
  private settleRead = false;

  constructor(private startedAt: number, private cfg: GateConfig = DEFAULT_GATE) {
    this.nextTimeCheckAt = startedAt + cfg.firstCheckpointMs;
  }

  /** Seconds-resolution of how long the student has been still, in ms (null before they have written anything). */
  idleMs(now: number): number | null {
    return this.lastInkAt ? Math.max(0, now - this.lastInkAt) : null;
  }

  /**
   * A reading thinks the problem was copied wrongly but the student may still be writing it: look again once they have been still for a
   * moment, whether or not they wrote anything new (a finished copy sits there unchanged, which would otherwise never be read again).
   */
  requestSettledRead(): void {
    this.settleRead = true;
  }

  /** When the student last wrote anything (0 before they have): a snapshot taken after this shows everything they wrote. */
  lastWriteAt(): number {
    return this.lastInkAt;
  }

  /** Something new has been written since the last read, and the student has been still for at least `minIdleMs`: a line is about to be read. */
  lineWaiting(now: number, minIdleMs: number): boolean {
    return this.lastInkAt > 0 && (this.input >= this.cfg.lineMinInput || this.ink >= this.cfg.inkMin) && now - this.lastInkAt >= minIdleMs;
  }

  /**
   * How long until a rule that depends only on the clock (a line settling, a settled look being due) can fire, or null when none is
   * waiting. The monitor wakes itself up then, instead of waiting for the next page signal (which can be a second away).
   */
  nextWakeMs(now: number): number | null {
    if (this.inFlight || this.confirmed || this.solved || !this.lastInkAt) return null;
    const idle = now - this.lastInkAt;
    const gap = this.lastCallAt + this.cfg.minReadGapMs - now;
    const waits: number[] = [];
    if (this.input >= this.cfg.lineMinInput || this.ink >= this.cfg.inkMin) waits.push(Math.max(this.cfg.lineSettleMs - idle, gap));
    if (this.settleRead) waits.push(Math.max(this.cfg.settleReadMs - idle, gap));
    return waits.length ? Math.max(20, Math.ceil(Math.min(...waits))) : null;
  }

  /** Enough new work since the last check of the answer to be worth checking: a chunk, not a stray keystroke. */
  private hasWorkToCheck(): boolean {
    return this.checkInk >= this.cfg.inkBurst || this.checkInput >= this.cfg.inputBurst;
  }

  /** True once the answer was checked and the student hasn't done anything worth checking since. */
  checkedSinceLastWork(): boolean {
    return this.confirmed || (this.checks > 0 && this.checkInk < this.cfg.inkMin && this.checkInput < this.cfg.inputMin);
  }

  /**
   * What the student typed or drew just before myTA started following the problem still counts as work to check (it starts
   * following a few seconds after they settle on the problem, and a short answer may already be written by then).
   */
  seedWork(input: number): void {
    this.checkInput += Math.max(0, input);
  }

  /** The answer was checked some other way (the student asked): don't check the same work again by itself. */
  noteCheck(): void {
    this.checkInk = 0;
    this.checkInput = 0;
    this.checks++;
  }

  private gapMs(reason: CallReason): number {
    const grown = Math.min(this.cfg.maxGapMs, this.cfg.baseGapMs * 2 ** this.backoff);
    return reason === 'wrong-answer' ? Math.min(grown, this.cfg.wrongAnswerGapMs * 2 ** Math.min(this.backoff, 2)) : grown;
  }

  /** Feed one tick. Returns why to look now, or null. */
  push(i: GateInput): { reason: CallReason; detail: string } | null {
    if (i.workChanged > NOISE_FRACTION) {
      this.ink += i.workChanged;
      this.checkInk += i.workChanged;
      this.lastInkAt = i.now;
    }
    if ((i.workInput ?? 0) > 0) {
      this.input += i.workInput!;
      this.checkInput += i.workInput!;
      this.lastInkAt = i.now;
    }
    if (i.newIncorrect > 0) {
      this.noteWrongAnswer();
      if (this.incorrectAt === 0) this.incorrectAt = i.now;
      // The homework page has the last word. A quiet look that guessed "solved" is overruled when the page says the answer is wrong
      // (what the page confirmed itself, or the finished check confirmed, is not: leftover "incorrect" text must not undo that).
      if (this.solved && !this.confirmed) this.solved = false;
    }

    if (i.score !== null && this.baseScore === null) this.baseScore = i.score;

    if (this.inFlight || this.confirmed) return null;
    this.callTimes = this.callTimes.filter((t) => i.now - t < this.cfg.budget.windowMs);
    // Past the quiet-look cap only the steady reasons (progress, wrong answer, finished) go on; they have their own larger cap.
    const quietLooksLeft = this.callTimes.length < this.cfg.budget.max;
    if (this.callTimes.length >= this.cfg.steadyBudget) return null;

    const sinceLast = i.now - this.lastCallAt;
    const hasWork = this.ink >= this.cfg.inkMin || this.input >= this.cfg.inputMin;
    const calm = !!i.finish && i.score !== null && i.score <= i.finish.calmBelow;

    // Finished: wrote a chunk, then nothing new for the idle time, and the score is low. Not held back by the doubling gap,
    // and still allowed after a quiet look thought the work was solved (that look was a guess; this is the real check).
    const idleMs = i.now - this.lastInkAt;
    const finished =
      calm && this.hasWorkToCheck() && idleMs >= i.finish!.idleMs && i.now - this.startedAt >= this.cfg.minSessionMs && sinceLast >= this.cfg.finishGapMs;
    if (this.solved) {
      return finished ? { reason: 'finished', detail: `no new work for ${Math.round(idleMs / 1000)}s and the confusion score is low (${i.score})` } : null;
    }

    // Spaced from the last CHECK, not from any look: the routine readings every few seconds must not hold back a wrong answer.
    if (this.incorrectAt && i.now - this.incorrectAt >= this.cfg.settleMs && i.now - this.lastCheckAt >= this.gapMs('wrong-answer')) {
      return { reason: 'wrong-answer', detail: 'the homework page just said the answer was wrong' };
    }
    if (finished) return { reason: 'finished', detail: `no new work for ${Math.round(idleMs / 1000)}s and the confusion score is low (${i.score})` };
    if (i.progress && this.lastInkAt) {
      // A reading suspected a wrongly copied problem while the student may still have been writing it: look again once they are still.
      if (this.settleRead && idleMs >= this.cfg.settleReadMs && sinceLast >= this.cfg.minReadGapMs) {
        this.settleRead = false;
        return { reason: 'progress', detail: 'you have stopped: making sure the problem was copied the way it is written' };
      }
      // A line is finished: something new was written and then the student went still. Read it now, not at the next periodic read.
      const wroteSome = this.input >= this.cfg.lineMinInput || this.ink >= this.cfg.inkMin;
      if (wroteSome && idleMs >= this.cfg.lineSettleMs && sinceLast >= this.cfg.minReadGapMs) {
        return { reason: 'progress', detail: 'you finished a line: reading it' };
      }
    }
    // Following along: new work on screen since the last read, and the reading interval has passed. Not slowed by earlier
    // reads that found nothing; one at a time is what keeps it affordable.
    if (i.progress && hasWork && sinceLast >= i.progress.everyMs) {
      return { reason: 'progress', detail: 'you are writing: reading what is new' };
    }
    if (!quietLooksLeft || sinceLast < this.gapMs('confusion-rise')) return null;

    if (hasWork && i.score !== null) {
      const base = this.scoreAtCall ?? this.baseScore ?? i.score;
      if (i.score - base >= this.cfg.riseDelta) return { reason: 'confusion-rise', detail: `confusion rose from ${Math.round(base)} to ${i.score}` };
      if (i.score >= this.cfg.highScore && base < this.cfg.highScore) return { reason: 'confusion-rise', detail: `confusion reached ${i.score}` };
    }
    if (hasWork && i.now >= this.nextTimeCheckAt) {
      return { reason: 'time-on-problem', detail: 'a while on this problem, and the work has changed' };
    }
    // A calm pause is the "finished" case above (which makes its own, fuller look a few seconds later), so don't spend a
    // quiet look on it too. A pause while the score is not low is the student stuck mid-way, and still gets its look.
    if (!calm && (this.ink >= this.cfg.inkBurst || this.input >= this.cfg.inputBurst) && i.now - this.lastInkAt >= this.cfg.pauseMs) {
      return { reason: 'work-pause', detail: 'the student paused after writing a chunk' };
    }
    return null;
  }

  /** The caller is making the call now: new work and unchecked wrong answers start counting from zero. */
  callStarted(now: number, reason: CallReason, score: number | null): void {
    this.inFlight = true;
    this.lastCallAt = now;
    this.lastReason = reason;
    this.callTimes.push(now);
    this.ink = 0;
    this.input = 0;
    // Only the check of a wrong answer settles it. A routine reading that happens to start while the page's "incorrect" is still
    // settling must not swallow it (it did, which is how a wrong answer could produce nothing at all while the student was writing).
    if (reason === 'wrong-answer') this.incorrectAt = 0;
    if (reason === 'wrong-answer' || reason === 'finished') {
      this.lastCheckAt = now;
      this.settleRead = false; // a full check of the answer (on a fresh snapshot) is the settled look
    }
    if (score !== null) this.scoreAtCall = score;
    // Both of these are a real check of the answer (the page said it was wrong, or the student stopped): the same work isn't checked again.
    if (reason === 'finished' || reason === 'wrong-answer') this.noteCheck();
    if (reason === 'time-on-problem') this.timeChecks++;
    this.nextTimeCheckAt = now + Math.min(this.cfg.maxCheckpointMs, this.cfg.firstCheckpointMs * 2 ** this.timeChecks);
  }

  /** The homework page itself said the answer is correct: nothing left to ask the model. */
  markSolvedByPage(): void {
    this.solved = true;
    this.confirmed = true;
    this.noteCheck();
  }

  /** The look finished. Looks that find nothing space the next one out; a mistake or new wrong answer resets that. */
  callFinished(outcome: CallOutcome): void {
    this.inFlight = false;
    if (outcome === 'mistake') {
      this.backoff = 0;
      this.solved = false; // a mistake found after a look thought it was solved: the student isn't done
      this.confirmed = false;
    } else if (outcome === 'solved') {
      this.solved = true;
      if (this.lastReason === 'finished') this.confirmed = true;
    } else this.backoff = Math.min(3, this.backoff + 1);
  }

  /** A new wrong answer shows the student is still struggling, so stop spacing looks out. */
  private noteWrongAnswer(): void {
    this.backoff = 0;
  }

  state(now: number): GateState {
    const callsInWindow = this.callTimes.filter((t) => now - t < this.cfg.budget.windowMs).length;
    const nextAllowedAt = this.lastCallAt ? this.lastCallAt + Math.min(this.cfg.maxGapMs, this.cfg.baseGapMs * 2 ** this.backoff) : 0;
    return {
      inFlight: this.inFlight,
      pendingWork: this.ink,
      pendingInput: this.input,
      finishWork: this.hasWorkToCheck(),
      idleSec: this.lastInkAt ? Math.max(0, Math.floor((now - this.lastInkAt) / 1000)) : null,
      nextAllowedAt,
      backoff: this.backoff,
      callsInWindow,
      solved: this.solved || this.confirmed,
    };
  }
}
