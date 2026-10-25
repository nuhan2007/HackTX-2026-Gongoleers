// What to do with each reading of the student's work: flag a mistake on the sprite, cheer, or take down a message that no longer
// applies. Pure, so every rule is unit-tested. (The reading itself is a model call; this only decides what it means for the sprite.)
import { COPY_IDLE_MS, COPY_READS_TO_FLAG, UNSURE_READS_TO_FLAG } from '../shared/constants';
import type { NudgeKind } from '../shared/messages';
import type { Readability, WorkStatus } from '../shared/types';

export interface ReadFacts {
  status: WorkStatus;
  /** How well the model could read the handwriting. */
  readability?: Readability | null;
  /** Readings in a row that found a mistake, counting this one (0 when this one didn't). */
  mistakeStreak: number;
  /** This reading says the problem was copied down wrongly (and that the copy is finished). */
  copyWrong?: boolean;
  /** Readings in a row, counting this one, that said so (0 when this one didn't). */
  copyStreak?: number;
  /** How long the student had been still when the snapshot of this reading was taken (null when unknown). */
  idleMs?: number | null;
  /** What the sprite is saying right now. */
  sprite: NudgeKind | null;
  /** Where the mistake on the sprite came from, when it is one. */
  spriteOrigin: 'read' | 'check' | 'page' | null;
  now: number;
  /** The student dismissed a flag: no new one from a reading before this. */
  reflagAfter: number;
  flagMistakes: boolean;
  /** The student has already been congratulated on this problem. */
  celebrated: boolean;
}

export type ReadAction =
  /** Tell the student, on the sprite, that a mistake was found. */
  | 'flag'
  /** The answer is right: congratulate them. */
  | 'cheer'
  /** A mistake that a reading flagged is fixed: take the message down. */
  | 'clear'
  /** Looks like a wrong copy, but the student may still be writing it: don't say anything yet, look again once they are still. */
  | 'settle'
  | 'none';

/**
 * A mistake found by any reading is flagged at once when the model could read the handwriting clearly; when it could not, it takes two
 * readings in a row to agree (so one misread scribble doesn't cry wolf). It is not flagged on top of a message about a mistake or a
 * cheer that is already up, and not again right after the student dismissed one.
 *
 * A problem copied down wrongly is different: a half-written copy always differs from the whole problem, so it is only called out
 * once the student has FINISHED writing it: the reading must say the copy is complete, a second one must agree, and the student must
 * have been still when it was taken. Until then the answer is 'settle'.
 */
export function decideRead(f: ReadFacts): ReadAction {
  if (f.status === 'possible_mistake') {
    if (!f.flagMistakes) return 'none';
    if (f.sprite === 'mistake' || f.sprite === 'cheer' || f.now < f.reflagAfter) return 'none';
    if (f.copyWrong) {
      const finished = (f.copyStreak ?? 0) >= COPY_READS_TO_FLAG && f.idleMs != null && f.idleMs >= COPY_IDLE_MS;
      return finished ? 'flag' : 'settle';
    }
    const sure = f.readability === 'clear' || f.mistakeStreak >= UNSURE_READS_TO_FLAG;
    return sure ? 'flag' : 'none';
  }
  if (f.status === 'solved') return f.celebrated ? 'none' : 'cheer';
  if (f.status === 'on_track' && f.sprite === 'mistake' && f.spriteOrigin === 'read') return 'clear';
  return 'none';
}

/** Is it worth asking for a message with the reading (the leak guard costs one more call)? Only when something could be shown. */
export function wantsMessage(f: Pick<ReadFacts, 'sprite' | 'now' | 'reflagAfter' | 'flagMistakes' | 'celebrated'> & { celebrate: boolean }): boolean {
  const flagOk = f.flagMistakes && f.sprite !== 'mistake' && f.sprite !== 'cheer' && f.now >= f.reflagAfter;
  const cheerOk = f.celebrate && !f.celebrated;
  return flagOk || cheerOk;
}
