// Gemini responseSchema definitions (OpenAPI subset). Every call uses one.
const str = { type: 'STRING' };
const strArr = { type: 'ARRAY', items: str };
const obj = (properties: Record<string, object>, required = Object.keys(properties)) => ({
  type: 'OBJECT',
  properties,
  required,
  propertyOrdering: Object.keys(properties),
});

export const SOLVER_SCHEMA = obj({
  problemDetected: { type: 'BOOLEAN' },
  problemText: str,
  finalAnswer: str,
  keySteps: strArr,
  conceptTags: strArr,
  misconceptions: strArr,
  answerKeyPhrases: strArr,
});

export const TUTOR_SCHEMA = obj({
  replyAssessment: { type: 'STRING', enum: ['correct', 'partial', 'misconception', 'dont_know', 'none'] },
  hintLevel: { type: 'INTEGER' },
  message: str,
  missingPrerequisite: str,
});

export const JUDGE_SCHEMA = obj({ leaks: { type: 'BOOLEAN' }, reason: str });

export const GRADE_SCHEMA = obj({ understood: { type: 'BOOLEAN' }, feedback: str });

export const CONCEPT_SCHEMA = obj({ concept: str, query: str });

export const VIDEO_SCHEMA = obj({
  relevance: { type: 'NUMBER' },
  startSec: { type: 'INTEGER' },
  endSec: { type: 'INTEGER' },
  why: str,
  showsSolutionToProblem: { type: 'BOOLEAN' },
});

export const VIDEO_PICK_SCHEMA = obj({
  index: { type: 'INTEGER' },
  startSec: { type: 'INTEGER' },
  endSec: { type: 'INTEGER' },
  why: str,
});
