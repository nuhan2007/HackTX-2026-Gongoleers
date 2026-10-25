import type { ChatMessage, SolverResult } from '../shared/types';
import { generateJson, type OpenAICtx } from './openaiClient';
import { CONCEPT_SYSTEM } from './prompts';
import { CONCEPT_SCHEMA } from './schemas';

/** Names the missing concept and a concept-level search query (never the problem itself). */
export async function missingConcept(
  ctx: OpenAICtx,
  hidden: SolverResult,
  history: ChatMessage[],
  hint: string,
): Promise<{ concept: string; query: string }> {
  const fallbackConcept = hint || hidden.conceptTags[0] || 'problem solving strategy';
  let r: { concept: string; query: string };
  try {
    r = await generateJson(ctx, {
      system: CONCEPT_SYSTEM,
      parts: [
        {
          text: `Concept tags from the answer key: ${hidden.conceptTags.join(', ')}\nTutor's guess at the missing prerequisite: ${hint || '(none)'}\nRecent conversation:\n${history
            .slice(-6)
            .map((m) => `${m.role}: ${m.text}`)
            .join('\n')}`,
        },
      ],
      schema: CONCEPT_SCHEMA,
      temperature: 0.2,
      timeoutMs: 20_000,
    });
  } catch {
    r = { concept: fallbackConcept, query: `${fallbackConcept} explained` };
  }
  const concept = (r.concept || fallbackConcept).trim();
  const query = !r.query || quotesProblem(r.query, hidden.problemText) ? `${concept} explained` : r.query.trim();
  return { concept, query };
}

/** True if the query shares any 5-word run with the problem text (i.e. it's searching for the exact problem). */
export function quotesProblem(query: string, problemText: string): boolean {
  const words = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  const p = words(problemText);
  const q = ` ${words(query).join(' ')} `;
  for (let i = 0; i + 5 <= p.length; i++) if (q.includes(` ${p.slice(i, i + 5).join(' ')} `)) return true;
  return false;
}
