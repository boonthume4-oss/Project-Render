import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from './app';
import { UnconnectedGenerationAdapter } from './adapters/generation';
import { AdapterError, type GenerationAdapter, type GenerationProvider, type GenerationRequest, type VisionAdapter } from './adapters/types';
import { MAX_GENERATION_IMAGE_BYTES } from './validation';
import { normalizeAnalysis, normalizeReference } from './normalize';

const IMG = Buffer.from('fake image bytes').toString('base64');

function fakeVision(configured: boolean, fail?: AdapterError): VisionAdapter {
  return {
    provider: 'anthropic',
    model: 'fake-model',
    isConfigured: () => configured,
    analyzeSource: async () => {
      if (fail) throw fail;
      return normalizeAnalysis({ camera: { position: 'street level' } }, { provider: 'anthropic', model: 'fake-model' });
    },
    analyzeReference: async (_img, cats) => {
      if (fail) throw fail;
      return normalizeReference({}, cats, { provider: 'anthropic', model: 'fake-model' });
    },
  };
}

let server: Server | null = null;
// Tests never build the real generation adapter: process.env could hold real keys.
async function start(vision: VisionAdapter, generation: GenerationAdapter = new UnconnectedGenerationAdapter()): Promise<string> {
  server = createApp({ vision, generation }).listen(0);
  await new Promise<void>((r) => server!.once('listening', () => r()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = null;
});

interface Body {
  error: string;
  message: string;
  camera: Record<string, string>;
  objects: unknown[];
  categories: Record<string, unknown>;
}
const json = async (r: Response): Promise<Body> => (await r.json()) as Body;

const post = (url: string, body: unknown) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('api routes', () => {
  it('GET /api/health reports configuration without leaking the key', async () => {
    const base = await start(fakeVision(false));
    const res = await fetch(`${base}/api/health`);
    expect(await json(res)).toEqual({
      ok: true,
      configured: false,
      provider: 'anthropic',
      model: 'fake-model',
      generation: { available: false, providers: [] },
    });
  });

  it('returns 503 not_configured without an API key', async () => {
    const base = await start(fakeVision(false));
    const res = await post(`${base}/api/analyze/source`, { imageBase64: IMG, mediaType: 'image/jpeg' });
    expect(res.status).toBe(503);
    expect((await json(res)).error).toBe('not_configured');
  });

  it('validates media type', async () => {
    const base = await start(fakeVision(true));
    const res = await post(`${base}/api/analyze/source`, { imageBase64: IMG, mediaType: 'image/gif' });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe('invalid_request');
  });

  it('returns a normalized AnalysisResult', async () => {
    const base = await start(fakeVision(true));
    const res = await post(`${base}/api/analyze/source`, { imageBase64: IMG, mediaType: 'image/png' });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.camera.position).toBe('street level');
    expect(body.camera.height).toBe('Unknown');
    expect(Array.isArray(body.objects)).toBe(true);
  });

  it('requires categories for reference analysis', async () => {
    const base = await start(fakeVision(true));
    const bad = await post(`${base}/api/analyze/reference`, { imageBase64: IMG, mediaType: 'image/png', categories: [] });
    expect(bad.status).toBe(400);
    const ok = await post(`${base}/api/analyze/reference`, {
      imageBase64: IMG,
      mediaType: 'image/png',
      categories: ['material'],
    });
    expect(ok.status).toBe(200);
    expect(Object.keys((await json(ok)).categories)).toEqual(['material']);
  });

  it('maps adapter errors to JSON', async () => {
    const base = await start(fakeVision(true, new AdapterError('rate_limited', 429, 'slow down')));
    const res = await post(`${base}/api/analyze/source`, { imageBase64: IMG, mediaType: 'image/png' });
    expect(res.status).toBe(429);
    expect(await json(res)).toEqual({ error: 'rate_limited', message: 'slow down' });
  });

  it('POST /api/generate is documented as not implemented', async () => {
    const base = await start(fakeVision(true));
    const res = await post(`${base}/api/generate`, { prompt: 'x' });
    expect(res.status).toBe(501);
    expect((await json(res)).error).toBe('not_implemented');
  });
});

/** Fake multi-provider adapter: records requests; providers listed in `configured` have a "key". */
function fakeGeneration(configured: GenerationProvider[], fail?: AdapterError) {
  const calls: GenerationRequest[] = [];
  const adapter: GenerationAdapter = {
    provider: 'multi',
    isAvailable: () => configured.length > 0,
    availableProviders: () => configured,
    generate: async (req) => {
      calls.push(req);
      if (fail) throw fail;
      const provider = req.provider ?? 'gemini';
      if (!configured.includes(provider)) {
        throw new AdapterError('not_configured', 503, `${provider.toUpperCase()}_API_KEY is not set on the server.`);
      }
      return { provider, model: req.model ?? 'default-model', images: [{ base64: IMG, mediaType: 'image/png' }], text: 'here you go' };
    },
  };
  return { adapter, calls };
}

interface GenBody {
  error?: string;
  message?: string;
  provider: string;
  model: string;
  images: { base64: string; mediaType: string }[];
  text?: string;
  generation: { available: boolean; providers: string[] };
}
const genJson = async (r: Response): Promise<GenBody> => (await r.json()) as GenBody;

