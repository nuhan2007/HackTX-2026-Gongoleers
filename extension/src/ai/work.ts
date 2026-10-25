// Call 3: look at the student's work against the private answer key.
// Periodic reviews only produce private notes for the tutor; a final review also writes the
// message the student sees (which still goes through the leak guard).
//
// The student may work in a different tab from the problem. Image 1 is always where the work is; a
// second image, when attached, is the problem tab.
import type { PageContext } from '../shared/messages';
import type { Box, CopyState, Readability, SolverResult } from '../shared/types';
import { generateJson, type LlmCtx, type Part } from './llmClient';
import { WORK_SYSTEM } from './prompts';
import { WORK_SCHEMA } from './schemas';
import { answerKeyBlock } from './tutor';

export type ReviewStatus = 'no_work' | 'on_track' | 'mistake' | 'solved' | 'unclear';

export interface WorkReview {
  status: ReviewStatus;
  differentProblem: boolean;
  /**
   * The student copied the problem onto their work, finished writing it, and it differs from the real one. Always comes with status
   * "mistake". Never true while the copy is still being written (a half-written copy always differs from the whole problem).
   */
  copiedWrong: boolean;
  /** How far the student is with copying the problem down. */
  copyState: CopyState;
  /** Private: may name the mistake. */
  observation: string;
  studentMessage: string;
  box: Box | null;
  /** The student's own writing as the model read it, and how well it could read it. */
  workRead: string;
  readability: Readability;
}

export interface ReviewArgs {
  hidden: SolverResult;
  /** Base64 JPEG of the tab where the student's work is (image 1; the box refers to this one). */
  workImage: string;
  /** Base64 JPEG of the problem tab, when it is a different tab from the work. */
  problemImage?: string;
  /**
   * The work is in a different tab from the problem. With no `problemImage` that means the problem tab is unchanged since the
   * model last saw it, so it isn't attached again. Defaults to whether there is a `problemImage`.
   */
  separateTabs?: boolean;
  /** Visible text of the problem tab (the homework page's own feedback, e.g. "Incorrect"). */
  problemContext: PageContext | null;
  /** Visible text of the work tab, when it has any (canvas apps like Google Docs have none). */
  workContext?: PageContext | null;
  /** The previous private observation, so the reviewer can tell whether a mistake was fixed. */
  previous: string;
  /** True when the student has finished (or says they're done and moving on). */
  final: boolean;
  /** Why the monitor asked now, e.g. "the homework page just said Incorrect". Context only. */
  why?: string;
  /** Seconds since the student last wrote anything when the snapshot was taken (a line was just finished when this is small). */
  idleSec?: number | null;
  /** Set when the previous draft of the student message was rejected by the leak guard. */
  leakFeedback?: string;
}

const STATUSES: ReviewStatus[] = ['no_work', 'on_track', 'mistake', 'solved', 'unclear'];
const READABILITY: Readability[] = ['clear', 'hard_to_read', 'nothing_written'];
const COPY_STATES: CopyState[] = ['not_copied', 'in_progress', 'complete'];
const MAX_READ_CHARS = 240;

/** Accepts the model's [ymin, xmin, ymax, xmax] (0..1000); drops boxes that are malformed, tiny, or cover nearly everything. */
export function normalizeBox(raw: unknown): Box | null {
  if (!Array.isArray(raw) || raw.length !== 4) return null;
  const n = raw.map((v) => Math.round(Math.min(1000, Math.max(0, Number(v)))));
  if (n.some((v) => !Number.isFinite(v))) return null;
  const [y0, x0, y1, x1] = n;
  if (y1 - y0 < 5 || x1 - x0 < 5) return null;
  if ((y1 - y0) * (x1 - x0) > 0.9 * 1000 * 1000) return null;
  return [y0, x0, y1, x1];
}

