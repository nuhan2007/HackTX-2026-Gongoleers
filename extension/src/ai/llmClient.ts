// Minimal Gemini client: generateContent with a JSON schema for structured output, image input, and YouTube-video input.
// Works in the service worker and in Node (the eval scripts), since both have fetch.
//
// Gemini changes quickly, so a few things are learned from the API instead of assumed. Models that think take either a token budget
// (2.5) or a level (3 and later), and the level names a model accepts differ ("minimal" isn't valid everywhere); a request that
// names something the model refuses is retried with the next best value, and what worked is remembered. The same goes for how the JSON
// schema is passed (`responseJsonSchema`, the older `responseSchema`, or only described in the prompt).
import type { RateLimiter } from '../background/rateLimiter';

export type Effort = 'none' | 'minimal' | 'low' | 'medium' | 'high';

/** One finished call, reported to `LlmCtx.onCall` so the panel can show how many calls were made and why. */
export interface CallRecord {
  kind: string;
  ms: number;
  ok: boolean;
  model: string;
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
}

/** The pictures a call is about to send, each with the caption that precedes it (so the panel can show what the model was shown). */
export interface SendRecord {
  kind: string;
  images: { caption: string; jpeg: string }[];
}

export interface LlmCtx {
  apiKey: string;
  /** The quick model: reads the work, writes hints, judges them. */
  model: string;
  /** The stronger model for `tier: 'smart'` calls (working a problem out). Falls back to `model` when unset or unavailable. */
  smartModel?: string;
  limiter?: RateLimiter;
  onCall?: (c: CallRecord) => void;
  onSend?: (s: SendRecord) => void;
  /**
   * The quick model doesn't exist for this key: say which one to use instead (or null for none). The call is retried with it, so a model
   * name that is out of date, or not available to this key, never stops myTA from helping.
   */
  onModelMissing?: (model: string) => Promise<string | null>;
  /** Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

export type Part =
  | { text: string }
  /** A base64 JPEG. */
  | { image: string; detail?: 'low' | 'high' | 'auto' }
  /** A public YouTube address; Gemini watches it. `startSec`/`endSec` limit which part it looks at. */
  | { video: string; startSec?: number; endSec?: number };

export interface GenerateOptions {
  system: string;
  parts: Part[];
  /** JSON Schema for the reply (types in lowercase, every property listed in `required`). */
  schema: object;
  schemaName?: string;
  /** Label for the activity log and call counters, e.g. "review" or "tutor". */
  kind?: string;
  timeoutMs?: number;
  /** Only sent to models that take it (Gemini 3 and later are best left at their default). */
  temperature?: number;
  /** How hard the model thinks: the biggest lever on how fast it answers. */
  effort?: Effort;
  /** Includes thinking tokens, so leave room. */
  maxTokens?: number;
  /** `smart` calls go to `ctx.smartModel` (the answer key), everything else to the quick model. */
  tier?: 'fast' | 'smart';
  /** Fewer tokens per picture or video frame: for video, where the picture quality matters little. */
  lowMediaResolution?: boolean;
}

export type LlmErrorKind = 'timeout' | 'rate' | 'quota' | 'auth' | 'http' | 'parse' | 'network' | 'blocked' | 'model';

export class LlmError extends Error {
  constructor(public kind: LlmErrorKind, message: string, public status?: number) {
    super(message);
    this.name = 'LlmError';
  }
}

export const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

const bareModel = (model: string) => model.replace(/^models\//, '');

// ---------------- thinking ----------------

type Family = 'budget' | 'level' | 'none';

/** 2.5 models take a token budget, 3 and later a level; anything older or different takes neither. */
export function thinkingFamily(model: string): Family {
  const m = bareModel(model).toLowerCase();
  if (/^gemini-2\.5/.test(m)) return 'budget';
  const major = Number(m.match(/^gemini-(\d+)/)?.[1]);
  return Number.isFinite(major) && major >= 3 ? 'level' : 'none';
}

const LEVELS: Effort[] = ['minimal', 'low', 'medium', 'high'];

/** Effort values the API told us a model doesn't take, mapped to ones it does. Keyed by `model:effort`. */
const levelOverrides = new Map<string, string>();
/** Models that took no thinking configuration at all. */
const noThinking = new Set<string>();
/** How each model wants its JSON schema. */
type SchemaMode = 'json-schema' | 'open-api' | 'prompt';
const schemaModes = new Map<string, SchemaMode>();
/** Models that refused a `mediaResolution`. */
const noMediaResolution = new Set<string>();
/** Smart models this key can't use: calls go to the quick model instead. */
const smartUnavailable = new Set<string>();

/** Forgets what was learned about the API (a different key may have access to different models). Used by tests. */
export function resetLearned(): void {
  levelOverrides.clear();
  noThinking.clear();
  schemaModes.clear();
  noMediaResolution.clear();
  smartUnavailable.clear();
}

/** 2.5: roughly how many tokens of thinking each effort allows. Pro can't switch thinking off. */
function budgetFor(model: string, effort: Effort): number {
  const pro = /pro/.test(model);
  const table: Record<Effort, number> = pro
    ? { none: 128, minimal: 128, low: 1024, medium: 4096, high: 16384 }
    : { none: 0, minimal: 0, low: 1024, medium: 4096, high: 12288 };
  return table[effort];
}

/** The `thinkingConfig` to send for this model and effort, or undefined when the model takes none. */
export function thinkingConfigFor(model: string, effort: Effort): Record<string, unknown> | undefined {
  const m = bareModel(model).toLowerCase();
  if (noThinking.has(m)) return undefined;
  const family = thinkingFamily(m);
  if (family === 'none') return undefined;
  if (family === 'budget') return { thinkingBudget: budgetFor(m, effort) };
  const learned = levelOverrides.get(`${m}:${effort}`);
  if (learned) return { thinkingLevel: learned };
  const wanted = effort === 'none' ? 'minimal' : effort;
  // "minimal" isn't valid on every model of the generation; start from "low" on the ones known not to take it.
  if (wanted === 'minimal' && /^gemini-(4|3\.[7-9]|3\.\d\d)/.test(m) && !/lite/.test(m)) return { thinkingLevel: 'low' };
  return { thinkingLevel: wanted };
}

/** Pulls level names out of "…supported values are: low, medium, high" style messages. */
export function supportedLevels(message: string): string[] {
  const list = message.match(/(?:supported|valid|allowed)[^:]*:\s*([^.\n]+)/i)?.[1];
  if (!list) return [];
  return [...list.matchAll(/\b(minimal|low|medium|high)\b/gi)].map((x) => x[1].toLowerCase());
}

/** After a refusal of this level: the next candidate level, or null when none is left (then thinking is left out). */
export function nextLevel(effort: Effort, tried: string[], message: string): string | null {
  const said = supportedLevels(message).filter((l) => !tried.includes(l));
  if (said.length) {
    // The closest one the API says it takes.
    const want = LEVELS.indexOf(effort === 'none' ? 'minimal' : effort);
    return said.sort((a, b) => Math.abs(LEVELS.indexOf(a as Effort) - want) - Math.abs(LEVELS.indexOf(b as Effort) - want))[0];
  }
  const order: string[] = effort === 'high' || effort === 'medium' ? ['medium', 'high', 'low'] : ['low', 'medium', 'high'];
  return order.find((l) => !tried.includes(l)) ?? null;
}

// ---------------- schema ----------------

/** The older `responseSchema` is an OpenAPI subset: uppercase type names, and no `additionalProperties`. */
export function toOpenApiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toOpenApiSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
    if (k === 'additionalProperties') continue;
    if (k === 'type' && typeof v === 'string') out[k] = v.toUpperCase();
    else out[k] = toOpenApiSchema(v);
  }
  return out;
}

