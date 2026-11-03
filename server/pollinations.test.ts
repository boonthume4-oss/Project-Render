import { describe, expect, it } from 'vitest';
import { POLLINATIONS_KEYLESS_NOTE, POLLINATIONS_TEXT_ONLY_NOTE, PollinationsGenerationAdapter } from './adapters/pollinations';
import { AdapterError, type GenerationRequest } from './adapters/types';
import { jpegBytes, pngB64 } from './testImages';

// A fake key: tests only check that it is sent in the header and never appears in URLs or errors.
const KEY = 'sk_test-pollinations-not-real';
const ENV = { POLLINATIONS_API_KEY: KEY } as NodeJS.ProcessEnv;

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(respond: () => Response) {
  const calls: Call[] = [];
  const impl = async (url: string, init?: RequestInit) => {
    calls.push({ url, init: init ?? {} });
    return respond();
  };
  return { impl, calls };
}

const imageRes = (bytes: Buffer, headers: Record<string, string> = {}) =>
  new Response(new Uint8Array(bytes), { status: 200, headers: { 'content-type': 'image/jpeg', ...headers } });
const jsonRes = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const header = (c: Call, name: string) => (c.init.headers as Record<string, string>)[name];

async function run(env: NodeJS.ProcessEnv, req: Partial<GenerationRequest>, respond: () => Response) {
  const f = fakeFetch(respond);
  const result = await new PollinationsGenerationAdapter(env, f.impl, () => 42).generate({ prompt: 'a white villa', ...req });
  return { result, calls: f.calls };
}

async function failure(respond: () => Response, env = ENV): Promise<AdapterError> {
  try {
    await run(env, {}, respond);
  } catch (e) {
    expect(e).toBeInstanceOf(AdapterError);
    expect((e as Error).message).not.toContain(KEY);
    return e as AdapterError;
  }
  throw new Error('expected generate() to fail');
}

