// GenerationAdapter for OpenAI's GPT Image models over the REST Images API.
// The API key is read ONLY from process.env.OPENAI_API_KEY on the server.

import { type FetchLike, type ProviderInfo, explicitAspect, fetchWithTimeout, mapHttpError, readJson, readUpstreamError, scrubSecret, truncate } from './http';
import { AdapterError, type CallOptions, type GenerationAdapter, type GenerationRequest, type GenerationResult, type ImageSize } from './types';

export const DEFAULT_OPENAI_IMAGE_MODEL = 'gpt-image-2.5-sunburst';
export const OPENAI_API_BASE = 'https://api.openai.com/v1/images';
const REQUEST_TIMEOUT_MS = 180_000;
const PROVIDER: ProviderInfo = { label: 'OpenAI', keyName: 'OPENAI_API_KEY' };

const SIZES = {
  '1K': { square: '1024x1024', landscape: '1536x1024', portrait: '1024x1536' },
  '2K': { square: '2048x2048', landscape: '2048x1360', portrait: '1360x2048' },
} as const;

/**
 * Output size from aspect + resolution. 4K is not offered by OpenAI, so it uses the 2K sizes.
 * Without an explicit aspect an edit follows its input ('auto'); a text-only generation is square.
 */
export function openAiSize(aspect: string | undefined, imageSize: ImageSize | undefined, hasImages: boolean): string {
  const ratio = explicitAspect(aspect);
  if (!ratio && hasImages) return 'auto';
  const table = imageSize === '2K' || imageSize === '4K' ? SIZES['2K'] : SIZES['1K'];
  if (!ratio) return table.square;
  const [w, h] = ratio.split(':').map(Number);
  const r = w / h;
  return r > 1.05 ? table.landscape : r < 0.95 ? table.portrait : table.square;
}

const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

export function buildOpenAiEditForm(req: GenerationRequest, model: string): FormData {
  const images = req.guideImages ?? [];
  const form = new FormData();
  form.append('model', model);
  form.append('prompt', promptText(req));
  form.append('size', openAiSize(req.aspectRatio, req.imageSize, images.length > 0));
  form.append('quality', 'high');
  images.forEach((img, i) => {
    form.append('image[]', new Blob([Buffer.from(img.base64, 'base64')], { type: img.mediaType }), `image-${i + 1}.${EXT[img.mediaType]}`);
  });
  return form;
}

export function buildOpenAiGenerationBody(req: GenerationRequest, model: string): Record<string, unknown> {
  return { model, prompt: promptText(req), size: openAiSize(req.aspectRatio, req.imageSize, false), quality: 'high', n: 1 };
}

function promptText(req: GenerationRequest): string {
  return req.negativePrompt?.trim() ? `${req.prompt}\n\nAvoid: ${req.negativePrompt.trim()}` : req.prompt;
}

export function parseOpenAiResponse(raw: unknown, model: string): GenerationResult {
  const data = (raw && typeof raw === 'object' ? raw : {}) as { data?: { b64_json?: unknown; revised_prompt?: unknown }[] };
  const first = data.data?.[0];
  if (!first || typeof first.b64_json !== 'string' || !first.b64_json) {
    throw new AdapterError('invalid_output', 502, 'OpenAI returned no image. Try again or rephrase the prompt.');
  }
  const text = typeof first.revised_prompt === 'string' ? first.revised_prompt.trim() : '';
  return { provider: 'openai', model, images: [{ base64: first.b64_json, mediaType: 'image/png' }], ...(text ? { text } : {}) };
}

export class OpenAIImageAdapter implements GenerationAdapter {
  readonly provider = 'openai';
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: FetchLike;

  constructor(env: NodeJS.ProcessEnv = process.env, fetchImpl: FetchLike = (input, init) => fetch(input, init)) {
    this.apiKey = env.OPENAI_API_KEY?.trim() || undefined;
    this.fetchImpl = fetchImpl;
  }

  isAvailable(): boolean {
    return !!this.apiKey;
  }

  async generate(req: GenerationRequest, opts: CallOptions = {}): Promise<GenerationResult> {
    if (!this.apiKey) throw new AdapterError('not_configured', 503, 'OPENAI_API_KEY is not set on the server.');
    const model = req.model?.trim() || DEFAULT_OPENAI_IMAGE_MODEL;
    const hasImages = (req.guideImages?.length ?? 0) > 0;
    const auth = { authorization: `Bearer ${this.apiKey}` };
    // Multipart for edits: fetch sets the boundary content-type itself.
    const init: RequestInit = hasImages
      ? { method: 'POST', headers: auth, body: buildOpenAiEditForm(req, model) }
      : {
          method: 'POST',
          headers: { ...auth, 'content-type': 'application/json' },
          body: JSON.stringify(buildOpenAiGenerationBody(req, model)),
        };
    const res = await fetchWithTimeout(this.fetchImpl, `${OPENAI_API_BASE}/${hasImages ? 'edits' : 'generations'}`, init, {
      signal: opts.signal,
      timeoutMs: REQUEST_TIMEOUT_MS,
      provider: PROVIDER,
    });
    if (!res.ok) {
      const upstream = await readUpstreamError(res);
      const reason = scrubSecret(upstream.message, this.apiKey);
      console.warn(`[api] openai ${res.status}${upstream.code ? ` ${upstream.code}` : ''}: ${truncate(reason, 400)}`);
      throw mapHttpError(res.status, { ...upstream, message: reason }, PROVIDER);
    }
    return parseOpenAiResponse(await readJson(res, PROVIDER), model);
  }
}
