// Minimal Gemini REST client (generateContent + structured JSON output). Works in the
// service worker and in Node (eval scripts) since both have fetch.
import type { RateLimiter } from '../background/rateLimiter';

export interface GeminiCtx {
  apiKey: string;
  model: string;
  limiter?: RateLimiter;
}

export type Part =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } }
  | { fileData: { fileUri: string; mimeType?: string } };

export interface GenerateOptions {
  system: string;
  parts: Part[];
  schema: object;
  timeoutMs?: number;
  temperature?: number;
  /** Lower video/image token cost (used for YouTube video input). */
  lowMediaResolution?: boolean;
}

export type GeminiErrorKind = 'timeout' | 'rate' | 'auth' | 'http' | 'parse' | 'network' | 'blocked';

export class GeminiError extends Error {
  constructor(public kind: GeminiErrorKind, message: string, public status?: number) {
    super(message);
    this.name = 'GeminiError';
  }
}

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

export async function generateJson<T>(ctx: GeminiCtx, opts: GenerateOptions): Promise<T> {
  if (!ctx.apiKey) throw new GeminiError('auth', 'Missing Gemini API key. Add it on the options page.');
  await ctx.limiter?.acquire();

  const body = {
    systemInstruction: { parts: [{ text: opts.system }] },
    contents: [{ role: 'user', parts: opts.parts }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: opts.schema,
      temperature: opts.temperature ?? 0.4,
      ...(opts.lowMediaResolution ? { mediaResolution: 'MEDIA_RESOLUTION_LOW' } : {}),
    },
  };

  const deadline = Date.now() + (opts.timeoutMs ?? 15_000);
  for (let attempt = 0; ; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new GeminiError('timeout', 'Gemini took too long to answer.');
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), remaining);
    let res: Response;
    try {
      res = await fetch(`${BASE}/${encodeURIComponent(ctx.model)}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': ctx.apiKey },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
    } catch (e) {
      if (ac.signal.aborted) throw new GeminiError('timeout', 'Gemini took too long to answer.');
      throw new GeminiError('network', 'Can\'t reach Gemini. Are you offline?');
    } finally {
      clearTimeout(timer);
    }

    if ((res.status === 429 || res.status === 503) && attempt === 0) {
      const retryAfter = Number(res.headers.get('retry-after')) * 1000 || 1500;
      if (Date.now() + retryAfter < deadline) {
        await new Promise((r) => setTimeout(r, retryAfter));
        continue;
      }
    }
    if (res.status === 429) throw new GeminiError('rate', 'Gemini is rate-limiting us. Try again in a moment.', 429);
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      const detail = await res.text().catch(() => '');
      const kind = /API key|PERMISSION|UNAUTHENTICATED/i.test(detail) ? 'auth' : 'http';
      throw new GeminiError(kind, kind === 'auth' ? 'Gemini rejected the API key.' : `Gemini error ${res.status}: ${detail.slice(0, 200)}`, res.status);
    }
    if (!res.ok) throw new GeminiError('http', `Gemini error ${res.status}`, res.status);

    const data = await res.json();
    const cand = data.candidates?.[0];
    const text: string | undefined = cand?.content?.parts?.map((p: { text?: string }) => p.text ?? '').join('');
    if (!text) throw new GeminiError('blocked', `Gemini returned no content (${cand?.finishReason ?? data.promptFeedback?.blockReason ?? 'unknown'})`);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new GeminiError('parse', 'Gemini returned malformed JSON.');
    }
  }
}