export function normalizeReview(r: Partial<Record<keyof WorkReview, unknown>>): WorkReview {
  const status = STATUSES.includes(r.status as ReviewStatus) ? (r.status as ReviewStatus) : 'unclear';
  const differentProblem = r.differentProblem === true;
  // A copy can only be wrong once it is finished. Without the model saying so, it isn't.
  const copyState: CopyState = COPY_STATES.includes(r.copyState as CopyState) ? (r.copyState as CopyState) : 'not_copied';
  const copiedWrong = r.copiedWrong === true && copyState === 'complete' && !differentProblem;
  const workRead = typeof r.workRead === 'string' ? r.workRead.replace(/\s+/g, ' ').trim().slice(0, MAX_READ_CHARS) : '';
  let readability: Readability = READABILITY.includes(r.readability as Readability) ? (r.readability as Readability) : workRead ? 'clear' : 'nothing_written';
  // The two fields must agree: no transcription can't be "clear", and a transcription can't be "nothing written".
  if (!workRead && readability === 'clear') readability = 'nothing_written';
  if (workRead && readability === 'nothing_written') readability = 'hard_to_read';
  // A mistake the model blamed only on a copy that is still being written isn't one.
  const unfinishedCopyOnly = r.copiedWrong === true && copyState !== 'complete' && status === 'mistake';
  const effective: ReviewStatus = unfinishedCopyOnly ? 'on_track' : status;
  return {
    // A wrong copy of the problem is a mistake, whatever else the model said about the status.
    status: differentProblem ? 'unclear' : copiedWrong ? 'mistake' : effective,
    differentProblem,
    copiedWrong,
    copyState,
    observation: typeof r.observation === 'string' ? r.observation.trim() : '',
    studentMessage: typeof r.studentMessage === 'string' ? r.studentMessage.trim() : '',
    box: (effective === 'mistake' || copiedWrong) && !differentProblem ? normalizeBox(r.box) : null,
    workRead,
    readability,
  };
}

const clip = (s: string | undefined, n: number) => (s ?? '').slice(0, n);

export async function reviewWork(ctx: LlmCtx, a: ReviewArgs): Promise<WorkReview> {
  const separate = a.separateTabs ?? !!a.problemImage;
  // Static per session first (cache-friendly), then the images, then what changes every call.
  const fixed = [answerKeyBlock(a.hidden), `Problem (from the answer key):\n${a.hidden.problemText}`].join('\n\n');
  const lineDone = a.idleSec != null && a.idleSec >= 1 && a.idleSec < 6 && !a.final;
  const changing = [
    `Mode: ${a.final ? 'FINAL (the student has finished this problem, or says they are moving on)' : 'PERIODIC (a quick look while they work)'}`,
    a.why && `Why you are being asked now: ${a.why}`,
    a.idleSec != null &&
      (lineDone
        ? `The student stopped writing ${a.idleSec} s before this snapshot: a line has just been finished. Judge it, and the lines before it. (Do not call a copy of the problem wrong unless it is complete.)`
        : a.idleSec === 0
          ? 'The student is writing right now: the last line may be unfinished.'
          : ''),
    separate && !a.problemImage && 'The student works in a different tab from the problem. The problem tab has not changed since you last saw it, so its screenshot is not attached again; the problem is in the answer key above.',
    `Your previous private observation: ${a.previous || '(none)'}`,
    a.problemContext?.viewportText && `Visible text of the problem tab, including what is typed in its fields:\n${clip(a.problemContext.viewportText, 2500)}`,
    a.workContext?.viewportText && `Visible text of the work tab:\n${clip(a.workContext.viewportText, 2500)}`,
    a.leakFeedback && `Your previous studentMessage was REJECTED because it leaked: ${a.leakFeedback}. Point to where the mistake is without saying what the right answer or step is.`,
  ]
    .filter(Boolean)
    .join('\n\n');

  const parts: Part[] = [
    { text: fixed },
    { text: separate ? 'IMAGE 1: the WORK tab (the box refers to this image).' : 'IMAGE 1: the page where the student works (the problem is on it too; the box refers to this image).' },
    { image: a.workImage },
  ];
  if (a.problemImage) parts.push({ text: 'IMAGE 2: the PROBLEM tab.' }, { image: a.problemImage });
  parts.push({ text: changing });

  const hard = (a.hidden.difficulty ?? 3) >= 4 || a.hidden.workFormat === 'diagram' || a.hidden.workFormat === 'mixed';
  const r = await generateJson<Partial<Record<keyof WorkReview, unknown>>>(ctx, {
    system: WORK_SYSTEM,
    parts,
    schema: WORK_SCHEMA,
    schemaName: 'work_review',
    kind: a.final ? 'check-work' : 'review',
    // The quick reads while they write think least, so a flagged line shows up a couple of seconds after it was written. A final
    // check, and a hard or drawn problem (where each step has to be recomputed), get a little more thinking.
    effort: a.final ? 'medium' : hard ? 'low' : 'minimal',
    maxTokens: 4000,
    temperature: 0.2,
    timeoutMs: a.final ? 60_000 : 45_000,
  });
  return normalizeReview(r);
}
