import { describe, expect, it } from 'vitest';
import { GeminiGenerationAdapter } from './adapters/gemini';
import { AdapterError, type GenerationRequest } from './adapters/types';

// A fake key: tests only check that it is sent in the header and never appears in errors.
const KEY = 'test-gemini-key-not-real';
const ENV = { GEMINI_API_KEY: KEY } as NodeJS.ProcessEnv;
const IMG = Buffer.from('fake image').toString('base64');

interface Call {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
}

function fakeFetch(respond: () => Response | Promise<Response>) {
  const calls: Call[] = [];
  const impl = async (url: string, init?: RequestInit) => {
    calls.push({ url, init: init ?? {}, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
    return respond();
  };
  return { impl, calls };
}

const jsonRes = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const okImage = (parts: unknown[], extra: Record<string, unknown> = {}) => jsonRes(200, { candidates: [{ content: { parts }, ...extra }] });

async function generate(req: Partial<GenerationRequest>, respond: () => Response | Promise<Response>) {
  const f = fakeFetch(respond);
  const adapter = new GeminiGenerationAdapter(ENV, f.impl);
  const result = await adapter.generate({ prompt: 'render it', ...req });
  return { result, calls: f.calls };
}

async function failure(respond: () => Response | Promise<Response>, req: Partial<GenerationRequest> = {}): Promise<AdapterError> {
  try {
    await generate(req, respond);
  } catch (e) {
    expect(e).toBeInstanceOf(AdapterError);
    expect((e as Error).message).not.toContain(KEY);
    return e as AdapterError;
  }
  throw new Error('expected generate() to fail');
}

describe('GeminiGenerationAdapter', () => {
  it('is configured only by GEMINI_API_KEY', async () => {
    expect(new GeminiGenerationAdapter({} as NodeJS.ProcessEnv).isAvailable()).toBe(false);
    expect(new GeminiGenerationAdapter({ GEMINI_API_KEY: '  ' } as NodeJS.ProcessEnv).isAvailable()).toBe(false);
    expect(new GeminiGenerationAdapter(ENV).isAvailable()).toBe(true);
    const err = await new GeminiGenerationAdapter({} as NodeJS.ProcessEnv).generate({ prompt: 'x' }).catch((e: AdapterError) => e);
    expect(err).toMatchObject({ code: 'not_configured', status: 503, message: 'GEMINI_API_KEY is not set on the server.' });
  });

  it('POSTs generateContent with the key header and the documented body shape', async () => {
    const { calls } = await generate(
      {
        model: 'gemini-3-pro-image',
        aspectRatio: '16:9',
        imageSize: '4K',
        guideImages: [
          { base64: IMG, mediaType: 'image/jpeg' },
          { base64: IMG, mediaType: 'image/png' },
        ],
      },
      () => okImage([{ inlineData: { mimeType: 'image/png', data: IMG } }]),
    );
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image:generateContent');
    expect(call.init.method).toBe('POST');
    const headers = call.init.headers as Record<string, string>;
    expect(Object.keys(headers)).toContain('x-goog-api-key');
    expect(headers['x-goog-api-key'] === KEY).toBe(true);
    expect(call.url).not.toContain(KEY);
    expect(call.body).toEqual({
      contents: [
        {
          role: 'user',
          parts: [{ text: 'render it' }, { inline_data: { mime_type: 'image/jpeg', data: IMG } }, { inline_data: { mime_type: 'image/png', data: IMG } }],
        },
      ],
      generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '16:9', imageSize: '4K' } },
    });
  });

  it('uses the default model when none is given', async () => {
    const { calls, result } = await generate({}, () => okImage([{ inlineData: { mimeType: 'image/png', data: IMG } }]));
    expect(calls[0].url).toContain('/models/gemini-3-pro-image:generateContent');
    expect(result.model).toBe('gemini-3-pro-image');
  });

  it('omits imageSize for gemini-2.5-flash-image and aspectRatio for Original / undefined', async () => {
    const res = () => okImage([{ inlineData: { mimeType: 'image/png', data: IMG } }]);
    const a = await generate({ model: 'gemini-2.5-flash-image', imageSize: '2K', aspectRatio: '1:1' }, res);
    expect((a.calls[0].body.generationConfig as Record<string, unknown>).imageConfig).toEqual({ aspectRatio: '1:1' });

    const b = await generate({ model: 'gemini-3.1-flash-image', imageSize: '1K', aspectRatio: 'Original' }, res);
    expect((b.calls[0].body.generationConfig as Record<string, unknown>).imageConfig).toEqual({ imageSize: '1K' });

    const c = await generate({ model: 'gemini-2.5-flash-image' }, res);
    expect(c.calls[0].body.generationConfig).toEqual({ responseModalities: ['TEXT', 'IMAGE'] });
  });

  it('skips thought parts, takes the last image and collects the text', async () => {
    const DRAFT = Buffer.from('draft').toString('base64');
    const FIRST = Buffer.from('first').toString('base64');
    const LAST = Buffer.from('last').toString('base64');
    const { result } = await generate({}, () =>
      okImage([
        { text: 'thinking about it', thought: true },
        { inlineData: { mimeType: 'image/png', data: DRAFT }, thought: true },
        { text: 'Here is the render.' },
        { inline_data: { mime_type: 'image/png', data: FIRST } },
        { inlineData: { mimeType: 'image/jpeg', data: LAST } },
      ]),
    );
    expect(result).toEqual({
      provider: 'gemini',
      model: 'gemini-3-pro-image',
      images: [{ base64: LAST, mediaType: 'image/jpeg' }],
      text: 'Here is the render.',
    });
  });

  it('maps blocked prompts and safety finish reasons to refused', async () => {
    const blocked = await failure(() => jsonRes(200, { promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } }));
    expect(blocked).toMatchObject({ code: 'refused', status: 422 });
    expect(blocked.message).toContain('PROHIBITED_CONTENT');
    const safety = await failure(() => okImage([], { finishReason: 'IMAGE_SAFETY' }));
    expect(safety).toMatchObject({ code: 'refused', status: 422 });
    expect(safety.message).toContain('IMAGE_SAFETY');
  });

  it('maps a reply without an image to invalid_output with the model text (max 300 chars)', async () => {
    const err = await failure(() => okImage([{ text: 'I can only describe it. '.repeat(40) }], { finishReason: 'STOP' }));
    expect(err).toMatchObject({ code: 'invalid_output', status: 502 });
    expect(err.message).toContain('I can only describe it.');
    expect(err.message.length).toBeLessThan(400);
  });

  it('maps HTTP errors without leaking the key', async () => {
    const upstream = (status: number, message: string) => () => jsonRes(status, { error: { code: status, message, status: 'X' } });
    expect(await failure(upstream(400, 'Invalid value at imageConfig'))).toMatchObject({ code: 'invalid_request', status: 400 });
    expect(await failure(upstream(400, `API key not valid. Please pass a valid API key. (${KEY})`))).toMatchObject({
      code: 'auth_failed',
      status: 401,
    });
    expect(await failure(upstream(403, 'Permission denied'))).toMatchObject({ code: 'auth_failed', status: 401 });
    expect(await failure(upstream(401, 'Unauthenticated'))).toMatchObject({ code: 'auth_failed' });
    expect(await failure(upstream(429, 'Resource exhausted'))).toMatchObject({ code: 'rate_limited', status: 429 });
    // a quota of 0 (no free tier / billing off) is not a wait-and-retry case; the provider's reason is kept
    const quota = await failure(upstream(429, 'You exceeded your current quota. Quota exceeded for metric: generate_content_free_tier_requests, limit: 0, model: gemini-3-pro-image'));
    expect(quota).toMatchObject({ code: 'quota_exceeded', status: 429 });
    expect((quota as Error).message).toContain('limit: 0');
    expect(await failure(upstream(500, 'Internal'))).toMatchObject({ code: 'upstream_error' });
    // The key in an upstream message is scrubbed even when the message is passed through.
    const echoed = await failure(upstream(400, `bad request for key ${KEY}`));
    expect(echoed.message).toContain('***');
  });

  it('maps network failure and abort', async () => {
    const net = await failure(() => {
      throw new TypeError('fetch failed');
    });
    expect(net).toMatchObject({ code: 'upstream_unreachable', status: 502 });

    const ctrl = new AbortController();
    const adapter = new GeminiGenerationAdapter(ENV, (_url, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    });
    const pending = adapter.generate({ prompt: 'x' }, { signal: ctrl.signal });
    ctrl.abort();
    await expect(pending).rejects.toMatchObject({ code: 'aborted' });
  });

  it('sends the new model ids in the URL; the Lite model gets no imageSize', async () => {
    const res = () => okImage([{ inlineData: { mimeType: 'image/png', data: IMG } }]);
    for (const model of ['gemini-3.1-flash-image', 'gemini-nano-banana-2.1', 'gemini-3.1-flash-lite-image']) {
      const { calls, result } = await generate({ model, imageSize: '2K' }, res);
      expect(calls[0].url).toContain(`/models/${model}:generateContent`);
      expect(result.model).toBe(model);
      const cfg = (calls[0].body.generationConfig as Record<string, unknown>).imageConfig;
      expect(cfg).toEqual(model.includes('lite') ? undefined : { imageSize: '2K' });
    }
  });

  it('maps 402 (prepaid balance at 0) to quota_exceeded', async () => {
    const err = await failure(() => jsonRes(402, { error: { message: 'Your prepayment credits are depleted.', status: 'PAYMENT_REQUIRED' } }));
    expect(err).toMatchObject({ code: 'quota_exceeded', status: 429 });
    expect(err.message).toContain('credits are depleted');
  });

  it('rejects model ids that would change the URL path', async () => {
    const err = await failure(() => okImage([]), { model: '../files' });
    expect(err).toMatchObject({ code: 'invalid_request', status: 400 });
  });
});