// ---------------- request ----------------

interface ApiError {
  message: string;
  status?: string;
  retryAfterMs?: number;
}

async function readError(res: Response): Promise<ApiError> {
  const text = await res.text().catch(() => '');
  try {
    const e = JSON.parse(text)?.error;
    if (e) {
      const retry = (e.details as { retryDelay?: string }[] | undefined)?.find((d) => d.retryDelay)?.retryDelay;
      return { message: String(e.message ?? text), status: e.status, retryAfterMs: retry ? Number.parseFloat(retry) * 1000 : undefined };
    }
  } catch {
    /* not JSON */
  }
  return { message: text.slice(0, 300) || `HTTP ${res.status}` };
}

function apiPart(p: Part): Record<string, unknown> {
  if ('text' in p) return { text: p.text };
  if ('image' in p) return { inlineData: { mimeType: 'image/jpeg', data: p.image } };
  const meta: Record<string, string> = {};
  if (p.startSec !== undefined) meta.startOffset = `${Math.max(0, Math.floor(p.startSec))}s`;
  if (p.endSec !== undefined) meta.endOffset = `${Math.max(1, Math.floor(p.endSec))}s`;
  return { fileData: { fileUri: p.video }, ...(Object.keys(meta).length ? { videoMetadata: meta } : {}) };
}

