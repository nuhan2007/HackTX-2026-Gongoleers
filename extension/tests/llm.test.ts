import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkGemini, checkSerp, fingerprint, pickFastModel, pickSolverModel } from '../src/ai/keyCheck';
import {
  generateJson,
  LlmError,
  nextLevel,
  parseJsonText,
  resetLearned,
  supportedLevels,
  thinkingConfigFor,
  thinkingFamily,
  toOpenApiSchema,
  type CallRecord,
} from '../src/ai/llmClient';

const SCHEMA = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });
const completion = (obj: unknown, extra: object = {}) =>
  json({
    candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] }, finishReason: 'STOP', ...extra }],
    usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 18, thoughtsTokenCount: 4, cachedContentTokenCount: 64 },
  });
const apiError = (status: number, message: string, errStatus?: string, details?: unknown[], headers?: Record<string, string>) =>
  json({ error: { code: status, message, status: errStatus, details } }, status, headers);

/** A fresh model name per test: what is learned about a model is remembered for the life of the worker. */
let n = 0;
const model = (prefix: string) => `${prefix}-t${++n}`;

function stub(...responses: Response[]) {
  const f = vi.fn();
  for (const r of responses) f.mockResolvedValueOnce(r);
  vi.stubGlobal('fetch', f);
  return f;
}
const bodyOf = (f: ReturnType<typeof vi.fn>, call = 0) => JSON.parse(f.mock.calls[call][1].body);

beforeEach(() => resetLearned());
afterEach(() => vi.unstubAllGlobals());

