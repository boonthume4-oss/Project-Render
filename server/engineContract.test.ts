// The Render page's engine list (src/data/renderEngines) must only send provider / model ids this server accepts.
import { describe, expect, it } from 'vitest';
import { RENDER_ENGINES } from '../src/data/renderEngines';
import { GENERATION_PROVIDERS } from './adapters/types';
import { CLOUDFLARE_MAX_INPUT_IMAGES, CLOUDFLARE_MAX_INPUT_SIDE, CLOUDFLARE_MAX_OUTPUT_SIDE, CLOUDFLARE_MODELS } from './adapters/cloudflare';
import { POLLINATIONS_MAX_OUTPUT_SIDE, POLLINATIONS_MODELS } from './adapters/pollinations';
import { MAX_GENERATION_IMAGES } from './app';

describe('render engines ↔ server contract', () => {
  it('every engine uses a known provider and stays within the request image cap', () => {
    for (const e of RENDER_ENGINES) {
      expect(GENERATION_PROVIDERS as readonly string[]).toContain(e.provider);
      expect(e.maxRefs).toBeLessThanOrEqual(MAX_GENERATION_IMAGES);
      expect(e.supportsImageInput).toBe(e.maxRefs > 0);
    }
  });

  it('free engines use model ids the adapters know, with matching image input', () => {
    for (const e of RENDER_ENGINES.filter((x) => x.provider === 'cloudflare')) {
      const spec = CLOUDFLARE_MODELS[e.model];
      expect(spec, e.id).toBeDefined();
      expect(e.supportsImageInput).toBe(spec.multipart);
      if (e.supportsImageInput) {
        expect(e.maxRefs).toBeLessThanOrEqual(CLOUDFLARE_MAX_INPUT_IMAGES);
        // the client downscales inputs to this edge; the server refuses anything larger
        expect(e.maxInputEdge).toBeDefined();
        expect(e.maxInputEdge!).toBeLessThanOrEqual(CLOUDFLARE_MAX_INPUT_SIDE);
      }
    }
    for (const e of RENDER_ENGINES.filter((x) => x.provider === 'pollinations')) {
      expect(POLLINATIONS_MODELS[e.model], e.id).toBeDefined();
      expect(e.supportsImageInput).toBe(POLLINATIONS_MODELS[e.model].imageInput);
    }
    // image-input free engines tell the Upscaler their real output cap
    for (const e of RENDER_ENGINES.filter((x) => x.free && x.supportsImageInput)) {
      expect(e.maxOutputEdge, e.id).toBe(e.provider === 'cloudflare' ? CLOUDFLARE_MAX_OUTPUT_SIDE : POLLINATIONS_MAX_OUTPUT_SIDE);
    }
    // keyless Pollinations always serves the basic model, so only that engine is marked keyless
    expect(RENDER_ENGINES.filter((e) => e.keyless).map((e) => e.model)).toEqual(['sana']);
  });
});
