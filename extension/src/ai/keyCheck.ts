// "Do my keys actually work?" checks for the options page. Neither check spends meaningful quota:
// Gemini gets the free model-list call plus one tiny structured call (through the same client the tutor uses, so unsupported
// parameters show up here and not mid-session), and SerpApi's account endpoint is free and not counted as a search.
import { GEMINI_BASE, generateJson, LlmError } from './llmClient';
import { PING_SCHEMA } from './schemas';

export interface KeyCheck {
  ok: boolean;
  /** One line for the student: what worked or what to fix. */
  detail: string;
  checkedAt: number;
  /** Last characters of the key that was tested, so a changed key shows as untested again. */
  fingerprint: string;
  /** A working model to use instead, when the configured one isn't available. */
  suggestedModel?: string;
  /** Same for the model that works each problem out. */
  suggestedSolverModel?: string;
}

export interface KeyStatus {
  gemini?: KeyCheck;
  serp?: KeyCheck;
}

export const KEY_STATUS_STORAGE = 'keyStatus';
export const fingerprint = (key: string) => key.slice(-6);

type Fetch = typeof fetch;

/** Models that take text and pictures and reply with text: everything that isn't an image, voice, embedding or specialist model. */
const NOT_TEXT_CHAT = /image|tts|audio|live|embed|robotics|computer|native|vision|nano|banana|veo|imagen|gemma|learnlm|aqa|dialog|search|deep-research|customtools|exp-\d/i;

interface Ranked {
  id: string;
  version: number;
  tier: 'flash' | 'lite' | 'pro';
  stable: boolean;
}

