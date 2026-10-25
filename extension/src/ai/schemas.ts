// JSON Schemas for Gemini structured output: lowercase types, every property required, objects allow nothing else.
// Gemini returns keys in the order the schema lists them, so the order is deliberate: what the model has to work out
// first (reading the handwriting, the diagram) comes before the verdicts that depend on it.
const str = { type: 'string' };
const strArr = { type: 'array', items: str };
const obj = (properties: Record<string, object>) => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const oneOf = (...values: string[]) => ({ type: 'string', enum: values });

export const DOMAINS = ['algebra', 'calculus', 'geometry', 'statistics', 'physics', 'circuits', 'chemistry', 'linear_algebra', 'programming', 'logic', 'other'] as const;
export const WORK_FORMATS = ['equations', 'diagram', 'code', 'text', 'mixed'] as const;

export const SOLVER_SCHEMA = obj({
  problemDetected: { type: 'boolean' },
  problemText: str,
  givens: str,
  domain: oneOf(...DOMAINS),
  problemKind: str,
  workFormat: oneOf(...WORK_FORMATS),
  difficulty: { type: 'integer' },
  expectedMinutes: { type: 'integer' },
  keySteps: strArr,
  checkpoints: { type: 'array', items: obj({ label: str, expected: str }) },
  finalAnswer: str,
  verification: str,
  keyConfidence: oneOf('high', 'medium', 'low'),
  conceptTags: strArr,
  misconceptions: strArr,
  answerKeyPhrases: strArr,
});

export const TUTOR_SCHEMA = obj({
  replyAssessment: oneOf('correct', 'partial', 'misconception', 'dont_know', 'none'),
  hintLevel: { type: 'integer' },
  message: str,
  missingPrerequisite: str,
});

export const WORK_SCHEMA = obj({
  differentProblem: { type: 'boolean' },
  readability: oneOf('clear', 'hard_to_read', 'nothing_written'),
  workRead: str,
  copyState: oneOf('not_copied', 'in_progress', 'complete'),
  copiedWrong: { type: 'boolean' },
  observation: str,
  status: oneOf('no_work', 'on_track', 'mistake', 'solved', 'unclear'),
  box: { type: 'array', items: { type: 'integer' } },
  studentMessage: str,
});

export const JUDGE_SCHEMA = obj({ leaks: { type: 'boolean' }, reason: str });

export const CONCEPT_SCHEMA = obj({ concept: str, query: str });

export const VIDEO_PICK_SCHEMA = obj({
  index: { type: 'integer' },
  startSec: { type: 'integer' },
  endSec: { type: 'integer' },
  why: str,
});

/** What Gemini says after watching a video: where the concept is explained, as clock times ("2:14"). */
export const VIDEO_MOMENT_SCHEMA = obj({
  explainsIt: { type: 'boolean' },
  start: str,
  end: str,
  why: str,
});

/** Used by the key check: the smallest valid call. */
export const PING_SCHEMA = obj({ ok: { type: 'boolean' } });
