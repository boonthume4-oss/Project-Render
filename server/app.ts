// Express application (no listen) so routes can be tested in isolation.

import express, { type NextFunction, type Request, type Response } from 'express';
import { AnthropicVisionAdapter } from './adapters/anthropic';
import { DEFAULT_GENERATION_PROVIDER, GENERATION_NOT_CONNECTED_MESSAGE, createGenerationAdapter } from './adapters/generation';
import {
  AdapterError,
  GENERATION_PROVIDERS,
  IMAGE_SIZES,
  type GenerationAdapter,
  type GenerationProvider,
  type GenerationRequest,
  type ImageSize,
  type VisionAdapter,
} from './adapters/types';
import { isPaidProvider } from './billing/ledger';
import { type RenderCharge, chargeRender, guardAnalysis, refundRender, registerCloudRoutes } from './cloud/routes';
import type { CloudDeps } from './cloud/supabase';
import { sanitizeCategories } from './normalize';
import { parseGenerationImage, parseImageBody } from './validation';

/** Most input images one /api/generate call accepts (Nano Banana Pro's limit). */
export const MAX_GENERATION_IMAGES = 14;
const BODY_LIMIT_MB = 80;
// Model ids end up in provider URLs, so only plain id characters are accepted.
const MODEL_RE = /^[A-Za-z0-9._-]{1,100}$/;
const ASPECT_RE = /^\d{1,2}:\d{1,2}$/;

export interface AppDeps {
  vision?: VisionAdapter;
  generation?: GenerationAdapter;
  /** Accounts + billing (Supabase / Omise). null / omitted = local mode: no login, paid engines unbilled (as before). */
  cloud?: CloudDeps | null;
}

/** Validates the /api/generate body into a GenerationRequest, or throws AdapterError(400/413). */
export function parseGenerateBody(body: unknown): GenerationRequest {
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const given = (v: unknown) => v !== undefined && v !== null && v !== '';
  const prompt = typeof b.prompt === 'string' ? b.prompt.trim() : '';
  if (!prompt) throw new AdapterError('invalid_request', 400, 'prompt is required.');

  if (given(b.provider) && !(GENERATION_PROVIDERS as readonly unknown[]).includes(b.provider)) {
    throw new AdapterError('invalid_request', 400, `provider must be one of: ${GENERATION_PROVIDERS.join(', ')}.`);
  }
  const provider = given(b.provider) ? (b.provider as GenerationProvider) : undefined;

  const model = typeof b.model === 'string' ? b.model.trim() : '';
  if (model && !MODEL_RE.test(model)) throw new AdapterError('invalid_request', 400, 'model is not a valid model id.');

  // 'Original' (or nothing) = follow the input image, so the adapter gets no aspect ratio.
  const aspectRaw = typeof b.aspectRatio === 'string' ? b.aspectRatio.trim() : '';
  const aspectRatio = aspectRaw && aspectRaw.toLowerCase() !== 'original' ? aspectRaw : undefined;
  if (aspectRatio && !ASPECT_RE.test(aspectRatio)) {
    throw new AdapterError('invalid_request', 400, 'aspectRatio must be a ratio such as 16:9, or Original.');
  }

  if (given(b.imageSize) && !(IMAGE_SIZES as readonly unknown[]).includes(b.imageSize)) {
    throw new AdapterError('invalid_request', 400, `imageSize must be one of: ${IMAGE_SIZES.join(', ')}.`);
  }
  const imageSize = given(b.imageSize) ? (b.imageSize as ImageSize) : undefined;

  let guideImages: GenerationRequest['guideImages'];
  if (given(b.images)) {
    if (!Array.isArray(b.images)) throw new AdapterError('invalid_request', 400, 'images must be an array.');
    if (b.images.length > MAX_GENERATION_IMAGES) {
      throw new AdapterError('invalid_request', 400, `At most ${MAX_GENERATION_IMAGES} images can be sent per generation.`);
    }
    guideImages = b.images.map((img, i) => parseGenerationImage(img, i));
  }

  const negativePrompt = typeof b.negativePrompt === 'string' ? b.negativePrompt.trim() : '';
  return {
    prompt,
    ...(negativePrompt ? { negativePrompt } : {}),
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(aspectRatio ? { aspectRatio } : {}),
    ...(imageSize ? { imageSize } : {}),
    ...(guideImages?.length ? { guideImages } : {}),
  };
}

function configuredProviders(generation: GenerationAdapter): string[] {
  if (generation.availableProviders) return generation.availableProviders();
  return generation.isAvailable() ? [generation.provider] : [];
}

/** AbortSignal that fires when the HTTP client disconnects before we respond. */
function clientAbortSignal(req: Request, res: Response): AbortSignal {
  const ctrl = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) ctrl.abort();
  });
  req.on('aborted', () => ctrl.abort());
  return ctrl.signal;
}

