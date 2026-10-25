// Strict JSON Schemas for OpenAI structured outputs (all properties required, no extras). Every call uses one.
const str = { type: 'string' };
const strArr = { type: 'array', items: str };
const obj = (properties: Record<string, object>, required = Object.keys(properties)) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

export const SOLVER_SCHEMA = obj({
  problemDetected: { type: 'boolean' },
  problemText: str,
  finalAnswer: str,
  keySteps: strArr,
  conceptTags: strArr,
  misconceptions: strArr,
  answerKeyPhrases: strArr,
  studentWork: str,
});

export const TUTOR_SCHEMA = obj({
  replyAssessment: { type: 'string', enum: ['correct', 'partial', 'misconception', 'dont_know', 'none'] },
  hintLevel: { type: 'integer' },
  message: str,
  suggestions: strArr,
  missingPrerequisite: str,
});

export const JUDGE_SCHEMA = obj({ leaks: { type: 'boolean' }, reason: str });

export const GRADE_SCHEMA = obj({ understood: { type: 'boolean' }, feedback: str });

export const CONCEPT_SCHEMA = obj({ concept: str, query: str });

export const VIDEO_PICK_SCHEMA = obj({
  index: { type: 'integer' },
  startSec: { type: 'integer' },
  endSec: { type: 'integer' },
  why: str,
});