/** Strips code fences and chatter around a JSON object, for the models/modes that don't return clean JSON. */
export function parseJsonText(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(t);
  } catch {
    const a = t.indexOf('{');
    const b = t.lastIndexOf('}');
    if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
    throw new Error('not JSON');
  }
}

interface Usage {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  cachedContentTokenCount?: number;
}

async function run<T>(ctx: LlmCtx, model: string, opts: GenerateOptions): Promise<T> {
  if (!ctx.apiKey) throw new LlmError('auth', 'Missing Gemini API key. Add it on the options page.');
  await ctx.limiter?.acquire();

  if (ctx.onSend) {
    const images: SendRecord['images'] = [];
    opts.parts.forEach((p, i) => {
      if (!('image' in p)) return;
      const before = opts.parts[i - 1];
      images.push({ caption: before && 'text' in before && before.text.length < 200 ? before.text : '', jpeg: p.image });
    });
    if (images.length) ctx.onSend({ kind: opts.kind ?? 'call', images });
  }

  const started = Date.now();
  const deadline = started + (opts.timeoutMs ?? 30_000);
  const m = bareModel(model);
  const wantedEffort = opts.effort ?? 'low';
  let maxTokens = opts.maxTokens ?? 1500;
  let mode: SchemaMode = schemaModes.get(m) ?? 'json-schema';
  let thinking = thinkingConfigFor(m, wantedEffort);
  const triedLevels: string[] = thinking && 'thinkingLevel' in thinking ? [String(thinking.thinkingLevel)] : [];
  let mediaRes = !!opts.lowMediaResolution && !noMediaResolution.has(m);
  let retried = false;
  let adapted = 0;

  const record = (ok: boolean, usage?: Usage) =>
    ctx.onCall?.({
      kind: opts.kind ?? 'call',
      ms: Date.now() - started,
      ok,
      model: m,
      promptTokens: usage?.promptTokenCount,
      completionTokens: (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0) || undefined,
      cachedTokens: usage?.cachedContentTokenCount,
    });

  try {
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new LlmError('timeout', 'Gemini took too long to answer.');

      const system = mode === 'prompt' ? `${opts.system}\n\nReply with ONLY one JSON object that follows this JSON Schema, with no other text:\n${JSON.stringify(opts.schema)}` : opts.system;
      const generationConfig: Record<string, unknown> = { maxOutputTokens: maxTokens };
      if (mode === 'json-schema') Object.assign(generationConfig, { responseMimeType: 'application/json', responseJsonSchema: opts.schema });
      else if (mode === 'open-api') Object.assign(generationConfig, { responseMimeType: 'application/json', responseSchema: toOpenApiSchema(opts.schema) });
      else generationConfig.responseMimeType = 'application/json';
      if (thinking) generationConfig.thinkingConfig = thinking;
      if (opts.temperature !== undefined && thinkingFamily(m) !== 'level') generationConfig.temperature = opts.temperature;
      if (mediaRes) generationConfig.mediaResolution = 'MEDIA_RESOLUTION_LOW';
      const body = {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: opts.parts.map(apiPart) }],
        generationConfig,
      };

      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), remaining);
      let res: Response;
      try {
        res = await (ctx.fetchImpl ?? fetch)(`${GEMINI_BASE}/models/${encodeURIComponent(m)}:generateContent`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': ctx.apiKey },
          body: JSON.stringify(body),
          signal: ac.signal,
        });
      } catch {
        clearTimeout(timer);
        if (ac.signal.aborted) throw new LlmError('timeout', 'Gemini took too long to answer.');
        throw new LlmError('network', 'Can\'t reach Gemini. Are you offline?');
      }
      // The timer keeps running while the reply is read: a connection that sends its headers and then stalls must not hang for ever.

      if (!res.ok) {
        const err = await readError(res);
        clearTimeout(timer);
        if (ac.signal.aborted) throw new LlmError('timeout', 'Gemini took too long to answer.');
        const msg = err.message;
        // A bad key is a 400 on Gemini (INVALID_ARGUMENT), not a 401, so the message has to be read.
        if (res.status === 401 || /API key not valid|API_KEY_INVALID|API key expired|API key is invalid/i.test(msg) || err.status === 'UNAUTHENTICATED')
          throw new LlmError('auth', 'Gemini rejected the API key. Check it on the options page.', res.status);
        if (res.status === 403 && /API key|permission|blocked|leaked|disabled/i.test(msg) && !/model/i.test(msg))
          throw new LlmError('auth', `Gemini denied access: ${msg.slice(0, 200)}`, 403);
        if (res.status === 404 || (res.status === 403 && /model/i.test(msg)))
          throw new LlmError('model', `Gemini doesn't have a model called "${m}" for this key. Check the model names on the options page (Save & test keys will suggest ones).`, 404);
        if (res.status === 429) {
          // Out of credit or a daily cap is not worth retrying; a per-minute limit is.
          if (/billing|per day|daily|exceeded your current quota|check your plan/i.test(msg) && !err.retryAfterMs)
            throw new LlmError('quota', 'Your Gemini key is out of quota. Check the plan and billing for it at aistudio.google.com.', 429);
          const wait = err.retryAfterMs ?? (Number(res.headers.get('retry-after')) * 1000 || 1500);
          if (!retried && Date.now() + wait < deadline) {
            retried = true;
            await new Promise((r) => setTimeout(r, Math.min(wait, 8000)));
            continue;
          }
          throw new LlmError('rate', 'Gemini is rate-limiting us. Try again in a moment.', 429);
        }
        if (res.status >= 500 && !retried && Date.now() + 1000 < deadline) {
          retried = true;
          await new Promise((r) => setTimeout(r, 1000));
          continue;
        }
        if (res.status === 400 && adapted < 6) {
          // The model doesn't take this thinking setting or this way of passing the schema: adapt and try again.
          if (/thinking/i.test(msg) && thinking) {
            adapted++;
            if ('thinkingLevel' in thinking) {
              const next = nextLevel(wantedEffort, triedLevels, msg);
              if (next) {
                triedLevels.push(next);
                levelOverrides.set(`${m}:${wantedEffort}`, next);
                thinking = { thinkingLevel: next };
                continue;
              }
            }
            noThinking.add(m);
            thinking = undefined;
            continue;
          }
          if (/media_?resolution/i.test(msg) && mediaRes) {
            adapted++;
            noMediaResolution.add(m);
            mediaRes = false;
            continue;
          }
          if (/schema|response_?format|mime/i.test(msg) && mode !== 'prompt') {
            adapted++;
            mode = mode === 'json-schema' ? 'open-api' : 'prompt';
            schemaModes.set(m, mode);
            continue;
          }
        }
        throw new LlmError('http', `Gemini error ${res.status}: ${msg.slice(0, 200)}`, res.status);
      }

      let data: { usageMetadata?: Usage; candidates?: { content?: { parts?: unknown[] }; finishReason?: string }[]; promptFeedback?: { blockReason?: string } };
      try {
        data = await res.json();
      } catch {
        if (ac.signal.aborted) throw new LlmError('timeout', 'Gemini took too long to answer.');
        throw new LlmError('network', 'The connection to Gemini dropped before it finished answering.');
      } finally {
        clearTimeout(timer);
      }
      const usage = data.usageMetadata as Usage | undefined;
      const cand = data.candidates?.[0];
      const parts = (cand?.content?.parts ?? []) as { text?: string; thought?: boolean }[];
      const text = parts
        .filter((p) => !p.thought)
        .map((p) => p.text ?? '')
        .join('');
      const finish: string | undefined = cand?.finishReason;
      if (finish === 'MAX_TOKENS') {
        // Thinking tokens count against the limit; one more try with room to think.
        if (maxTokens < 16_000 && Date.now() + 2000 < deadline) {
          maxTokens = Math.min(16_000, maxTokens * 2);
          continue;
        }
        record(false, usage);
        throw new LlmError('parse', 'Gemini ran out of room before finishing its answer.');
      }
      if (!text) {
        record(false, usage);
        throw new LlmError('blocked', `Gemini returned no content (${finish ?? data.promptFeedback?.blockReason ?? 'unknown'})`);
      }
      try {
        const out = parseJsonText(text) as T;
        record(true, usage);
        return out;
      } catch {
        record(false, usage);
        throw new LlmError('parse', 'Gemini returned malformed JSON.');
      }
    }
  } catch (e) {
    if (e instanceof LlmError && e.kind !== 'parse' && e.kind !== 'blocked') record(false);
    throw e;
  }
}

