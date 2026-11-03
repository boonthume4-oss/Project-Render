// GenerationAdapter for Cloudflare Workers AI (free plan: 10,000 neurons per day, reset 00:00 UTC — roughly
// 170 FLUX schnell images or ~100 klein edits). Needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (a token
// with the Workers AI permission), read ONLY from process.env. CLOUDFLARE_DISABLED=1 switches it off.
// - flux-1-schnell: text-to-image, JSON body.
// - flux-2-klein-4b / flux-2-klein-9b / flux-2-dev: text- and image-to-image, multipart body with up to 4
//   input images, each smaller than 512x512 (the client must downscale them).

import { type FetchLike, type ProviderInfo, envFlag, fetchWithTimeout, mapHttpError, readUpstreamError, scrubSecret, truncate } from './http';
import { base64Head, binaryToImage, imageDimensions, outputSize, sniffMediaType, type SizeLimits } from './imageInfo';
import { AdapterError, type CallOptions, type GenerationAdapter, type GenerationRequest, type GenerationResult, type ProviderCapabilities } from './types';

export const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4/accounts';
export const DEFAULT_CLOUDFLARE_MODEL = 'flux-1-schnell';
export const DEFAULT_CLOUDFLARE_EDIT_MODEL = 'flux-2-klein-4b';
/** Short ids the app sends → Workers AI model path; multipart models accept input images. */
export const CLOUDFLARE_MODELS: Record<string, { path: string; multipart: boolean }> = {
  'flux-1-schnell': { path: '@cf/black-forest-labs/flux-1-schnell', multipart: false },
  'flux-2-klein-4b': { path: '@cf/black-forest-labs/flux-2-klein-4b', multipart: true },
  'flux-2-klein-9b': { path: '@cf/black-forest-labs/flux-2-klein-9b', multipart: true },
  'flux-2-dev': { path: '@cf/black-forest-labs/flux-2-dev', multipart: true },
};
/** Workers AI FLUX.2 takes at most 4 input images (input_image_0..3), each under 512 px per side. */
export const CLOUDFLARE_MAX_INPUT_IMAGES = 4;
export const CLOUDFLARE_MAX_INPUT_SIDE = 512;
const REQUEST_TIMEOUT_MS = 180_000;
const MAX_PROMPT = 2048;
const ACCOUNT_RE = /^[A-Za-z0-9]{1,64}$/;
const PROVIDER: ProviderInfo = { label: 'Cloudflare Workers AI', keyName: 'CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID' };
/** Longest output side: '2K' and '4K' both map here (the Render page shows it on the Upscaler, see maxOutputEdge). */
export const CLOUDFLARE_MAX_OUTPUT_SIDE = 1920;
const SIZE_LIMITS: SizeLimits = {
  longSide: { '1K': 1024, '2K': CLOUDFLARE_MAX_OUTPUT_SIDE, '4K': CLOUDFLARE_MAX_OUTPUT_SIDE },
  min: 256,
  max: CLOUDFLARE_MAX_OUTPUT_SIDE,
  step: 32,
};
const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

export const CLOUDFLARE_TEXT_ONLY_NOTE =
  'Cloudflare flux-1-schnell renders from the prompt only: the input image was not sent. Pick flux-2-klein-4b to edit the input image.';

function promptText(req: GenerationRequest): string {
  const text = req.negativePrompt?.trim() ? `${req.prompt}\n\nAvoid: ${req.negativePrompt.trim()}` : req.prompt;
  return truncate(text, MAX_PROMPT);
}

/** Base64 image from { result: { image } } (REST envelope) or { image }. */
export function parseCloudflareJson(raw: unknown): string | null {
  const data = (raw && typeof raw === 'object' ? raw : {}) as { result?: { image?: unknown }; image?: unknown };
  const image = data.result?.image ?? data.image;
  return typeof image === 'string' && image ? image.replace(/^data:[^;,]+;base64,/, '') : null;
}

