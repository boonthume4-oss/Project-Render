// GenerationAdapter for Pollinations.ai (free tier). Two modes:
// - With POLLINATIONS_API_KEY (an sk_ secret key from enter.pollinations.ai, spends free "Quest Pollen"):
//   gen.pollinations.ai, models flux / zimage / sana / klein / kontext, image-to-image via /v1/images/edits.
// - Without a key: the legacy anonymous image.pollinations.ai endpoint (text-to-image only; it always serves a
//   small model whatever `model` says). Set POLLINATIONS_DISABLED=1 to switch the provider off entirely.
// The key is read ONLY from process.env and is sent in the Authorization header, never in the URL.

import { type FetchLike, type ProviderInfo, envFlag, fetchWithTimeout, mapHttpError, readJson, readUpstreamError, scrubSecret, truncate } from './http';
import { base64Head, binaryToImage, imageDimensions, outputSize, sniffMediaType, type SizeLimits } from './imageInfo';
import { AdapterError, type CallOptions, type GenerationAdapter, type GenerationRequest, type GenerationResult, type ProviderCapabilities } from './types';

export const POLLINATIONS_API_BASE = 'https://gen.pollinations.ai';
export const POLLINATIONS_LEGACY_BASE = 'https://image.pollinations.ai/prompt';
export const DEFAULT_POLLINATIONS_MODEL = 'flux';
export const DEFAULT_POLLINATIONS_EDIT_MODEL = 'klein';
/** Free-eligible models (paid_only: false) and whether they accept input images. */
export const POLLINATIONS_MODELS: Record<string, { imageInput: boolean; upstream?: string }> = {
  flux: { imageInput: false },
  zimage: { imageInput: false },
  sana: { imageInput: false },
  klein: { imageInput: true, upstream: 'black-forest-labs/flux.2-klein-4b' },
  kontext: { imageInput: true },
};
const REQUEST_TIMEOUT_MS = 180_000;
// Long prompts make the GET URL too long for some proxies.
const MAX_URL_PROMPT = 1800;
const PROVIDER: ProviderInfo = { label: 'Pollinations', keyName: 'POLLINATIONS_API_KEY' };
/** Longest output side: '2K' and '4K' both map here (the Render page shows it on the Upscaler, see maxOutputEdge). */
export const POLLINATIONS_MAX_OUTPUT_SIDE = 1440;
const SIZE_LIMITS: SizeLimits = {
  longSide: { '1K': 1024, '2K': POLLINATIONS_MAX_OUTPUT_SIDE, '4K': POLLINATIONS_MAX_OUTPUT_SIDE },
  min: 256,
  max: POLLINATIONS_MAX_OUTPUT_SIDE,
  step: 32,
};
const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

export const POLLINATIONS_TEXT_ONLY_NOTE =
  'Pollinations rendered this from the prompt only: the input image was not sent (this model or the keyless mode has no image input). ' +
  'Pick the klein or kontext model with POLLINATIONS_API_KEY set to edit the input image.';
export const POLLINATIONS_KEYLESS_NOTE =
  'Rendered by the free keyless Pollinations endpoint (basic model, text only). Set POLLINATIONS_API_KEY for better models and image input.';

function promptText(req: GenerationRequest): string {
  return req.negativePrompt?.trim() ? `${req.prompt}\n\nAvoid: ${req.negativePrompt.trim()}` : req.prompt;
}

function randomSeed(): number {
  return Math.floor(Math.random() * 2_000_000_000);
}

export class PollinationsGenerationAdapter implements GenerationAdapter {
  readonly provider = 'pollinations';
  private readonly apiKey: string | undefined;
  private readonly disabled: boolean;
  private readonly fetchImpl: FetchLike;
  private readonly seed: () => number;

  constructor(env: NodeJS.ProcessEnv = process.env, fetchImpl: FetchLike = (input, init) => fetch(input, init), seed: () => number = randomSeed) {
    this.apiKey = env.POLLINATIONS_API_KEY?.trim() || undefined;
    this.disabled = envFlag(env, 'POLLINATIONS_DISABLED');
    this.fetchImpl = fetchImpl;
    this.seed = seed;
  }

  /** Keyless mode counts as available: the anonymous endpoint needs no account. */
  isAvailable(): boolean {
    return !this.disabled;
  }

  capabilities(): ProviderCapabilities {
    return this.apiKey ? { imageInput: true } : { imageInput: false, keyless: true };
  }