/**
 * One structured call. `smart` calls use the stronger model; if the key can't use it (no such model, or it takes too long) the call
 * goes to the quick model instead, so a missing model never leaves the student without help.
 */
export async function generateJson<T>(ctx: LlmCtx, opts: GenerateOptions): Promise<T> {
  const smart = opts.tier === 'smart' && ctx.smartModel && bareModel(ctx.smartModel) !== bareModel(ctx.model) && !smartUnavailable.has(bareModel(ctx.smartModel));
  if (smart) {
    const model = ctx.smartModel!;
    const started = Date.now();
    try {
      return await run<T>(ctx, model, { ...opts, timeoutMs: Math.max(opts.timeoutMs ?? 30_000, 60_000) });
    } catch (e) {
      if (!(e instanceof LlmError) || (e.kind !== 'model' && e.kind !== 'timeout' && e.kind !== 'parse')) throw e;
      if (e.kind === 'model') smartUnavailable.add(bareModel(model));
      // Leave the quick model a fair share of the time, whatever the stronger one used up.
      const left = Math.max(40_000, (opts.timeoutMs ?? 30_000) - (Date.now() - started));
      return runQuick<T>(ctx, { ...opts, timeoutMs: left });
    }
  }
  return runQuick<T>(ctx, opts);
}

/** The quick model's call, with one chance to switch to a model the key does have. */
async function runQuick<T>(ctx: LlmCtx, opts: GenerateOptions): Promise<T> {
  try {
    return await run<T>(ctx, ctx.model, opts);
  } catch (e) {
    if (!(e instanceof LlmError) || e.kind !== 'model' || !ctx.onModelMissing) throw e;
    const alt = await ctx.onModelMissing(ctx.model).catch(() => null);
    if (!alt || bareModel(alt) === bareModel(ctx.model)) throw e;
    return run<T>(ctx, alt, opts);
  }
}
