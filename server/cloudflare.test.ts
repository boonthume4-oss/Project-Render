import { describe, expect, it } from 'vitest';
import { CLOUDFLARE_TEXT_ONLY_NOTE, CloudflareGenerationAdapter } from './adapters/cloudflare';
import { AdapterError, type GenerationRequest } from './adapters/types';
import { jpegB64, jpegBytes, pngB64 } from './testImages';

// Fake credentials: tests check they are sent and never appear in errors.
const TOKEN = 'cf-test-token-not-real';
const ACCOUNT = 'abc123def456';
const ENV = { CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT } as NodeJS.ProcessEnv;
const BASE = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/run/@cf/black-forest-labs`;

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(respond: (url: string) => Response) {
  const calls: Call[] = [];
  const impl = async (url: string, init?: RequestInit) => {
    calls.push({ url, init: init ?? {} });
    return respond(url);
  };
  return { impl, calls };
}

const jsonRes = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const okImage = (b64: string) => jsonRes(200, { result: { image: b64 }, success: true, errors: [] });
const header = (c: Call, name: string) => (c.init.headers as Record<string, string>)[name];

async function run(req: Partial<GenerationRequest>, respond: (url: string) => Response) {
  const f = fakeFetch(respond);
  const result = await new CloudflareGenerationAdapter(ENV, f.impl).generate({ prompt: 'a concrete pavilion', ...req });
  return { result, calls: f.calls };
}

async function failure(respond: (url: string) => Response, req: Partial<GenerationRequest> = {}): Promise<AdapterError> {
  try {
    await run(req, respond);
  } catch (e) {
    expect(e).toBeInstanceOf(AdapterError);
    expect((e as Error).message).not.toContain(TOKEN);
    expect((e as Error).message).not.toContain(ACCOUNT);
    return e as AdapterError;
  }
  throw new Error('expected generate() to fail');
}

describe('CloudflareGenerationAdapter', () => {
  it('needs both CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN, and honours CLOUDFLARE_DISABLED', async () => {
    expect(new CloudflareGenerationAdapter({} as NodeJS.ProcessEnv).isAvailable()).toBe(false);
    expect(new CloudflareGenerationAdapter({ CLOUDFLARE_API_TOKEN: TOKEN } as NodeJS.ProcessEnv).isAvailable()).toBe(false);
    expect(new CloudflareGenerationAdapter({ ...ENV, CLOUDFLARE_ACCOUNT_ID: '../x' }).isAvailable()).toBe(false);
    expect(new CloudflareGenerationAdapter({ ...ENV, CLOUDFLARE_DISABLED: 'true' }).isAvailable()).toBe(false);
    expect(new CloudflareGenerationAdapter(ENV).isAvailable()).toBe(true);
    const err = await new CloudflareGenerationAdapter({} as NodeJS.ProcessEnv).generate({ prompt: 'x' }).catch((e: AdapterError) => e);
    expect(err).toMatchObject({ code: 'not_configured', status: 503 });
  });

  it('text-to-image: POSTs JSON to flux-1-schnell with the Bearer token and parses result.image', async () => {
    const out = jpegB64(1024, 1024);
    const { result, calls } = await run({ negativePrompt: 'cars' }, () => okImage(out));
    expect(calls[0].url).toBe(`${BASE}/flux-1-schnell`);
    expect(calls[0].init.method).toBe('POST');
    expect(header(calls[0], 'authorization')).toBe(`Bearer ${TOKEN}`);
    expect(header(calls[0], 'content-type')).toBe('application/json');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ prompt: 'a concrete pavilion\n\nAvoid: cars', steps: 4 });
    expect(result).toEqual({ provider: 'cloudflare', model: 'flux-1-schnell', images: [{ base64: out, mediaType: 'image/jpeg' }] });
  });

  it('image-to-image: multipart to flux-2-klein-4b with input_image_N, width/height from aspect and size', async () => {
    const out = pngB64(16, 16);
    const imgs = Array.from({ length: 5 }, () => ({ base64: pngB64(512, 256), mediaType: 'image/png' as const }));
    const { result, calls } = await run({ guideImages: imgs, aspectRatio: '4:3', imageSize: '2K' }, () => okImage(out));
    expect(calls[0].url).toBe(`${BASE}/flux-2-klein-4b`);
    expect(header(calls[0], 'authorization')).toBe(`Bearer ${TOKEN}`);
    expect(header(calls[0], 'content-type')).toBeUndefined();
    const form = calls[0].init.body as FormData;
    expect(form.get('prompt')).toBe('a concrete pavilion');
    expect(form.get('width')).toBe('1920');
    expect(form.get('height')).toBe('1440');
    expect(form.get('input_image_0')).toBeInstanceOf(Blob);
    expect(form.get('input_image_3')).toBeInstanceOf(Blob);
    expect(form.get('input_image_4')).toBeNull();
    expect(result.images[0]).toEqual({ base64: out, mediaType: 'image/png' });
    expect(result.text).toContain('4 input images');
  });

  it('Original framing follows the first input image', async () => {
    const { calls } = await run({ guideImages: [{ base64: jpegB64(500, 250), mediaType: 'image/jpeg' }] }, () => okImage(pngB64(1, 1)));
    const form = calls[0].init.body as FormData;
    expect([form.get('width'), form.get('height')]).toEqual(['1024', '512']);
  });

  it('rejects input images over 512 px before calling the API', async () => {
    const f = fakeFetch(() => okImage(pngB64(1, 1)));
    const err = await new CloudflareGenerationAdapter(ENV, f.impl)
      .generate({ prompt: 'x', guideImages: [{ base64: pngB64(1024, 768), mediaType: 'image/png' }] })
      .catch((e: AdapterError) => e);
    expect(err).toMatchObject({ code: 'image_too_large', status: 413 });
    expect(f.calls).toHaveLength(0);
  });

  it('schnell with an input image renders from the prompt and says so', async () => {
    const { result, calls } = await run({ model: 'flux-1-schnell', guideImages: [{ base64: pngB64(100, 100), mediaType: 'image/png' }] }, () =>
      okImage(pngB64(1, 1)),
    );
    expect(calls[0].url).toBe(`${BASE}/flux-1-schnell`);
    expect(result.text).toBe(CLOUDFLARE_TEXT_ONLY_NOTE);
  });

  it('accepts a raw binary image body and rejects unknown models / missing images', async () => {
    const { result } = await run({}, () => new Response(new Uint8Array(jpegBytes(4, 4)), { status: 200, headers: { 'content-type': 'image/jpeg' } }));
    expect(result.images[0].mediaType).toBe('image/jpeg');
    expect(await failure(() => okImage('x'), { model: '../../evil' })).toMatchObject({ code: 'invalid_request', status: 400 });
    expect(await failure(() => jsonRes(200, { result: {}, success: true }))).toMatchObject({ code: 'invalid_output', status: 502 });
    expect(await failure(() => new Response('nope', { status: 200 }))).toMatchObject({ code: 'invalid_output' });
  });

  it('maps Cloudflare error envelopes without leaking the token or account id', async () => {
    const env = (status: number, code: number, message: string) => () => jsonRes(status, { success: false, errors: [{ code, message }] });
    expect(await failure(env(401, 10000, `Authentication error for ${ACCOUNT}`))).toMatchObject({ code: 'auth_failed', status: 401 });
    expect(await failure(env(403, 10000, 'Authentication error'))).toMatchObject({ code: 'auth_failed' });
    const quota = await failure(env(429, 4006, 'you have used up your daily free allocation of 10,000 neurons'));
    expect(quota).toMatchObject({ code: 'quota_exceeded', status: 429 });
    expect(quota.message).toContain('neurons');
    expect(await failure(env(429, 3036, 'Too many requests'))).toMatchObject({ code: 'rate_limited' });
    expect(await failure(env(400, 5006, 'Error: required properties at "/" are "prompt"'))).toMatchObject({ code: 'invalid_request', status: 400 });
    expect(await failure(env(500, 3043, 'Internal server error'))).toMatchObject({ code: 'upstream_error', status: 502 });
  });

  it('on 401 says whether the token itself is valid (from token-verify), never the token', async () => {
    const authFail = () => jsonRes(401, { success: false, errors: [{ code: 10000, message: 'Authentication error' }] });
    const verifyOk = () => jsonRes(200, { success: true, result: { status: 'active' } });
    const valid = await failure((url: string) => (url.includes('/tokens/verify') ? verifyOk() : authFail()));
    expect(valid).toMatchObject({ code: 'auth_failed', status: 401 });
    expect(valid.message).toContain('valid but has no Workers AI access');
    const invalid = await failure((url: string) => (url.includes('/tokens/verify') ? jsonRes(401, { success: false }) : authFail()));
    expect(invalid.message).toContain('not valid');
  });
});
