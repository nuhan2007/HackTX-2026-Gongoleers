// Minimal OpenAI Chat Completions client with strict structured JSON output. Works in the
// service worker and in Node (eval scripts) since both have fetch.
import type { RateLimiter } from '../background/rateLimiter';

export interface OpenAICtx {
  apiKey: string;
  model: string;
  limiter?: RateLimiter;
}

/** A piece of the user message: text, or a base64 JPEG (the tab image, a drawing). */
export type Part = { text: string } | { imageBase64: string };

export interface GenerateOptions {
  system: string;
  parts: Part[];
  /** JSON Schema (strict mode: every property required, additionalProperties false). */
  schema: object;
  timeoutMs?: number;
  /** Only sent to older chat models (gpt-4.x); newer models use their own fixed sampling and reject it. */
  temperature?: number;
  /** Newer (reasoning) models: how hard to think. Higher is slower. Dropped if the model rejects it. */
  effort?: 'minimal' | 'low' | 'medium';
}

export type OpenAIErrorKind = 'timeout' | 'rate' | 'auth' | 'http' | 'parse' | 'network' | 'blocked';

export class OpenAIError extends Error {
  constructor(public kind: OpenAIErrorKind, message: string, public status?: number) {
    super(message);
    this.name = 'OpenAIError';
  }
}

const URL = 'https://api.openai.com/v1/chat/completions';
/** Only these older families take a temperature; every newer model (gpt-5, gpt-6, o-series, ...) doesn't. */
const takesTemperature = (model: string) => /^(gpt-4|gpt-3|chatgpt-4o)/i.test(model);

export async function generateJson<T>(ctx: OpenAICtx, opts: GenerateOptions): Promise<T> {
  if (!ctx.apiKey) throw new OpenAIError('auth', 'Missing OpenAI API key. Add it on the options page.');
  await ctx.limiter?.acquire();

  const content = opts.parts.map((p) =>
    'text' in p
      ? { type: 'text', text: p.text }
      : { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${p.imageBase64}`, detail: 'high' } },
  );
  const legacy = takesTemperature(ctx.model);
  const body: Record<string, unknown> = {
    model: ctx.model,
    messages: [
      { role: legacy ? 'system' : 'developer', content: opts.system },
      { role: 'user', content },
    ],
    response_format: { type: 'json_schema', json_schema: { name: 'result', strict: true, schema: opts.schema } },
    ...(legacy ? { temperature: opts.temperature ?? 0.4 } : { reasoning_effort: opts.effort ?? 'low' }),
  };
  // Models differ in which knobs they accept. If one is rejected, drop it (or fall back) and retry.
  const adapt = (param: string): boolean => {
    if (/role/.test(param)) {
      const msgs = body.messages as { role: string }[];
      if (msgs[0].role === 'system') return false;
      msgs[0].role = 'system';
      return true;
    }
    for (const knob of ['temperature', 'reasoning_effort']) {
      if (param.includes(knob) && knob in body) {
        delete body[knob];
        return true;
      }
    }
    return false;
  };

  const deadline = Date.now() + (opts.timeoutMs ?? 20_000);
  for (let attempt = 0; ; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new OpenAIError('timeout', 'OpenAI took too long to answer.');
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), remaining);
    let res: Response;
    try {
      res = await fetch(URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${ctx.apiKey}` },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
    } catch {
      if (ac.signal.aborted) throw new OpenAIError('timeout', 'OpenAI took too long to answer.');
      throw new OpenAIError('network', "Can't reach OpenAI. Are you offline?");
    } finally {
      clearTimeout(timer);
    }

    if ((res.status === 429 || res.status >= 500) && attempt === 0) {
      const retryAfter = Number(res.headers.get('retry-after')) * 1000 || 1500;
      if (Date.now() + retryAfter < deadline) {
        await new Promise((r) => setTimeout(r, retryAfter));
        continue;
      }
    }
    if (res.status === 401) throw new OpenAIError('auth', 'OpenAI rejected the API key.', 401);
    if (res.status === 429) {
      const detail = await res.text().catch(() => '');
      if (/insufficient_quota/.test(detail)) throw new OpenAIError('auth', 'Your OpenAI account is out of credit.', 429);
      throw new OpenAIError('rate', 'OpenAI is rate-limiting us. Try again in a moment.', 429);
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      let message = detail.slice(0, 200);
      let param = '';
      try {
        const err = JSON.parse(detail).error;
        message = err?.message ?? message;
        param = `${err?.param ?? ''} ${/temperature|reasoning_effort|developer/i.exec(message)?.[0] ?? ''}`;
      } catch {
        /* keep raw text */
      }
      if (res.status === 400 && attempt < 4 && adapt(param.replace('developer', 'role'))) continue;
      throw new OpenAIError('http', `OpenAI error ${res.status}: ${message}`, res.status);
    }

    const data = await res.json();
    const choice = data.choices?.[0];
    const text: string | undefined = choice?.message?.content;
    if (!text) throw new OpenAIError('blocked', `OpenAI returned no content (${choice?.message?.refusal ?? choice?.finish_reason ?? 'unknown'})`);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new OpenAIError('parse', 'OpenAI returned malformed JSON.');
    }
  }
}
