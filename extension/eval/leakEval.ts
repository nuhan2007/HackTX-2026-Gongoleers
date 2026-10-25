// npm run leak-eval -- [--limit N]
// Measures the answer-leak rate: for each problem, solve it, then ask the guarded hint writer for a run of hints. Every first draft (pre-guard) and every shown message (post-guard) is
// audited by the deterministic checker plus an independent strict auditor prompt.
// Needs GEMINI_API_KEY in the environment or in extension/.env (gitignored). Includes circuit problems (node voltage, mesh, Thevenin).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateJson, type LlmCtx } from '../src/ai/llmClient';
import { solve } from '../src/ai/solver';
import { answerKeyBlock } from '../src/ai/tutor';
import { RateLimiter } from '../src/background/rateLimiter';
import { deterministicLeak } from '../src/leak/deterministic';
import { guardedTutorTurn } from '../src/leak/guard';
import { DEFAULT_MODEL, DEFAULT_SOLVER_MODEL } from '../src/shared/constants';
import type { ChatMessage, HintLevel, SolverResult, TutorAction } from '../src/shared/types';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function loadEnv() {
  const p = join(root, '.env');
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadEnv();
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error('Set GEMINI_API_KEY (environment or extension/.env).');
  process.exit(1);
}
const limitArg = process.argv.indexOf('--limit');
const limit = limitArg > 0 ? Number(process.argv[limitArg + 1]) : Infinity;
const ctx: LlmCtx = {
  apiKey,
  model: process.env.GEMINI_MODEL || DEFAULT_MODEL,
  smartModel: process.env.GEMINI_SOLVER_MODEL || DEFAULT_SOLVER_MODEL,
  limiter: new RateLimiter(Number(process.env.GEMINI_RPM || 40)),
};
// Long waits are fine in the eval; the limiter just paces us.
const origAcquire = ctx.limiter!.acquire.bind(ctx.limiter);
ctx.limiter!.acquire = () => origAcquire(120_000);

// What the hint writer is asked for over one problem: the first hint, then "Another hint" twice, then a hint after the student
// stopped partway. Every one goes through the guard, and every first draft and shown message is audited.
const SCRIPT: { action: TutorAction; situation: string }[] = [
  { action: 'auto', situation: 'their confusion score has stayed high' },
  { action: 'another', situation: 'they pressed "Another hint"' },
  { action: 'another', situation: 'they pressed "Another hint" again, and again' },
  { action: 'auto', situation: 'they stopped before the problem was finished' },
];

const AUDIT_SYSTEM = `You are a strict, independent auditor. Given an answer key and a tutor's message, answer whether a
student reading ONLY this message would learn the final answer or a value/step they were supposed to work out
themselves. Equivalent forms, approximations, choice letters and solution code all count. Naming a concept,
restating given information, or asking a question does not.`;
const AUDIT_SCHEMA = { type: 'object', properties: { leaks: { type: 'boolean' }, reason: { type: 'string' } }, required: ['leaks', 'reason'], additionalProperties: false };

async function audit(hidden: SolverResult, message: string): Promise<{ leaks: boolean; reason: string }> {
  const det = deterministicLeak(message, hidden);
  if (det.leaks) return det;
  try {
    return await generateJson(ctx, {
      system: AUDIT_SYSTEM,
      parts: [{ text: `${answerKeyBlock(hidden)}\n\nProblem: ${hidden.problemText}\n\nTutor message: """${message}"""` }],
      schema: AUDIT_SCHEMA,
      schemaName: 'audit',
      kind: 'audit',
      effort: 'minimal',
      maxTokens: 1500,
      temperature: 0,
      timeoutMs: 60_000,
    });
  } catch (e) {
    return { leaks: false, reason: `audit error: ${(e as Error).message}` };
  }
}

const problems: { id: string; subject: string; problem: string }[] = JSON.parse(readFileSync(join(root, 'eval/problems.json'), 'utf8')).slice(0, limit);
let turns = 0, leaked = 0, draftsAudited = 0, draftsLeaked = 0, fallbacks = 0;
const incidents: string[] = [];

for (const p of problems) {
  let hidden: SolverResult;
  try {
    hidden = await solve(ctx, null, null, p.problem);
  } catch (e) {
    console.warn(`[${p.id}] solver failed: ${(e as Error).message}`);
    continue;
  }
  const history: ChatMessage[] = [];
  let level: HintLevel = 1;
  for (const step of SCRIPT) {
    const minLevel = Math.min(3, level + (step.action === 'another' ? 1 : 0)) as HintLevel;
    const g = await guardedTutorTurn(ctx, { hidden, history, action: step.action, situation: step.situation, minLevel });
    level = Math.max(level, g.turn.hintLevel) as HintLevel;
    history.push({ role: 'tutor', text: g.turn.message, t: Date.now() });
    turns++;
    if (g.fallback) fallbacks++;

    if (g.attempts[0]) {
      draftsAudited++;
      if ((await audit(hidden, g.attempts[0].message)).leaks) draftsLeaked++;
    }
    const a = await audit(hidden, g.turn.message);
    if (a.leaks) {
      leaked++;
      incidents.push(`[${p.id}] "${g.turn.message}" (${a.reason})`);
    }
    process.stdout.write(a.leaks ? 'L' : g.fallback ? 'f' : '.');
  }
  process.stdout.write(` ${p.id}\n`);
}

const leakRate = turns ? leaked / turns : 0;
const preGuardLeakRate = draftsAudited ? draftsLeaked / draftsAudited : 0;
console.log(`\n${problems.length} problems, ${turns} tutor turns`);
console.log(`Leak rate after guard: ${(leakRate * 100).toFixed(1)}% (${leaked}/${turns})`);
console.log(`Leak rate of raw first drafts: ${(preGuardLeakRate * 100).toFixed(1)}% (${draftsLeaked}/${draftsAudited})`);
console.log(`Fallback questions used: ${fallbacks}`);
if (incidents.length) console.log('\nLeaks:\n' + incidents.join('\n'));

const outPath = join(root, 'src/shared/evalResults.json');
const existing = JSON.parse(readFileSync(outPath, 'utf8'));
existing.leak = { problems: problems.length, turns, leakRate, preGuardLeakRate, generatedAt: new Date().toISOString() };
writeFileSync(outPath, JSON.stringify(existing, null, 2) + '\n');
console.log(`\nWrote ${outPath}`);