  async generate(req: GenerationRequest, opts: CallOptions = {}): Promise<GenerationResult> {
    if (this.disabled) throw new AdapterError('not_configured', 503, 'Pollinations is disabled on the server (POLLINATIONS_DISABLED).');
    const images = req.guideImages ?? [];
    const requested = req.model?.trim();
    if (requested && !POLLINATIONS_MODELS[requested]) {
      throw new AdapterError('invalid_request', 400, `Unknown Pollinations model "${requested}". Use one of: ${Object.keys(POLLINATIONS_MODELS).join(', ')}.`);
    }
    const first = images[0];
    const size = outputSize(req.aspectRatio, req.imageSize, first ? imageDimensions(base64Head(first.base64)) : null, SIZE_LIMITS);

    if (!this.apiKey) {
      const result = await this.getImage(`${POLLINATIONS_LEGACY_BASE}/`, 'sana', req, size, opts, false);
      return { ...result, text: images.length ? `${POLLINATIONS_KEYLESS_NOTE} ${POLLINATIONS_TEXT_ONLY_NOTE}` : POLLINATIONS_KEYLESS_NOTE };
    }

    const model = requested || (images.length ? DEFAULT_POLLINATIONS_EDIT_MODEL : DEFAULT_POLLINATIONS_MODEL);
    if (images.length && POLLINATIONS_MODELS[model].imageInput) return this.edit(model, req, size, opts);
    const result = await this.getImage(`${POLLINATIONS_API_BASE}/image/`, model, req, size, opts, true);
    return images.length ? { ...result, text: POLLINATIONS_TEXT_ONLY_NOTE } : result;
  }

  /** Text-to-image GET route: the body is the raw image bytes. */
  private async getImage(
    base: string,
    model: string,
    req: GenerationRequest,
    size: { width: number; height: number },
    opts: CallOptions,
    withKey: boolean,
  ): Promise<GenerationResult> {
    const params = new URLSearchParams({
      model,
      width: String(size.width),
      height: String(size.height),
      seed: String(this.seed()),
      nologo: 'true',
    });
    const url = `${base}${encodeURIComponent(truncate(promptText(req), MAX_URL_PROMPT))}?${params.toString()}`;
    const headers: Record<string, string> = { accept: 'image/*' };
    if (withKey && this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    const res = await fetchWithTimeout(
      this.fetchImpl,
      url,
      { method: 'GET', headers },
      { signal: opts.signal, timeoutMs: REQUEST_TIMEOUT_MS, provider: PROVIDER },
    );
    await this.throwIfFailed(res);
    let buf: Uint8Array;
    try {
      buf = new Uint8Array(await res.arrayBuffer());
    } catch {
      throw new AdapterError('invalid_output', 502, 'Pollinations returned an unreadable response.');
    }
    const image = binaryToImage(buf);
    if (!image) throw new AdapterError('invalid_output', 502, 'Pollinations returned no image. Try again or rephrase the prompt.');
    return { provider: 'pollinations', model: res.headers.get('x-model-used')?.trim() || model, images: [image] };
  }

  /** Image-to-image: OpenAI-compatible multipart /v1/images/edits, answers { data: [{ b64_json }] }. */
  private async edit(model: string, req: GenerationRequest, size: { width: number; height: number }, opts: CallOptions): Promise<GenerationResult> {
    const form = new FormData();
    form.append('model', POLLINATIONS_MODELS[model].upstream ?? model);
    form.append('prompt', promptText(req));
    form.append('size', `${size.width}x${size.height}`);
    (req.guideImages ?? []).forEach((img, i) => {
      form.append('image', new Blob([Buffer.from(img.base64, 'base64')], { type: img.mediaType }), `image-${i + 1}.${EXT[img.mediaType]}`);
    });
    const res = await fetchWithTimeout(
      this.fetchImpl,
      `${POLLINATIONS_API_BASE}/v1/images/edits`,
      { method: 'POST', headers: { authorization: `Bearer ${this.apiKey ?? ''}` }, body: form },
      { signal: opts.signal, timeoutMs: REQUEST_TIMEOUT_MS, provider: PROVIDER },
    );
    await this.throwIfFailed(res);
    const raw = (await readJson(res, PROVIDER)) as { data?: { b64_json?: unknown }[] } | null;
    const b64 = raw?.data?.[0]?.b64_json;
    const mediaType = typeof b64 === 'string' && b64 ? sniffMediaType(base64Head(b64, 64)) : null;
    if (!mediaType || typeof b64 !== 'string')
      throw new AdapterError('invalid_output', 502, 'Pollinations returned no image. Try again or rephrase the prompt.');
    return { provider: 'pollinations', model, images: [{ base64: b64, mediaType }] };
  }

  private async throwIfFailed(res: Response): Promise<void> {
    if (res.ok) return;
    const upstream = await readUpstreamError(res);
    const reason = scrubSecret(upstream.message, this.apiKey);
    console.warn(`[api] pollinations ${res.status}${upstream.code ? ` ${upstream.code}` : ''}: ${truncate(reason, 400)}`);
    throw mapHttpError(res.status, { ...upstream, message: reason }, PROVIDER);
  }
}