function rank(ids: string[]): Ranked[] {
  const out: Ranked[] = [];
  for (const raw of ids) {
    const id = raw.replace(/^models\//, '');
    if (!/^gemini-/.test(id) || NOT_TEXT_CHAT.test(id)) continue;
    const version = Number.parseFloat(id.match(/^gemini-(\d+(?:\.\d+)?)/)?.[1] ?? '');
    if (!Number.isFinite(version)) continue;
    const tier = /lite/.test(id) ? 'lite' : /flash/.test(id) ? 'flash' : /pro|argon/.test(id) ? 'pro' : null;
    if (!tier) continue;
    out.push({ id, version, tier, stable: !/preview|exp|latest/.test(id) });
  }
  return out;
}

const newest = (list: Ranked[]) => [...list].sort((a, b) => b.version - a.version || Number(b.stable) - Number(a.stable) || a.id.length - b.id.length)[0]?.id ?? null;

/** The quick model: the newest full flash model, else the newest flash-lite, else anything. */
export function pickFastModel(ids: string[]): string | null {
  const r = rank(ids);
  return newest(r.filter((x) => x.tier === 'flash')) ?? newest(r.filter((x) => x.tier === 'lite')) ?? newest(r);
}

/** The model that works problems out: the newest pro-class model, else the quick one. */
export function pickSolverModel(ids: string[]): string | null {
  const r = rank(ids);
  return newest(r.filter((x) => x.tier === 'pro')) ?? pickFastModel(ids);
}

/** Every model id a key can use, following pages of the list. */
async function listModels(apiKey: string, doFetch: Fetch): Promise<{ ids: string[] } | { error: string; status: number }> {
  const ids: string[] = [];
  let token = '';
  for (let page = 0; page < 5; page++) {
    const res = await doFetch(`${GEMINI_BASE}/models?pageSize=200${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`, {
      headers: { 'x-goog-api-key': apiKey },
      signal: AbortSignal.timeout(15_000),
    });
    const data = (await res.json().catch(() => null)) as { models?: { name: string; supportedGenerationMethods?: string[] }[]; nextPageToken?: string; error?: { message?: string } } | null;
    if (!res.ok) return { error: data?.error?.message ?? `HTTP ${res.status}`, status: res.status };
    for (const m of data?.models ?? []) if (!m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent')) ids.push(m.name);
    token = data?.nextPageToken ?? '';
    if (!token) break;
  }
  return { ids };
}

/** The ids of the models a key can use for generateContent, or null when they can't be listed. */
export async function listModelIds(apiKey: string, doFetch: Fetch = fetch): Promise<string[] | null> {
  try {
    const r = await listModels(apiKey, doFetch);
    return 'ids' in r ? r.ids.map((id) => id.replace(/^models\//, '')) : null;
  } catch {
    return null;
  }
}

export async function checkGemini(apiKey: string, model: string, solverModel: string, doFetch: Fetch = fetch): Promise<KeyCheck> {
  const base = { checkedAt: Date.now(), fingerprint: fingerprint(apiKey) };
  const fail = (detail: string, extra: Partial<KeyCheck> = {}): KeyCheck => ({ ...base, ok: false, detail, ...extra });
  if (!apiKey) return fail('No Gemini key entered.');

  let listed: Awaited<ReturnType<typeof listModels>>;
  try {
    listed = await listModels(apiKey, doFetch);
  } catch {
    return fail('Can\'t reach Gemini. Are you offline?');
  }
  if ('error' in listed) {
    const bad = listed.status === 400 || listed.status === 401 || listed.status === 403;
    return fail(bad ? `Gemini rejected this key: ${listed.error}` : `Gemini returned an error: ${listed.error}`);
  }
  const bare = (s: string) => s.replace(/^models\//, '');
  const have = new Set(listed.ids.map(bare));
  if (have.size && !have.has(bare(model))) {
    const suggestion = pickFastModel(listed.ids) ?? undefined;
    return fail(`The key works, but model "${model}" isn't available to it.${suggestion ? ` Try "${suggestion}".` : ''}`, { suggestedModel: suggestion });
  }

  try {
    await generateJson(
      { apiKey, model, fetchImpl: doFetch },
      { system: 'Reply with ok=true.', parts: [{ text: 'ping' }], schema: PING_SCHEMA, schemaName: 'ping', kind: 'ping', effort: 'minimal', maxTokens: 400, timeoutMs: 45_000 },
    );
  } catch (e) {
    if (e instanceof LlmError && e.kind === 'rate') return { ...base, ok: true, detail: `Key is valid, but Gemini is rate-limiting it right now (${model}). It should recover in a minute.` };
    return fail(e instanceof Error ? e.message : 'The test call failed.');
  }

  // The stronger model is a bonus: without it, problems are worked out by the quick one.
  if (have.size && !have.has(bare(solverModel))) {
    const suggestion = pickSolverModel(listed.ids) ?? undefined;
    return { ...base, ok: true, detail: `Working with ${model}. The stronger model "${solverModel}" isn't available to this key, so problems will be worked out by ${model}.${suggestion && suggestion !== model ? ` You could use "${suggestion}" instead.` : ''}`, suggestedSolverModel: suggestion };
  }
  return { ...base, ok: true, detail: `Working. ${model} read a test prompt; ${solverModel} will work out problems.` };
}

export async function checkSerp(apiKey: string, doFetch: Fetch = fetch): Promise<KeyCheck> {
  const base = { checkedAt: Date.now(), fingerprint: fingerprint(apiKey) };
  const fail = (detail: string): KeyCheck => ({ ...base, ok: false, detail });
  if (!apiKey) return fail('No SerpApi key entered.');

  let res: Response;
  try {
    res = await doFetch(`https://serpapi.com/account.json?api_key=${encodeURIComponent(apiKey)}`, { signal: AbortSignal.timeout(15_000) });
  } catch {
    return fail('Can\'t reach SerpApi. Are you offline?');
  }
  const data = (await res.json().catch(() => null)) as
    | { error?: string; plan_name?: string; total_searches_left?: number; plan_searches_left?: number }
    | null;
  if (!res.ok || !data || data.error) {
    return fail(`SerpApi rejected this key: ${data?.error ?? `HTTP ${res.status}`}`);
  }
  const left = data.total_searches_left ?? data.plan_searches_left;
  if (left === 0) return fail('The key is valid, but this SerpApi account has no searches left.');
  return { ...base, ok: true, detail: `Working${data.plan_name ? ` (${data.plan_name} plan)` : ''}${left !== undefined ? `, ${left} searches left` : ''}.` };
}