function sendError(res: Response, e: unknown) {
  const err = e instanceof AdapterError ? e : new AdapterError('upstream_error', 500, e instanceof Error ? e.message : 'Unexpected server error');
  if (res.headersSent) return;
  if (err.code === 'aborted') {
    res.status(499).end();
    return;
  }
  if (err.status >= 500) console.error(`[api] ${err.code}: ${err.message}`);
  res.status(err.status).json({ error: err.code, message: err.message });
}

export function createApp(deps: AppDeps = {}) {
  const vision = deps.vision ?? new AnthropicVisionAdapter();
  const generation = deps.generation ?? createGenerationAdapter();
  const cloud = deps.cloud ?? null;
  const app = express();

  app.disable('x-powered-by');
  // Generation requests carry up to 14 base64 images.
  app.use(express.json({ limit: `${BODY_LIMIT_MB}mb` }));

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      configured: vision.isConfigured(),
      provider: vision.provider,
      model: vision.model,
      generation: {
        available: generation.isAvailable(),
        providers: configuredProviders(generation),
        // per provider: { imageInput, keyless? } — only from adapters that report it
        ...(generation.providerCapabilities ? { capabilities: generation.providerCapabilities() } : {}),
      },
    });
  });

  app.post('/api/analyze/source', async (req, res) => {
    try {
      if (!vision.isConfigured()) {
        throw new AdapterError('not_configured', 503, 'ANTHROPIC_API_KEY is not set on the server.');
      }
      // accounts on: the owner's Anthropic key is only used for signed-in users (rate limited)
      if (cloud && !(await guardAnalysis(cloud, req, res))) return;
      const image = parseImageBody(req.body);
      const result = await vision.analyzeSource(image, { signal: clientAbortSignal(req, res) });
      res.json(result);
    } catch (e) {
      sendError(res, e);
    }
  });

  app.post('/api/analyze/reference', async (req, res) => {
    try {
      if (!vision.isConfigured()) {
        throw new AdapterError('not_configured', 503, 'ANTHROPIC_API_KEY is not set on the server.');
      }
      if (cloud && !(await guardAnalysis(cloud, req, res))) return;
      const image = parseImageBody(req.body);
      const categories = sanitizeCategories((req.body as Record<string, unknown> | undefined)?.categories);
      if (!categories.length) {
        throw new AdapterError('invalid_request', 400, 'categories must contain at least one reference category id.');
      }
      const result = await vision.analyzeReference(image, categories, { signal: clientAbortSignal(req, res) });
      res.json(result);
    } catch (e) {
      sendError(res, e);
    }
  });

  // Image generation (Render page). 501 only when no provider is configured at all; a request for a
  // provider without a key gets that adapter's 503 not_configured.
  app.post('/api/generate', async (req, res) => {
    if (!generation.isAvailable()) {
      res.status(501).json({ error: 'not_implemented', message: GENERATION_NOT_CONNECTED_MESSAGE });
      return;
    }
    let charge: RenderCharge | null = null;
    try {
      let request = parseGenerateBody(req.body);
      if (cloud) {
        // Billing: resolve the provider exactly as the multi-provider adapter would, then charge paid renders up front.
        const available = configuredProviders(generation);
        const provider = request.provider ?? (available.includes(DEFAULT_GENERATION_PROVIDER) ? DEFAULT_GENERATION_PROVIDER : available[0]);
        if (isPaidProvider(provider)) {
          request = { ...request, provider };
          charge = await chargeRender(cloud, req, res, request);
          if (!charge) return;
        }
      }
      let result;
      try {
        result = await generation.generate(request, { signal: clientAbortSignal(req, res) });
      } catch (e) {
        if (cloud && charge) await refundRender(cloud, charge);
        throw e;
      }
      res.json({
        provider: result.provider,
        model: result.model,
        images: result.images.map((img) => ({ base64: img.base64, mediaType: img.mediaType })),
        ...(result.text ? { text: result.text } : {}),
        ...(charge ? { charged: charge.charged, balance: charge.balance } : {}),
      });
    } catch (e) {
      sendError(res, e);
    }
  });

  registerCloudRoutes(app, cloud);

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'not_found', message: 'Unknown API route.' });
  });

  // JSON body errors (malformed JSON, payload too large)
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    const e = err as { type?: string; status?: number } | null;
    if (e?.type === 'entity.too.large') {
      res.status(413).json({ error: 'image_too_large', message: `Request body exceeds ${BODY_LIMIT_MB} MB.` });
      return;
    }
    if (e?.type === 'entity.parse.failed') {
      res.status(400).json({ error: 'invalid_request', message: 'Request body is not valid JSON.' });
      return;
    }
    if (err) {
      sendError(res, err);
      return;
    }
    next();
  });

  return app;
}