describe('POST /api/generate', () => {
  it('health lists the configured generation providers', async () => {
    const base = await start(fakeVision(false), fakeGeneration(['gemini', 'openai']).adapter);
    const body = await genJson(await fetch(`${base}/api/health`));
    expect(body.generation).toEqual({ available: true, providers: ['gemini', 'openai'] });
  });

  it('passes provider, model, size, aspect and images to the adapter and returns the image', async () => {
    const gen = fakeGeneration(['gemini']);
    const base = await start(fakeVision(true), gen.adapter);
    const res = await post(`${base}/api/generate`, {
      prompt: '  make it photoreal  ',
      provider: 'gemini',
      model: 'gemini-3-pro-image',
      aspectRatio: '16:9',
      imageSize: '2K',
      images: [
        { imageBase64: IMG, mediaType: 'image/jpeg' },
        { imageBase64: `data:image/png;base64,${IMG}`, mediaType: '' },
      ],
    });
    expect(res.status).toBe(200);
    expect(await genJson(res)).toEqual({
      provider: 'gemini',
      model: 'gemini-3-pro-image',
      images: [{ base64: IMG, mediaType: 'image/png' }],
      text: 'here you go',
    });
    expect(gen.calls[0]).toEqual({
      prompt: 'make it photoreal',
      provider: 'gemini',
      model: 'gemini-3-pro-image',
      aspectRatio: '16:9',
      imageSize: '2K',
      guideImages: [
        { base64: IMG, mediaType: 'image/jpeg' },
        { base64: IMG, mediaType: 'image/png' },
      ],
    });
  });

  it("drops aspectRatio 'Original' so the output follows the input image", async () => {
    const gen = fakeGeneration(['gemini']);
    const base = await start(fakeVision(true), gen.adapter);
    const res = await post(`${base}/api/generate`, { prompt: 'x', aspectRatio: 'Original' });
    expect(res.status).toBe(200);
    expect(gen.calls[0].aspectRatio).toBeUndefined();
    expect('aspectRatio' in gen.calls[0]).toBe(false);
  });

  it('returns 503 not_configured when the requested provider has no key', async () => {
    const base = await start(fakeVision(true), fakeGeneration(['gemini']).adapter);
    const res = await post(`${base}/api/generate`, { prompt: 'x', provider: 'openai' });
    expect(res.status).toBe(503);
    expect((await genJson(res)).error).toBe('not_configured');
  });

  it('validates the body before calling the adapter', async () => {
    const gen = fakeGeneration(['gemini', 'openai']);
    const base = await start(fakeVision(true), gen.adapter);
    const bad = [
      { prompt: '   ' },
      { prompt: 'x', provider: 'midjourney' },
      { prompt: 'x', model: '../../secrets' },
      { prompt: 'x', aspectRatio: 'wide' },
      { prompt: 'x', imageSize: '8K' },
      { prompt: 'x', images: 'nope' },
      { prompt: 'x', images: [{ imageBase64: IMG, mediaType: 'image/gif' }] },
      { prompt: 'x', images: Array.from({ length: 15 }, () => ({ imageBase64: IMG, mediaType: 'image/png' })) },
    ];
    for (const body of bad) {
      const res = await post(`${base}/api/generate`, body);
      expect(res.status, JSON.stringify(body).slice(0, 80)).toBe(400);
      expect((await genJson(res)).error).toBe('invalid_request');
    }
    expect(gen.calls).toHaveLength(0);
  });

  it('accepts 14 images and rejects one over the 20 MB generation limit', async () => {
    const gen = fakeGeneration(['gemini']);
    const base = await start(fakeVision(true), gen.adapter);
    const ok = await post(`${base}/api/generate`, {
      prompt: 'x',
      images: Array.from({ length: 14 }, () => ({ imageBase64: IMG, mediaType: 'image/png' })),
    });
    expect(ok.status).toBe(200);
    expect(gen.calls[0].guideImages).toHaveLength(14);

    // 6 MB passes generation (vision would reject it at 5 MB); 21 MB does not.
    const six = Buffer.alloc(6 * 1024 * 1024, 1).toString('base64');
    expect((await post(`${base}/api/generate`, { prompt: 'x', images: [{ imageBase64: six, mediaType: 'image/png' }] })).status).toBe(200);
    const big = Buffer.alloc(MAX_GENERATION_IMAGE_BYTES + 1024, 1).toString('base64');
    const res = await post(`${base}/api/generate`, { prompt: 'x', images: [{ imageBase64: big, mediaType: 'image/png' }] });
    expect(res.status).toBe(413);
    expect((await genJson(res)).error).toBe('image_too_large');
  });

  it('keeps the 5 MB vision limit on the analyze endpoints', async () => {
    const base = await start(fakeVision(true));
    const six = Buffer.alloc(6 * 1024 * 1024, 1).toString('base64');
    const res = await post(`${base}/api/analyze/source`, { imageBase64: six, mediaType: 'image/png' });
    expect(res.status).toBe(413);
  });

  it('maps generation adapter errors to JSON', async () => {
    const base = await start(fakeVision(true), fakeGeneration(['gemini'], new AdapterError('refused', 422, 'Gemini declined (IMAGE_SAFETY).')).adapter);
    const res = await post(`${base}/api/generate`, { prompt: 'x' });
    expect(res.status).toBe(422);
    expect(await genJson(res)).toEqual({ error: 'refused', message: 'Gemini declined (IMAGE_SAFETY).' });
  });
});
