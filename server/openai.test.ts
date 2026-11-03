import { describe, expect, it } from 'vitest';
import { OpenAIImageAdapter, openAiSize } from './adapters/openai';
import { AdapterError, type GenerationRequest } from './adapters/types';

// A fake key: tests only check that it is sent in the header and never appears in errors.
const KEY = 'test-openai-key-not-real';
const ENV = { OPENAI_API_KEY: KEY } as NodeJS.ProcessEnv;
const IMG = Buffer.from('fake image').toString('base64');
const OUT = Buffer.from('generated png').toString('base64');

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(respond: () => Response | Promise<Response>) {
  const calls: Call[] = [];
  const impl = async (url: string, init?: RequestInit) => {
    calls.push({ url, init: init ?? {} });
    return respond();
  };
  return { impl, calls };
}

const jsonRes = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const okImage = () => jsonRes(200, { data: [{ b64_json: OUT }] });

async function generate(req: Partial<GenerationRequest>, respond: () => Response | Promise<Response> = okImage) {
  const f = fakeFetch(respond);
  const result = await new OpenAIImageAdapter(ENV, f.impl).generate({ prompt: 'render it', ...req });
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

describe('openAiSize', () => {
  it('maps aspect + resolution to the supported sizes', () => {
    expect(openAiSize('1:1', '1K', false)).toBe('1024x1024');
    expect(openAiSize('16:9', '1K', false)).toBe('1536x1024');
    expect(openAiSize('9:16', '1K', true)).toBe('1024x1536');
    expect(openAiSize('3:2', '2K', false)).toBe('2048x1360');
    expect(openAiSize('2:3', '2K', false)).toBe('1360x2048');
    expect(openAiSize('1:1', '2K', false)).toBe('2048x2048');
    expect(openAiSize('16:9', '4K', false)).toBe('2048x1360');
    expect(openAiSize(undefined, '1K', false)).toBe('1024x1024');
    expect(openAiSize('Original', '1K', true)).toBe('auto');
  });
});

describe('OpenAIImageAdapter', () => {
  it('is configured only by OPENAI_API_KEY', async () => {
    expect(new OpenAIImageAdapter({} as NodeJS.ProcessEnv).isAvailable()).toBe(false);
    expect(new OpenAIImageAdapter(ENV).isAvailable()).toBe(true);
    const err = await new OpenAIImageAdapter({} as NodeJS.ProcessEnv).generate({ prompt: 'x' }).catch((e: AdapterError) => e);
    expect(err).toMatchObject({ code: 'not_configured', status: 503, message: 'OPENAI_API_KEY is not set on the server.' });
  });

  it('uses /images/generations with a JSON body when there are no images', async () => {
    const { calls, result } = await generate({ model: 'gpt-image-2.5-sunburst', aspectRatio: '16:9', imageSize: '2K' });
    expect(calls[0].url).toBe('https://api.openai.com/v1/images/generations');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(Object.keys(headers)).toContain('authorization');
    expect(headers.authorization === `Bearer ${KEY}`).toBe(true);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      model: 'gpt-image-2.5-sunburst',
      prompt: 'render it',
      size: '2048x1360',
      quality: 'high',
      n: 1,
    });
    expect(result).toEqual({ provider: 'openai', model: 'gpt-image-2.5-sunburst', images: [{ base64: OUT, mediaType: 'image/png' }] });
  });

  it('uses /images/edits multipart with image[] blobs when images are given', async () => {
    const { calls } = await generate({
      aspectRatio: '9:16',
      imageSize: '1K',
      guideImages: [
        { base64: IMG, mediaType: 'image/jpeg' },
        { base64: IMG, mediaType: 'image/png' },
      ],
    });
    expect(calls[0].url).toBe('https://api.openai.com/v1/images/edits');
    const headers = calls[0].init.headers as Record<string, string>;
    // fetch must set the multipart boundary itself.
    expect(Object.keys(headers).map((h) => h.toLowerCase())).not.toContain('content-type');
    const form = calls[0].init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get('model')).toBe('gpt-image-2.5-sunburst');
    expect(form.get('prompt')).toBe('render it');
    expect(form.get('size')).toBe('1024x1536');
    expect(form.get('quality')).toBe('high');
    const images = form.getAll('image[]') as File[];
    expect(images).toHaveLength(2);
    expect(images[0].type).toBe('image/jpeg');
    expect(Buffer.from(await images[0].arrayBuffer()).toString('base64')).toBe(IMG);
  });

  it('maps errors, including moderation_blocked, without leaking the key', async () => {
    const upstream =
      (status: number, message: string, code: string | null = null) =>
      () =>
        jsonRes(status, { error: { message, type: 'invalid_request_error', code } });
    expect(await failure(upstream(400, 'Your request was rejected by the safety system.', 'moderation_blocked'))).toMatchObject({
      code: 'refused',
      status: 422,
    });
    expect(await failure(upstream(400, 'Invalid size'))).toMatchObject({ code: 'invalid_request', status: 400 });
    expect(await failure(upstream(401, `Incorrect API key provided: ${KEY}`, 'invalid_api_key'))).toMatchObject({
      code: 'auth_failed',
      status: 401,
    });
    expect(await failure(upstream(429, 'Rate limit reached'))).toMatchObject({ code: 'rate_limited', status: 429 });
    expect(await failure(() => jsonRes(200, { data: [] }))).toMatchObject({ code: 'invalid_output', status: 502 });
    const net = await failure(() => {
      throw new TypeError('fetch failed');
    });
    expect(net).toMatchObject({ code: 'upstream_unreachable' });
  });
});
