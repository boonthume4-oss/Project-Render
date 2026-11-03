// GenerationAdapter for Google's Gemini image models ("Nano Banana") over the REST generateContent API.
// The API key is read ONLY from process.env.GEMINI_API_KEY on the server.

import {
  type FetchLike,
  type ProviderInfo,
  explicitAspect,
  fetchWithTimeout,
  mapHttpError,
  normalizeOutputMediaType,
  readJson,
  readUpstreamError,
  scrubSecret,
  truncate,
} from './http';
import { AdapterError, type CallOptions, type GenerationAdapter, type GenerationRequest, type GenerationResult } from './types';

export const DEFAULT_GEMINI_IMAGE_MODEL = 'gemini-3-pro-image';
export const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const REQUEST_TIMEOUT_MS = 180_000;
const PROVIDER: ProviderInfo = { label: 'Gemini', keyName: 'GEMINI_API_KEY' };
// Model ids go into the URL path, so only plain id characters are allowed.
const MODEL_RE = /^[A-Za-z0-9._-]{1,100}$/;
const SAFETY_FINISH = new Set([
  'SAFETY',
  'IMAGE_SAFETY',
  'PROHIBITED_CONTENT',
  'IMAGE_PROHIBITED_CONTENT',
  'BLOCKLIST',
  'SPII',
  'RECITATION',
  'IMAGE_RECITATION',
]);

/**
 * Known image models (all need a billed project: the free tier has 0 image quota). Other ids that pass the
 * id check are still forwarded, so a new model works without a server change.
 */
export const GEMINI_IMAGE_MODELS = [
  'gemini-3-pro-image',
  'gemini-3.1-flash-image',
  'gemini-nano-banana-2.1',
  'gemini-3.1-flash-lite-image',
  'gemini-2.5-flash-image',
] as const;

/** gemini-2.5-flash-image and the Lite model have a single fixed (1K) output size: imageConfig.imageSize is not sent. */
export function geminiSupportsImageSize(model: string): boolean {
  return !/^gemini-2\.5/.test(model) && !/flash-lite/.test(model);
}

interface GeminiPart {
  text?: unknown;
  thought?: unknown;
  inlineData?: { mimeType?: unknown; mime_type?: unknown; data?: unknown };
  inline_data?: { mimeType?: unknown; mime_type?: unknown; data?: unknown };
}
interface GeminiResponse {
  candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: unknown }[];
  promptFeedback?: { blockReason?: unknown; blockReasonMessage?: unknown };
}

export function buildGeminiBody(req: GenerationRequest, model: string): Record<string, unknown> {
  const aspectRatio = explicitAspect(req.aspectRatio);
  const imageConfig: Record<string, string> = {};
  if (aspectRatio) imageConfig.aspectRatio = aspectRatio;
  if (req.imageSize && geminiSupportsImageSize(model)) imageConfig.imageSize = req.imageSize;
  const text = req.negativePrompt?.trim() ? `${req.prompt}\n\nAvoid: ${req.negativePrompt.trim()}` : req.prompt;
  return {
    contents: [
      {
        role: 'user',
        parts: [{ text }, ...(req.guideImages ?? []).map((img) => ({ inline_data: { mime_type: img.mediaType, data: img.base64 } }))],
      },
    ],
    generationConfig: {
      responseModalities: ['TEXT', 'IMAGE'],
      ...(Object.keys(imageConfig).length ? { imageConfig } : {}),
    },
  };
}

/** Last non-thought image part + collected text; throws refused / invalid_output when there is no image. */
export function parseGeminiResponse(raw: unknown, model: string): GenerationResult {
  const data = (raw && typeof raw === 'object' ? raw : {}) as GeminiResponse;
  const block = data.promptFeedback?.blockReason;
  if (typeof block === 'string' && block) {
    throw new AdapterError('refused', 422, `Gemini declined this prompt (${block}).`);
  }
  const candidate = data.candidates?.[0];
  let image: GenerationResult['images'][number] | null = null;
  const texts: string[] = [];
  for (const part of candidate?.content?.parts ?? []) {
    // Thinking models stream draft images/thoughts first; only the final answer counts.
    if (part.thought === true) continue;
    const inline = part.inlineData ?? part.inline_data;
    if (inline && typeof inline.data === 'string' && inline.data) {
      image = { base64: inline.data, mediaType: normalizeOutputMediaType(inline.mimeType ?? inline.mime_type) };
    } else if (typeof part.text === 'string' && part.text.trim()) {
      texts.push(part.text.trim());
    }
  }
  const text = texts.join('\n').trim();
  if (!image) {
    const finish = typeof candidate?.finishReason === 'string' ? candidate.finishReason : '';
    if (SAFETY_FINISH.has(finish)) throw new AdapterError('refused', 422, `Gemini declined to create this image (${finish}).`);
    throw new AdapterError(
      'invalid_output',
      502,
      text ? `Gemini returned no image. Model reply: ${truncate(text)}` : 'Gemini returned no image. Try again or rephrase the prompt.',
    );
  }
  return { provider: 'gemini', model, images: [image], ...(text ? { text } : {}) };
}

export class GeminiGenerationAdapter implements GenerationAdapter {
  readonly provider = 'gemini';
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: FetchLike;

  constructor(env: NodeJS.ProcessEnv = process.env, fetchImpl: FetchLike = (input, init) => fetch(input, init)) {
    this.apiKey = env.GEMINI_API_KEY?.trim() || undefined;
    this.fetchImpl = fetchImpl;
  }

  isAvailable(): boolean {
    return !!this.apiKey;
  }

  async generate(req: GenerationRequest, opts: CallOptions = {}): Promise<GenerationResult> {
    if (!this.apiKey) throw new AdapterError('not_configured', 503, 'GEMINI_API_KEY is not set on the server.');
    const model = req.model?.trim() || DEFAULT_GEMINI_IMAGE_MODEL;
    if (!MODEL_RE.test(model)) throw new AdapterError('invalid_request', 400, 'model is not a valid model id.');

    const res = await fetchWithTimeout(
      this.fetchImpl,
      `${GEMINI_API_BASE}/${encodeURIComponent(model)}:generateContent`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
        body: JSON.stringify(buildGeminiBody(req, model)),
      },
      { signal: opts.signal, timeoutMs: REQUEST_TIMEOUT_MS, provider: PROVIDER },
    );
    if (!res.ok) {
      const upstream = await readUpstreamError(res);
      const reason = scrubSecret(upstream.message, this.apiKey);
      // the provider's own reason (never the key) helps diagnose quota / billing / model access problems
      console.warn(`[api] gemini ${res.status}${upstream.code ? ` ${upstream.code}` : ''}: ${truncate(reason, 400)}`);
      throw mapHttpError(res.status, { ...upstream, message: reason }, PROVIDER);
    }
    return parseGeminiResponse(await readJson(res, PROVIDER), model);
  }
}