export class CloudflareGenerationAdapter implements GenerationAdapter {
  readonly provider = 'cloudflare';
  private readonly accountId: string | undefined;
  private readonly apiToken: string | undefined;
  private readonly disabled: boolean;
  private readonly fetchImpl: FetchLike;

  constructor(env: NodeJS.ProcessEnv = process.env, fetchImpl: FetchLike = (input, init) => fetch(input, init)) {
    this.accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim() || undefined;
    this.apiToken = env.CLOUDFLARE_API_TOKEN?.trim() || undefined;
    this.disabled = envFlag(env, 'CLOUDFLARE_DISABLED');
    this.fetchImpl = fetchImpl;
  }

  isAvailable(): boolean {
    return !this.disabled && !!this.apiToken && !!this.accountId && ACCOUNT_RE.test(this.accountId);
  }

  capabilities(): ProviderCapabilities {
    return { imageInput: true };
  }

  async generate(req: GenerationRequest, opts: CallOptions = {}): Promise<GenerationResult> {
    if (this.disabled) throw new AdapterError('not_configured', 503, 'Cloudflare Workers AI is disabled on the server (CLOUDFLARE_DISABLED).');
    if (!this.apiToken || !this.accountId) {
      throw new AdapterError('not_configured', 503, 'CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN must both be set on the server.');
    }
    if (!ACCOUNT_RE.test(this.accountId)) throw new AdapterError('not_configured', 503, 'CLOUDFLARE_ACCOUNT_ID is not a valid account id.');
    const images = req.guideImages ?? [];
    const requested = req.model?.trim();
    if (requested && !CLOUDFLARE_MODELS[requested]) {
      throw new AdapterError('invalid_request', 400, `Unknown Cloudflare model "${requested}". Use one of: ${Object.keys(CLOUDFLARE_MODELS).join(', ')}.`);
    }
    const model = requested || (images.length ? DEFAULT_CLOUDFLARE_EDIT_MODEL : DEFAULT_CLOUDFLARE_MODEL);
    const spec = CLOUDFLARE_MODELS[model];
    const notes: string[] = [];

    let init: RequestInit;
    if (spec.multipart) {
      const sent = images.slice(0, CLOUDFLARE_MAX_INPUT_IMAGES);
      if (images.length > sent.length) notes.push(`Cloudflare accepts ${CLOUDFLARE_MAX_INPUT_IMAGES} input images; the extra ones were not sent.`);
      const dims = sent.map((img) => imageDimensions(base64Head(img.base64)));
      dims.forEach((d, i) => {
        if (d && (d.width > CLOUDFLARE_MAX_INPUT_SIDE || d.height > CLOUDFLARE_MAX_INPUT_SIDE)) {
          throw new AdapterError(
            'image_too_large',
            413,
            `Image ${i + 1} is ${d.width}x${d.height}; Cloudflare FLUX.2 needs input images of at most ${CLOUDFLARE_MAX_INPUT_SIDE}x${CLOUDFLARE_MAX_INPUT_SIDE}.`,
          );
        }
      });
      const size = outputSize(req.aspectRatio, req.imageSize, dims[0] ?? null, SIZE_LIMITS);
      const form = new FormData();
      form.append('prompt', promptText(req));
      form.append('width', String(size.width));
      form.append('height', String(size.height));
      sent.forEach((img, i) => {
        form.append(`input_image_${i}`, new Blob([Buffer.from(img.base64, 'base64')], { type: img.mediaType }), `image-${i + 1}.${EXT[img.mediaType]}`);
      });
      // fetch sets the multipart boundary content-type itself
      init = { method: 'POST', headers: { authorization: `Bearer ${this.apiToken}` }, body: form };
    } else {
      if (images.length) notes.push(CLOUDFLARE_TEXT_ONLY_NOTE);
      init = {
        method: 'POST',
        headers: { authorization: `Bearer ${this.apiToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: promptText(req), steps: 4 }),
      };
    }

    const res = await fetchWithTimeout(this.fetchImpl, `${CLOUDFLARE_API_BASE}/${this.accountId}/ai/run/${spec.path}`, init, {
      signal: opts.signal,
      timeoutMs: REQUEST_TIMEOUT_MS,
      provider: PROVIDER,
    });
    if (!res.ok) {
      const upstream = await readUpstreamError(res);
      const reason = scrubSecret(scrubSecret(upstream.message, this.apiToken), this.accountId);
      console.warn(`[api] cloudflare ${res.status}${upstream.code ? ` ${upstream.code}` : ''}: ${truncate(reason, 400)}`);
      if (res.status === 401 || res.status === 403) {
        const why = await this.diagnoseToken(opts.signal);
        console.warn(`[api] cloudflare token check: ${why}`);
        throw new AdapterError('auth_failed', 401, `Cloudflare rejected the request: ${why}`);
      }
      throw mapHttpError(res.status, { ...upstream, message: reason }, PROVIDER);
    }
    const image = await this.readImage(res);
    return { provider: 'cloudflare', model, images: [image], ...(notes.length ? { text: notes.join(' ') } : {}) };
  }

  /**
   * Why an authenticated call failed, from Cloudflare's own token-verify endpoints (user-owned and account-owned
   * tokens verify at different URLs). Says only whether the token is valid / for which kind — never its value.
   */
  private async diagnoseToken(signal?: AbortSignal): Promise<string> {
    const check = async (url: string): Promise<string | null> => {
      try {
        const r = await fetchWithTimeout(this.fetchImpl, url, { headers: { authorization: `Bearer ${this.apiToken}` } }, { signal, timeoutMs: 15_000, provider: PROVIDER });
        const j = (await r.json().catch(() => null)) as { success?: boolean; result?: { status?: string } } | null;
        return r.ok && j?.success ? (j.result?.status ?? 'active') : null;
      } catch {
        return null;
      }
    };
    const userStatus = await check('https://api.cloudflare.com/client/v4/user/tokens/verify');
    const accountStatus = userStatus ? null : await check(`${CLOUDFLARE_API_BASE}/${this.accountId}/tokens/verify`);
    const status = userStatus ?? accountStatus;
    if (!status) {
      return 'the API token is not valid (check CLOUDFLARE_API_TOKEN: use an API Token, not the Global API Key, copied in full; if .env has the key twice, the first line wins).';
    }
    if (status !== 'active') return `the API token is ${status}. Create a new Workers AI token.`;
    return 'the API token is valid but has no Workers AI access to this account. Check that CLOUDFLARE_ACCOUNT_ID is the same account and the token has the "Workers AI" permission.';
  }

  /** JSON with base64 `image` (FLUX models) or, for models that stream bytes, a raw image body. */
  private async readImage(res: Response): Promise<GenerationResult['images'][number]> {
    let buf: Uint8Array;
    try {
      buf = new Uint8Array(await res.arrayBuffer());
    } catch {
      throw new AdapterError('invalid_output', 502, 'Cloudflare Workers AI returned an unreadable response.');
    }
    const binary = binaryToImage(buf);
    if (binary) return binary;
    let raw: unknown;
    try {
      raw = JSON.parse(Buffer.from(buf).toString('utf8'));
    } catch {
      throw new AdapterError('invalid_output', 502, 'Cloudflare Workers AI returned a response that is not JSON.');
    }
    const b64 = parseCloudflareJson(raw);
    const mediaType = b64 ? sniffMediaType(base64Head(b64, 64)) : null;
    if (!b64 || !mediaType) throw new AdapterError('invalid_output', 502, 'Cloudflare Workers AI returned no image. Try again or rephrase the prompt.');
    return { base64: b64, mediaType };
  }
}