describe('generateJson: request shape', () => {
  it('posts a generateContent request with the key in a header, a JSON schema and the thinking level', async () => {
    const f = stub(completion({ ok: true }));
    const m = model('gemini-3.6-flash');
    const out = await generateJson<{ ok: boolean }>({ apiKey: 'AIza-test', model: m }, { system: 'sys', parts: [{ text: 'hi' }], schema: SCHEMA, temperature: 0.2, effort: 'low', maxTokens: 700 });
    expect(out).toEqual({ ok: true });

    const [url, init] = f.mock.calls[0];
    expect(url).toBe(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`);
    expect(init.headers['x-goog-api-key']).toBe('AIza-test');
    expect(String(url)).not.toContain('AIza-test'); // never in the address
    const body = bodyOf(f);
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'sys' }] });
    expect(body.contents).toEqual([{ role: 'user', parts: [{ text: 'hi' }] }]);
    expect(body.generationConfig).toMatchObject({
      maxOutputTokens: 700,
      responseMimeType: 'application/json',
      responseJsonSchema: SCHEMA,
      thinkingConfig: { thinkingLevel: 'low' },
    });
    expect(body.generationConfig.temperature).toBeUndefined(); // Gemini 3 and later are left at their default
  });

  it('uses a thinking budget and a temperature for a 2.5 model', async () => {
    const f = stub(completion({ ok: true }));
    await generateJson({ apiKey: 'k', model: model('gemini-2.5-flash') }, { system: 's', parts: [{ text: 'x' }], schema: SCHEMA, temperature: 0.2, effort: 'minimal' });
    const cfg = bodyOf(f).generationConfig;
    expect(cfg.temperature).toBe(0.2);
    expect(cfg.thinkingConfig).toEqual({ thinkingBudget: 0 });
  });

  it('sends images as inline base64 JPEGs, in order', async () => {
    const f = stub(completion({ ok: true }));
    await generateJson({ apiKey: 'k', model: model('gemini-3.8-flash') }, { system: 's', parts: [{ text: 'first' }, { image: 'AAAA' }, { image: 'BBBB' }, { text: 'last' }], schema: SCHEMA });
    expect(bodyOf(f).contents[0].parts).toEqual([
      { text: 'first' },
      { inlineData: { mimeType: 'image/jpeg', data: 'AAAA' } },
      { inlineData: { mimeType: 'image/jpeg', data: 'BBBB' } },
      { text: 'last' },
    ]);
  });

  it('sends a YouTube address as file data, with the stretch to watch and low media resolution', async () => {
    const f = stub(completion({ ok: true }));
    await generateJson(
      { apiKey: 'k', model: model('gemini-3.8-flash') },
      { system: 's', parts: [{ video: 'https://www.youtube.com/watch?v=abcdefghijk', startSec: 60.7, endSec: 300 }, { text: 'when is it explained?' }], schema: SCHEMA, lowMediaResolution: true },
    );
    const body = bodyOf(f);
    expect(body.contents[0].parts[0]).toEqual({ fileData: { fileUri: 'https://www.youtube.com/watch?v=abcdefghijk' }, videoMetadata: { startOffset: '60s', endOffset: '300s' } });
    expect(body.contents[0].parts[1]).toEqual({ text: 'when is it explained?' });
    expect(body.generationConfig.mediaResolution).toBe('MEDIA_RESOLUTION_LOW');
  });

  it('waits for the rate limiter and reports each call (kind, time, tokens, cache hits)', async () => {
    stub(completion({ ok: true }));
    const acquire = vi.fn().mockResolvedValue(undefined);
    const calls: CallRecord[] = [];
    await generateJson(
      { apiKey: 'k', model: model('gemini-3.8-flash'), limiter: { acquire } as never, onCall: (c) => calls.push(c) },
      { system: 's', parts: [{ text: 'x' }], schema: SCHEMA, kind: 'review' },
    );
    expect(acquire).toHaveBeenCalledOnce();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ kind: 'review', ok: true, promptTokens: 120, completionTokens: 22, cachedTokens: 64 });
  });

  it('reports the pictures a call is about to send, with their captions, before sending', async () => {
    stub(completion({ ok: true }));
    const sent: { kind: string; images: { caption: string; jpeg: string }[] }[] = [];
    await generateJson(
      { apiKey: 'k', model: model('gemini-3.8-flash'), onSend: (s) => sent.push(s) },
      {
        system: 's',
        parts: [{ text: 'the answer key…' }, { text: 'IMAGE 1: the WORK tab' }, { image: 'WORK' }, { text: 'IMAGE 2: the PROBLEM tab.' }, { image: 'PROBLEM' }, { text: 'what changed' }],
        schema: SCHEMA,
        kind: 'review',
      },
    );
    expect(sent).toEqual([{ kind: 'review', images: [{ caption: 'IMAGE 1: the WORK tab', jpeg: 'WORK' }, { caption: 'IMAGE 2: the PROBLEM tab.', jpeg: 'PROBLEM' }] }]);
  });

  it('reports nothing for a call with no pictures', async () => {
    stub(completion({ ok: true }));
    const onSend = vi.fn();
    await generateJson({ apiKey: 'k', model: model('gemini-3.8-flash'), onSend }, { system: 's', parts: [{ text: 'hi' }], schema: SCHEMA });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('refuses to call without a key', async () => {
    const f = stub();
    await expect(generateJson({ apiKey: '', model: 'm' }, { system: 's', parts: [], schema: SCHEMA })).rejects.toMatchObject({ kind: 'auth' });
    expect(f).not.toHaveBeenCalled();
  });

  it('ignores thinking summaries and reads only the answer', async () => {
    stub(json({ candidates: [{ content: { parts: [{ thought: true, text: 'let me think…' }, { text: '{"ok":true}' }] }, finishReason: 'STOP' }] }));
    await expect(generateJson({ apiKey: 'k', model: model('gemini-3.8-flash') }, { system: 's', parts: [], schema: SCHEMA })).resolves.toEqual({ ok: true });
  });

  it('accepts JSON wrapped in a code fence', async () => {
    stub(json({ candidates: [{ content: { parts: [{ text: '```json\n{"ok":true}\n```' }] }, finishReason: 'STOP' }] }));
    await expect(generateJson({ apiKey: 'k', model: model('gemini-3.8-flash') }, { system: 's', parts: [], schema: SCHEMA })).resolves.toEqual({ ok: true });
  });
});

describe('thinking: budget or level, learned from the API', () => {
  it('knows the families', () => {
    expect(thinkingFamily('gemini-2.5-pro')).toBe('budget');
    expect(thinkingFamily('models/gemini-3.8-flash')).toBe('level');
    expect(thinkingFamily('gemini-4-argon')).toBe('level');
    expect(thinkingFamily('gemini-2.0-flash')).toBe('none');
    expect(thinkingFamily('gemma-3')).toBe('none');
  });

  it('maps efforts to budgets for 2.5 (pro cannot switch thinking off)', () => {
    expect(thinkingConfigFor('gemini-2.5-flash', 'none')).toEqual({ thinkingBudget: 0 });
    expect(thinkingConfigFor('gemini-2.5-flash', 'high')).toEqual({ thinkingBudget: 12288 });
    expect(thinkingConfigFor('gemini-2.5-pro', 'minimal')).toEqual({ thinkingBudget: 128 });
  });

  it('uses "minimal" where it exists and "low" where the model has no minimal', () => {
    expect(thinkingConfigFor('gemini-3.6-flash', 'minimal')).toEqual({ thinkingLevel: 'minimal' });
    expect(thinkingConfigFor('gemini-3.5-flash-lite', 'none')).toEqual({ thinkingLevel: 'minimal' });
    expect(thinkingConfigFor('gemini-3.8-flash', 'minimal')).toEqual({ thinkingLevel: 'low' });
    expect(thinkingConfigFor('gemini-4-argon', 'minimal')).toEqual({ thinkingLevel: 'low' });
    expect(thinkingConfigFor('gemini-4-argon', 'medium')).toEqual({ thinkingLevel: 'medium' });
    expect(thinkingConfigFor('gemini-2.0-flash', 'low')).toBeUndefined();
  });

  it('reads supported levels out of an error and picks the closest', () => {
    expect(supportedLevels('thinking level "minimal" is not supported. Supported values are: low, medium, high.')).toEqual(['low', 'medium', 'high']);
    expect(supportedLevels('no list here')).toEqual([]);
    expect(nextLevel('minimal', ['minimal'], 'Supported values are: low, medium, high')).toBe('low');
    expect(nextLevel('high', ['high'], 'allowed: low, high')).toBe('low');
    expect(nextLevel('low', ['low', 'medium', 'high'], 'nothing')).toBeNull();
  });

  it('retries with a level the model accepts, and remembers it', async () => {
    // 3.2 isn't known to lack "minimal", so the first try is minimal; the API says otherwise.
    const m = model('gemini-3.2-flash');
    const f = stub(apiError(400, 'Thinking level "minimal" is not supported. Supported values are: low, medium, high.', 'INVALID_ARGUMENT'), completion({ ok: true }), completion({ ok: true }));
    await generateJson({ apiKey: 'k', model: m }, { system: 's', parts: [{ text: 'x' }], schema: SCHEMA, effort: 'minimal' });
    expect(f).toHaveBeenCalledTimes(2);
    expect(bodyOf(f, 0).generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'minimal' });
    expect(bodyOf(f, 1).generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'low' });
    // The next call goes straight to what worked: no wasted round trip.
    await generateJson({ apiKey: 'k', model: m }, { system: 's', parts: [{ text: 'x' }], schema: SCHEMA, effort: 'minimal' });
    expect(f).toHaveBeenCalledTimes(3);
    expect(bodyOf(f, 2).generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'low' });
  });

  it('leaves thinking out for a model that takes none of it', async () => {
    const m = model('gemini-3.2-flash');
    const f = stub(
      apiError(400, 'Thinking is not supported by this model.', 'INVALID_ARGUMENT'),
      apiError(400, 'Thinking is not supported by this model.', 'INVALID_ARGUMENT'),
      apiError(400, 'Thinking is not supported by this model.', 'INVALID_ARGUMENT'),
      completion({ ok: true }),
    );
    await generateJson({ apiKey: 'k', model: m }, { system: 's', parts: [{ text: 'x' }], schema: SCHEMA, effort: 'low' });
    const last = bodyOf(f, f.mock.calls.length - 1);
    expect(last.generationConfig.thinkingConfig).toBeUndefined();
  });
});

describe('schema: the way it is passed is learned too', () => {
  it('turns a JSON Schema into the older OpenAPI form', () => {
    expect(toOpenApiSchema({ type: 'object', properties: { a: { type: 'string', enum: ['x'] }, b: { type: 'array', items: { type: 'integer' } } }, required: ['a'], additionalProperties: false })).toEqual({
      type: 'OBJECT',
      properties: { a: { type: 'STRING', enum: ['x'] }, b: { type: 'ARRAY', items: { type: 'INTEGER' } } },
      required: ['a'],
    });
  });

  it('falls back to responseSchema, then to describing the schema in the prompt, and remembers', async () => {
    const m = model('gemini-3.8-flash');
    const f = stub(
      apiError(400, 'Invalid JSON payload received. Unknown name "responseJsonSchema" at generation_config: Cannot find field.', 'INVALID_ARGUMENT'),
      apiError(400, 'response_schema is not supported for this model', 'INVALID_ARGUMENT'),
      completion({ ok: true }),
      completion({ ok: true }),
    );
    await generateJson({ apiKey: 'k', model: m }, { system: 'sys', parts: [{ text: 'x' }], schema: SCHEMA });
    expect(bodyOf(f, 0).generationConfig.responseJsonSchema).toEqual(SCHEMA);
    expect(bodyOf(f, 1).generationConfig.responseSchema).toEqual({ type: 'OBJECT', properties: { ok: { type: 'BOOLEAN' } }, required: ['ok'] });
    const third = bodyOf(f, 2);
    expect(third.generationConfig.responseSchema).toBeUndefined();
    expect(third.generationConfig.responseJsonSchema).toBeUndefined();
    expect(third.systemInstruction.parts[0].text).toContain('JSON Schema');
    // Remembered.
    await generateJson({ apiKey: 'k', model: m }, { system: 'sys', parts: [{ text: 'x' }], schema: SCHEMA });
    expect(bodyOf(f, 3).generationConfig.responseJsonSchema).toBeUndefined();
    expect(bodyOf(f, 3).systemInstruction.parts[0].text).toContain('JSON Schema');
  });

  it('parses text with chatter around the JSON', () => {
    expect(parseJsonText('Sure! {"a":1} Hope that helps')).toEqual({ a: 1 });
    expect(() => parseJsonText('no json')).toThrow();
  });
});

describe('generateJson: output limits', () => {
  it('doubles the token limit when thinking ate the budget', async () => {
    const f = stub(json({ candidates: [{ content: { parts: [] }, finishReason: 'MAX_TOKENS' }] }), completion({ ok: true }));
    await generateJson({ apiKey: 'k', model: model('gemini-3.8-flash') }, { system: 's', parts: [{ text: 'x' }], schema: SCHEMA, maxTokens: 500 });
    expect(bodyOf(f, 0).generationConfig.maxOutputTokens).toBe(500);
    expect(bodyOf(f, 1).generationConfig.maxOutputTokens).toBe(1000);
  });
});

describe('generateJson: failures say what to do', () => {
  const run = (...r: Response[]) => {
    stub(...r);
    return generateJson({ apiKey: 'k', model: model('gemini-3.8-flash') }, { system: 's', parts: [{ text: 'x' }], schema: SCHEMA });
  };

  it('a bad key (a 400 on Gemini) → auth', async () => {
    await expect(run(apiError(400, 'API key not valid. Please pass a valid API key.', 'INVALID_ARGUMENT'))).rejects.toMatchObject({ name: 'LlmError', kind: 'auth' });
  });
  it('401 → auth', async () => {
    await expect(run(apiError(401, 'Request had invalid authentication credentials.', 'UNAUTHENTICATED'))).rejects.toMatchObject({ kind: 'auth', status: 401 });
  });
  it('403 for a blocked key → auth', async () => {
    await expect(run(apiError(403, 'Your API key was reported as leaked. Please use another API key.', 'PERMISSION_DENIED'))).rejects.toMatchObject({ kind: 'auth' });
  });
  it('429 with no credit → quota, with no retry', async () => {
    const f = stub(apiError(429, 'You exceeded your current quota, please check your plan and billing details.', 'RESOURCE_EXHAUSTED'));
    await expect(generateJson({ apiKey: 'k', model: model('gemini-3.8-flash') }, { system: 's', parts: [], schema: SCHEMA })).rejects.toMatchObject({ kind: 'quota' });
    expect(f).toHaveBeenCalledOnce();
  });
  it('429 per-minute limit → retried once after the delay it asks for, then rate', async () => {
    const retry = [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '0.01s' }];
    const f = stub(apiError(429, 'Resource has been exhausted', 'RESOURCE_EXHAUSTED', retry), apiError(429, 'Resource has been exhausted', 'RESOURCE_EXHAUSTED', retry));
    await expect(generateJson({ apiKey: 'k', model: model('gemini-3.8-flash') }, { system: 's', parts: [], schema: SCHEMA })).rejects.toMatchObject({ kind: 'rate' });
    expect(f).toHaveBeenCalledTimes(2);
  });
  it('a 429 that clears on retry succeeds', async () => {
    const retry = [{ retryDelay: '0.01s' }];
    const f = stub(apiError(429, 'Resource has been exhausted', 'RESOURCE_EXHAUSTED', retry), completion({ ok: true }));
    await expect(generateJson({ apiKey: 'k', model: model('gemini-3.8-flash') }, { system: 's', parts: [], schema: SCHEMA })).resolves.toEqual({ ok: true });
    expect(f).toHaveBeenCalledTimes(2);
  });
  it('a 503 (overloaded) is retried once', async () => {
    const f = stub(apiError(503, 'The model is overloaded.', 'UNAVAILABLE'), completion({ ok: true }));
    await expect(generateJson({ apiKey: 'k', model: model('gemini-3.8-flash') }, { system: 's', parts: [], schema: SCHEMA })).resolves.toEqual({ ok: true });
    expect(f).toHaveBeenCalledTimes(2);
  });
  it('unknown model names the model', async () => {
    const m = model('gemini-9-nope');
    stub(apiError(404, `models/${m} is not found for API version v1beta`, 'NOT_FOUND'));
    await expect(generateJson({ apiKey: 'k', model: m }, { system: 's', parts: [], schema: SCHEMA })).rejects.toThrow(new RegExp(m));
  });
  it('a blocked prompt is reported, not parsed', async () => {
    await expect(run(json({ candidates: [], promptFeedback: { blockReason: 'SAFETY' } }))).rejects.toMatchObject({ kind: 'blocked' });
  });
  it('malformed JSON → parse', async () => {
    await expect(run(json({ candidates: [{ content: { parts: [{ text: '{not json' }] }, finishReason: 'STOP' }] }))).rejects.toMatchObject({ kind: 'parse' });
  });
  it('offline → network', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('failed')));
    await expect(generateJson({ apiKey: 'k', model: model('gemini-3.8-flash') }, { system: 's', parts: [], schema: SCHEMA })).rejects.toMatchObject({ kind: 'network' });
  });
  it('is an LlmError', async () => {
    await expect(run(apiError(401, 'bad'))).rejects.toBeInstanceOf(LlmError);
  });

  describe('a connection that stalls', () => {
    const stalls = (what: 'headers' | 'ok-body' | 'error-body') =>
      vi.stubGlobal(
        'fetch',
        vi.fn((_url: string, init: { signal: AbortSignal }) => {
          const onAbort = (reject: (e: unknown) => void) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          if (what === 'headers') return new Promise((_, reject) => onAbort(reject));
          const never = () => new Promise((_, reject) => onAbort(reject));
          return Promise.resolve({ ok: what === 'ok-body', status: what === 'ok-body' ? 200 : 503, headers: new Headers(), json: never, text: never });
        }),
      );
    const call = () => generateJson({ apiKey: 'k', model: model('gemini-3.8-flash') }, { system: 's', parts: [{ text: 'x' }], schema: SCHEMA, timeoutMs: 120 });

    it('with no reply at all → timeout', async () => {
      stalls('headers');
      await expect(call()).rejects.toMatchObject({ kind: 'timeout' });
    });
    it('after the headers, while the answer is being read → timeout, not a hang', async () => {
      stalls('ok-body');
      await expect(call()).rejects.toMatchObject({ kind: 'timeout' });
    });
    it('after an error status, while the error is being read → timeout', async () => {
      stalls('error-body');
      await expect(call()).rejects.toMatchObject({ kind: 'timeout' });
    });
  });
});

describe('generateJson: the stronger model for working a problem out', () => {
  it('sends smart calls to the smart model and everything else to the quick one', async () => {
    const f = stub(completion({ ok: true }), completion({ ok: true }));
    const fast = model('gemini-3.8-flash');
    const smart = model('gemini-4-argon');
    await generateJson({ apiKey: 'k', model: fast, smartModel: smart }, { system: 's', parts: [], schema: SCHEMA, tier: 'smart', effort: 'medium' });
    await generateJson({ apiKey: 'k', model: fast, smartModel: smart }, { system: 's', parts: [], schema: SCHEMA });
    expect(String(f.mock.calls[0][0])).toContain(`/${smart}:`);
    expect(bodyOf(f, 0).generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'medium' });
    expect(String(f.mock.calls[1][0])).toContain(`/${fast}:`);
  });

  it('falls back to the quick model when the key has no access to the smart one, and remembers', async () => {
    const fast = model('gemini-3.8-flash');
    const smart = model('gemini-4-argon');
    const f = stub(apiError(404, `models/${smart} is not found`, 'NOT_FOUND'), completion({ ok: true }), completion({ ok: true }));
    await expect(generateJson({ apiKey: 'k', model: fast, smartModel: smart }, { system: 's', parts: [], schema: SCHEMA, tier: 'smart' })).resolves.toEqual({ ok: true });
    expect(String(f.mock.calls[0][0])).toContain(`/${smart}:`);
    expect(String(f.mock.calls[1][0])).toContain(`/${fast}:`);
    await generateJson({ apiKey: 'k', model: fast, smartModel: smart }, { system: 's', parts: [], schema: SCHEMA, tier: 'smart' });
    expect(String(f.mock.calls[2][0])).toContain(`/${fast}:`); // no second wasted call
  });

  it('does not hide a bad key behind the fallback', async () => {
    stub(apiError(400, 'API key not valid. Please pass a valid API key.', 'INVALID_ARGUMENT'));
    await expect(generateJson({ apiKey: 'k', model: model('gemini-3.8-flash'), smartModel: model('gemini-4-argon') }, { system: 's', parts: [], schema: SCHEMA, tier: 'smart' })).rejects.toMatchObject({ kind: 'auth' });
  });
});

describe('a quick model the key does not have', () => {
  it('switches to the model it is told to use instead, and retries', async () => {
    const missing = model('gemini-9-gone');
    const f = stub(apiError(404, `models/${missing} is not found`, 'NOT_FOUND'), completion({ ok: true }));
    const onModelMissing = vi.fn().mockResolvedValue('gemini-3.8-flash');
    await expect(generateJson({ apiKey: 'k', model: missing, onModelMissing }, { system: 's', parts: [], schema: SCHEMA })).resolves.toEqual({ ok: true });
    expect(onModelMissing).toHaveBeenCalledWith(missing);
    expect(String(f.mock.calls[0][0])).toContain(`/${missing}:`);
    expect(String(f.mock.calls[1][0])).toContain('/gemini-3.8-flash:');
  });

  it('gives up with the original error when there is nothing to switch to, or it switches to the same model', async () => {
    const missing = model('gemini-9-gone');
    stub(apiError(404, `models/${missing} is not found`, 'NOT_FOUND'));
    await expect(generateJson({ apiKey: 'k', model: missing, onModelMissing: async () => null }, { system: 's', parts: [], schema: SCHEMA })).rejects.toMatchObject({ kind: 'model' });
    stub(apiError(404, `models/${missing} is not found`, 'NOT_FOUND'));
    await expect(generateJson({ apiKey: 'k', model: missing, onModelMissing: async () => missing }, { system: 's', parts: [], schema: SCHEMA })).rejects.toMatchObject({ kind: 'model' });
  });

  it('is not tried for a bad key, and does not loop when the replacement is missing too', async () => {
    const hook = vi.fn().mockResolvedValue('gemini-3.8-flash');
    stub(apiError(400, 'API key not valid. Please pass a valid API key.', 'INVALID_ARGUMENT'));
    await expect(generateJson({ apiKey: 'k', model: model('gemini-3.8-flash'), onModelMissing: hook }, { system: 's', parts: [], schema: SCHEMA })).rejects.toMatchObject({ kind: 'auth' });
    expect(hook).not.toHaveBeenCalled();
    const missing = model('gemini-9-gone');
    const f = stub(apiError(404, 'not found', 'NOT_FOUND'), apiError(404, 'not found', 'NOT_FOUND'));
    await expect(generateJson({ apiKey: 'k', model: missing, onModelMissing: async () => 'gemini-8-gone' }, { system: 's', parts: [], schema: SCHEMA })).rejects.toMatchObject({ kind: 'model' });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('also covers the quick model after the stronger one was not there', async () => {
    const fast = model('gemini-9-gone');
    const smart = model('gemini-4-argon');
    const f = stub(apiError(404, 'smart missing', 'NOT_FOUND'), apiError(404, 'fast missing', 'NOT_FOUND'), completion({ ok: true }));
    await expect(generateJson({ apiKey: 'k', model: fast, smartModel: smart, onModelMissing: async () => 'gemini-3.8-flash' }, { system: 's', parts: [], schema: SCHEMA, tier: 'smart' })).resolves.toEqual({ ok: true });
    expect(String(f.mock.calls[2][0])).toContain('/gemini-3.8-flash:');
  });
});

describe('picking models', () => {
  it('prefers the newest full flash model for the quick job, stable over preview', () => {
    expect(pickFastModel(['models/gemini-3.6-flash', 'models/gemini-3.8-flash', 'models/gemini-3.5-flash-lite', 'models/gemini-4-argon'])).toBe('gemini-3.8-flash');
    expect(pickFastModel(['gemini-3-flash-preview', 'gemini-2.5-flash'])).toBe('gemini-3-flash-preview');
    expect(pickFastModel(['gemini-3.8-flash-preview', 'gemini-3.8-flash'])).toBe('gemini-3.8-flash');
  });
  it('uses a lite model when there is no full flash, and skips image, voice and embedding models', () => {
    expect(pickFastModel(['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'])).toBe('gemini-3.5-flash-lite');
    expect(pickFastModel(['gemini-3-pro-image-preview', 'gemini-2.5-flash-preview-tts', 'text-embedding-004', 'gemini-live-2.5-flash'])).toBeNull();
    expect(pickFastModel([])).toBeNull();
  });
  it('prefers the newest pro-class model for working problems out', () => {
    expect(pickSolverModel(['gemini-3.1-pro-preview', 'gemini-4-argon', 'gemini-3.8-flash', 'gemini-2.5-pro'])).toBe('gemini-4-argon');
    expect(pickSolverModel(['gemini-3.8-flash'])).toBe('gemini-3.8-flash');
  });
});

describe('checkGemini', () => {
  const models = (...ids: string[]) => json({ models: ids.map((id) => ({ name: `models/${id}`, supportedGenerationMethods: ['generateContent'] })) });
  /** Routes by URL like the real API: GET /models, POST /models/x:generateContent. */
  const router = (routes: { list: Response; call?: Response }) =>
    vi.fn(async (url: string, _init?: { body?: string }) => (/:generateContent$/.test(String(url)) ? (routes.call ?? completion({ ok: true })) : routes.list));

  it('reports a missing key without calling out', async () => {
    const f = vi.fn();
    const r = await checkGemini('', 'gemini-3.8-flash', 'gemini-4-argon', f as never);
    expect(r.ok).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });
  it("rejects a bad key with Gemini's message", async () => {
    const f = router({ list: apiError(400, 'API key not valid. Please pass a valid API key.', 'INVALID_ARGUMENT') });
    const r = await checkGemini('bad', 'gemini-3.8-flash', 'gemini-4-argon', f as never);
    expect(r).toMatchObject({ ok: false, fingerprint: fingerprint('bad') });
    expect(r.detail).toContain('API key not valid');
  });
  it('suggests another model when the configured one is not available to the key', async () => {
    const f = router({ list: models('gemini-3.6-flash', 'gemini-4-argon') });
    const r = await checkGemini('ok', 'gemini-9-imaginary', 'gemini-4-argon', f as never);
    expect(r).toMatchObject({ ok: false, suggestedModel: 'gemini-3.6-flash' });
    expect(f).toHaveBeenCalledTimes(1); // no pointless test call on a model that isn't there
  });
  it('passes when the quick model answers a structured test call, and says the stronger one will work problems out', async () => {
    const f = router({ list: models('gemini-3.8-flash', 'gemini-4-argon') });
    const r = await checkGemini('ok', 'gemini-3.8-flash', 'gemini-4-argon', f as never);
    expect(r.ok).toBe(true);
    expect(r.detail).toContain('gemini-3.8-flash');
    expect(r.detail).toContain('gemini-4-argon');
    const call = f.mock.calls.find((c) => /:generateContent$/.test(String(c[0])))!;
    expect(JSON.parse(call[1]!.body!).generationConfig.responseMimeType).toBe('application/json');
  });
  it('still works when only the stronger model is missing, and says what it will use instead', async () => {
    const f = router({ list: models('gemini-3.8-flash', 'gemini-3.1-pro-preview') });
    const r = await checkGemini('ok', 'gemini-3.8-flash', 'gemini-4-argon', f as never);
    expect(r.ok).toBe(true);
    expect(r).toMatchObject({ suggestedSolverModel: 'gemini-3.1-pro-preview' });
    expect(r.detail).toMatch(/isn't available/);
  });
  it('says so when the account is out of quota', async () => {
    const f = router({ list: models('gemini-3.8-flash'), call: apiError(429, 'You exceeded your current quota, please check your plan and billing details.', 'RESOURCE_EXHAUSTED') });
    const r = await checkGemini('ok', 'gemini-3.8-flash', 'gemini-4-argon', f as never);
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/quota/i);
  });
  it('counts a plain rate limit as a valid key', async () => {
    const f = router({ list: models('gemini-3.8-flash'), call: apiError(429, 'slow down', 'RESOURCE_EXHAUSTED', [{ retryDelay: '0.01s' }]) });
    expect((await checkGemini('ok', 'gemini-3.8-flash', 'gemini-4-argon', f as never)).ok).toBe(true);
  });
  it('reports offline', async () => {
    const f = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    expect((await checkGemini('ok', 'gemini-3.8-flash', 'gemini-4-argon', f as never)).detail).toMatch(/offline/i);
  });
});

describe('checkSerp', () => {
  it('shows the plan and searches left for a good key', async () => {
    const f = vi.fn().mockResolvedValue(json({ plan_name: 'Free', total_searches_left: 87 }));
    const r = await checkSerp('abc123', f as never);
    expect(r.ok).toBe(true);
    expect(r.detail).toContain('87 searches left');
    expect(f.mock.calls[0][0]).toContain('account.json');
  });
  it('rejects a bad key', async () => {
    const f = vi.fn().mockResolvedValue(json({ error: 'Invalid API key.' }, 401));
    const r = await checkSerp('nope', f as never);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('Invalid API key');
  });
  it('flags an exhausted account', async () => {
    const f = vi.fn().mockResolvedValue(json({ plan_name: 'Free', total_searches_left: 0 }));
    expect((await checkSerp('k', f as never)).ok).toBe(false);
  });
});