describe('PollinationsGenerationAdapter', () => {
  it('is available without a key unless POLLINATIONS_DISABLED is set', async () => {
    expect(new PollinationsGenerationAdapter({} as NodeJS.ProcessEnv).isAvailable()).toBe(true);
    expect(new PollinationsGenerationAdapter({} as NodeJS.ProcessEnv).capabilities()).toEqual({ imageInput: false, keyless: true });
    expect(new PollinationsGenerationAdapter(ENV).capabilities()).toEqual({ imageInput: true });
    const off = new PollinationsGenerationAdapter({ POLLINATIONS_DISABLED: '1' } as NodeJS.ProcessEnv);
    expect(off.isAvailable()).toBe(false);
    expect(await off.generate({ prompt: 'x' }).catch((e: AdapterError) => e)).toMatchObject({ code: 'not_configured', status: 503 });
  });

  it('keyless: GETs the legacy endpoint without auth, parses the binary image and adds a note', async () => {
    const { result, calls } = await run({} as NodeJS.ProcessEnv, { aspectRatio: '16:9' }, () => imageRes(jpegBytes(1024, 576), { 'x-model-used': 'sana' }));
    const url = new URL(calls[0].url);
    expect(url.origin + url.pathname).toBe(`https://image.pollinations.ai/prompt/${encodeURIComponent('a white villa')}`);
    expect(url.searchParams.get('width')).toBe('1024');
    expect(url.searchParams.get('height')).toBe('576');
    expect(url.searchParams.get('seed')).toBe('42');
    expect(header(calls[0], 'authorization')).toBeUndefined();
    expect(result).toMatchObject({ provider: 'pollinations', model: 'sana', text: POLLINATIONS_KEYLESS_NOTE });
    expect(result.images[0]).toEqual({ base64: jpegBytes(1024, 576).toString('base64'), mediaType: 'image/jpeg' });
  });

  it('keyless with an input image: text-to-image only, says so', async () => {
    const { result, calls } = await run({} as NodeJS.ProcessEnv, { guideImages: [{ base64: pngB64(800, 400), mediaType: 'image/png' }] }, () =>
      imageRes(jpegBytes(8, 8)),
    );
    expect(calls[0].init.method).toBe('GET');
    // Original framing follows the input image (2:1)
    expect(new URL(calls[0].url).searchParams.get('height')).toBe('512');
    expect(result.text).toContain(POLLINATIONS_TEXT_ONLY_NOTE);
  });

  it('with a key: GETs gen.pollinations.ai with the Bearer header (never ?key=) and the chosen model', async () => {
    const { result, calls } = await run(ENV, { model: 'zimage', negativePrompt: 'people', imageSize: '2K' }, () => imageRes(jpegBytes(8, 8)));
    const url = new URL(calls[0].url);
    expect(url.origin).toBe('https://gen.pollinations.ai');
    expect(decodeURIComponent(url.pathname)).toBe('/image/a white villa\n\nAvoid: people');
    expect(url.searchParams.get('model')).toBe('zimage');
    expect(url.searchParams.get('width')).toBe('1440');
    expect(url.searchParams.has('key')).toBe(false);
    expect(calls[0].url).not.toContain(KEY);
    expect(header(calls[0], 'authorization')).toBe(`Bearer ${KEY}`);
    expect(result).toMatchObject({ provider: 'pollinations', model: 'zimage' });
    expect(result.text).toBeUndefined();
  });

  it('with a key and an input image: multipart /v1/images/edits with klein, parses b64_json', async () => {
    const out = pngB64(16, 16);
    const { result, calls } = await run(
      ENV,
      {
        guideImages: [
          { base64: pngB64(1000, 500), mediaType: 'image/png' },
          { base64: pngB64(10, 10), mediaType: 'image/png' },
        ],
      },
      () => jsonRes(200, { data: [{ b64_json: out }] }),
    );
    expect(calls[0].url).toBe('https://gen.pollinations.ai/v1/images/edits');
    expect(calls[0].init.method).toBe('POST');
    expect(header(calls[0], 'authorization')).toBe(`Bearer ${KEY}`);
    const form = calls[0].init.body as FormData;
    expect(form.get('model')).toBe('black-forest-labs/flux.2-klein-4b');
    expect(form.get('prompt')).toBe('a white villa');
    expect(form.get('size')).toBe('1024x512');
    expect(form.getAll('image')).toHaveLength(2);
    expect(result).toEqual({ provider: 'pollinations', model: 'klein', images: [{ base64: out, mediaType: 'image/png' }] });
  });

  it('with a key, a text-only model and an input image: GET route plus the text-only note', async () => {
    const { result, calls } = await run(ENV, { model: 'flux', guideImages: [{ base64: pngB64(10, 10), mediaType: 'image/png' }] }, () =>
      imageRes(jpegBytes(8, 8)),
    );
    expect(calls[0].init.method).toBe('GET');
    expect(result.text).toBe(POLLINATIONS_TEXT_ONLY_NOTE);
  });

  it('rejects unknown models and non-image bodies', async () => {
    const bad = await run(ENV, { model: 'gpt-image' }, () => imageRes(jpegBytes(8, 8))).catch((e: AdapterError) => e);
    expect(bad).toMatchObject({ code: 'invalid_request', status: 400 });
    const html = await failure(() => new Response('<html>busy</html>', { status: 200, headers: { 'content-type': 'text/html' } }));
    expect(html).toMatchObject({ code: 'invalid_output', status: 502 });
    const noB64 = await run(ENV, { guideImages: [{ base64: pngB64(10, 10), mediaType: 'image/png' }] }, () => jsonRes(200, { data: [{ url: 'x' }] })).catch(
      (e: AdapterError) => e,
    );
    expect(noB64).toMatchObject({ code: 'invalid_output' });
  });

  it('maps HTTP errors without leaking the key', async () => {
    expect(await failure(() => jsonRes(401, { error: 'UNAUTHORIZED', message: `bad key ${KEY}` }))).toMatchObject({ code: 'auth_failed', status: 401 });
    expect(await failure(() => jsonRes(429, { error: 'RATE_LIMITED', message: 'Too many requests' }))).toMatchObject({ code: 'rate_limited', status: 429 });
    expect(await failure(() => jsonRes(402, { error: 'PAYMENT_REQUIRED', message: 'Insufficient pollen balance' }))).toMatchObject({
      code: 'quota_exceeded',
      status: 429,
    });
    expect(await failure(() => jsonRes(429, { error: 'QUOTA', message: 'insufficient pollen' }))).toMatchObject({ code: 'quota_exceeded' });
    expect(await failure(() => new Response('oops', { status: 503 }))).toMatchObject({ code: 'upstream_error', status: 502 });
  });

  it('maps network failure', async () => {
    const f = async () => {
      throw new TypeError('fetch failed');
    };
    const err = await new PollinationsGenerationAdapter(ENV, f).generate({ prompt: 'x' }).catch((e: AdapterError) => e);
    expect(err).toMatchObject({ code: 'upstream_unreachable', status: 502 });
  });
});
