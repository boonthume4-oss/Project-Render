import { describe, expect, it } from 'vitest';
import { createGenerationAdapter } from './adapters/generation';
import { parseGenerateBody } from './app';
import { imageDimensions, outputSize, sniffMediaType } from './adapters/imageInfo';
import { jpegBytes, pngBytes } from './testImages';

const neverFetch = async (): Promise<Response> => {
  throw new Error('no network in tests');
};
const okJpeg = async () => new Response(new Uint8Array(jpegBytes(4, 4)), { status: 200, headers: { 'content-type': 'image/jpeg' } });

describe('createGenerationAdapter', () => {
  it('lists the free providers from env: keyless Pollinations by default, Cloudflare with both vars', () => {
    expect(createGenerationAdapter({} as NodeJS.ProcessEnv, neverFetch).availableProviders()).toEqual(['pollinations']);
    const all = createGenerationAdapter(
      { GEMINI_API_KEY: 'g', OPENAI_API_KEY: 'o', CLOUDFLARE_ACCOUNT_ID: 'acc1', CLOUDFLARE_API_TOKEN: 't' } as NodeJS.ProcessEnv,
      neverFetch,
    );
    expect(all.availableProviders()).toEqual(['gemini', 'openai', 'pollinations', 'cloudflare']);
    expect(all.providerCapabilities()).toEqual({
      gemini: { imageInput: true },
      openai: { imageInput: true },
      pollinations: { imageInput: false, keyless: true },
      cloudflare: { imageInput: true },
    });
    const none = createGenerationAdapter({ POLLINATIONS_DISABLED: '1' } as NodeJS.ProcessEnv, neverFetch);
    expect(none.isAvailable()).toBe(false);
  });

  it('routes a request without provider to the first configured one when Gemini has no key', async () => {
    const result = await createGenerationAdapter({} as NodeJS.ProcessEnv, okJpeg).generate({ prompt: 'x' });
    expect(result.provider).toBe('pollinations');
  });
});

describe('parseGenerateBody provider whitelist', () => {
  it('accepts the free providers and still rejects unknown ones', () => {
    expect(parseGenerateBody({ prompt: 'x', provider: 'pollinations', model: 'klein' })).toMatchObject({ provider: 'pollinations', model: 'klein' });
    expect(parseGenerateBody({ prompt: 'x', provider: 'cloudflare', model: 'flux-2-klein-4b' })).toMatchObject({ provider: 'cloudflare' });
    expect(() => parseGenerateBody({ prompt: 'x', provider: 'huggingface' })).toThrow(/provider must be one of/);
  });
});

describe('imageInfo', () => {
  it('sniffs media types and reads PNG / JPEG / WebP dimensions', () => {
    expect(sniffMediaType(pngBytes(1, 1))).toBe('image/png');
    expect(sniffMediaType(jpegBytes(1, 1))).toBe('image/jpeg');
    expect(sniffMediaType(Buffer.from('<html>'))).toBeNull();
    expect(imageDimensions(pngBytes(640, 480))).toEqual({ width: 640, height: 480 });
    expect(imageDimensions(jpegBytes(1200, 800))).toEqual({ width: 1200, height: 800 });
    const webp = Buffer.alloc(30);
    webp.write('RIFF', 0, 'ascii');
    webp.write('WEBPVP8X', 8, 'ascii');
    webp.writeUIntLE(299, 24, 3);
    webp.writeUIntLE(199, 27, 3);
    expect(imageDimensions(webp)).toEqual({ width: 300, height: 200 });
  });

  it('computes output sizes from aspect, input ratio and limits', () => {
    const limits = { longSide: { '1K': 1024, '2K': 2048, '4K': 4096 }, min: 256, max: 1440, step: 32 } as const;
    expect(outputSize(undefined, undefined, null, limits)).toEqual({ width: 1024, height: 1024 });
    expect(outputSize('9:16', '1K', null, limits)).toEqual({ width: 576, height: 1024 });
    expect(outputSize('Original', '2K', { width: 300, height: 100 }, limits)).toEqual({ width: 1440, height: 480 });
    expect(outputSize('21:1', '1K', null, limits)).toEqual({ width: 1024, height: 256 });
  });
});
