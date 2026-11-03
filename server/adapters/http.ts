// Shared fetch plumbing for the REST-based generation adapters (Gemini, OpenAI): timeout + client abort,
// upstream error parsing and HTTP status → AdapterError mapping. Keys never appear in messages.

import { ACCEPTED_MEDIA_TYPES, AdapterError, type ImageMediaType } from './types';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ProviderInfo {
  /** Human name used in messages, e.g. 'Gemini' */
  label: string;
  /** Env variable that holds the key, e.g. 'GEMINI_API_KEY' */
  keyName: string;
}

/** Removes any occurrence of the secret from text that may end up in a response or log. */
export function scrubSecret(text: string, secret: string | undefined): string {
  return secret ? text.split(secret).join('***') : text;
}

/** fetch with a hard timeout that also follows the caller's abort signal. */
export async function fetchWithTimeout(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  opts: { signal?: AbortSignal; timeoutMs: number; provider: ProviderInfo },
): Promise<Response> {
  if (opts.signal?.aborted) throw new AdapterError('aborted', 499, 'The request was cancelled.');
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, opts.timeoutMs);
  const onAbort = () => ctrl.abort();
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    return await fetchImpl(url, { ...init, signal: ctrl.signal });
  } catch {
    if (timedOut) throw new AdapterError('timeout', 504, `${opts.provider.label} did not respond in time. Try again.`);
    if (opts.signal?.aborted) throw new AdapterError('aborted', 499, 'The request was cancelled.');
    throw new AdapterError('upstream_unreachable', 502, `Could not reach the ${opts.provider.label} API from the server.`);
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

/** Reads a JSON body; a body that is not JSON maps to invalid_output. */
export async function readJson(res: Response, provider: ProviderInfo): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    throw new AdapterError('invalid_output', 502, `${provider.label} returned a response that is not JSON.`);
  }
}

/**
 * Upstream error body as { message, code }. Shapes: { error: { message, code|status } } (Gemini, OpenAI),
 * { errors: [{ message, code }] } (Cloudflare) and { error: 'CODE', message } (Pollinations).
 */
export async function readUpstreamError(res: Response): Promise<{ message: string; code: string }> {
  let text = '';
  try {
    text = await res.text();
  } catch {
    /* body unreadable: fall back to the status only */
  }
  const str = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
  try {
    const body = JSON.parse(text) as { error?: unknown; errors?: unknown; message?: unknown; code?: unknown };
    const err = body.error;
    if (err && typeof err === 'object') {
      const e = err as { message?: unknown; code?: unknown; status?: unknown };
      const code = typeof e.code === 'string' ? e.code : typeof e.status === 'string' ? e.status : '';
      return { message: str(e.message), code };
    }
    if (Array.isArray(body.errors) && body.errors.length) {
      const first = (body.errors[0] ?? {}) as { message?: unknown; code?: unknown };
      return { message: body.errors.map((x: { message?: unknown }) => str(x?.message)).filter(Boolean).join('; '), code: str(first.code) };
    }
    if (typeof err === 'string' || typeof body.message === 'string') {
      return { message: str(body.message) || str(err), code: str(err) || str(body.code) };
    }
  } catch {
    /* not JSON */
  }
  return { message: text.slice(0, 300), code: '' };
}

export function truncate(text: string, max = 300): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// Used-up or never-granted quota (does not clear by waiting a minute): Gemini "limit: 0", Cloudflare daily neurons, credits.
const QUOTA_RE =
  /limit:\s*0\b|free[_ ]tier|billing|exceeded your current quota|neurons|daily (free )?allocation|insufficient (balance|credits?|funds|pollen)|credit balance/i;

/** True when env[name] is 1 / true / yes: lets the server owner switch a keyless provider off. */
export function envFlag(env: NodeJS.ProcessEnv, name: string): boolean {
  return /^(1|true|yes|on)$/i.test(env[name]?.trim() ?? '');
}

/** HTTP status from the provider → AdapterError with a user-presentable message. */
export function mapHttpError(status: number, upstream: { message: string; code: string }, provider: ProviderInfo): AdapterError {
  const detail = truncate(upstream.message.trim());
  const keyRejected = `The ${provider.label} API key was rejected. Check ${provider.keyName} in the server .env file.`;
  if (upstream.code === 'moderation_blocked') {
    return new AdapterError('refused', 422, `${provider.label} declined this request (moderation_blocked).`);
  }
  if (status === 400) {
    if (/api[ _-]?key/i.test(upstream.message)) return new AdapterError('auth_failed', 401, keyRejected);
    return new AdapterError('invalid_request', 400, `The ${provider.label} request was rejected${detail ? `: ${detail}` : '.'}`);
  }
  if (status === 401 || status === 403) return new AdapterError('auth_failed', 401, keyRejected);
  if (status === 404) {
    return new AdapterError('invalid_request', 400, `The ${provider.label} model was not found${detail ? `: ${detail}` : '.'}`);
  }
  if (status === 413) return new AdapterError('image_too_large', 413, `The images are too large for ${provider.label}.`);
  if (status === 402) {
    // Payment required: prepaid balance / credits are 0 (Gemini prepay, Pollinations pollen, Hugging Face credits).
    return new AdapterError(
      'quota_exceeded',
      429,
      `${provider.label} has no credit left for this model (billing / prepaid balance required)${detail ? `: ${detail}` : '.'}`,
    );
  }
  if (status === 429) {
    // A quota of 0 (no free tier for the model, or billing off) never clears by waiting: say so, with the provider's reason.
    if (QUOTA_RE.test(upstream.message)) {
      return new AdapterError(
        'quota_exceeded',
        429,
        `${provider.label} quota for this model is used up or not enabled (billing / plan)${detail ? `: ${detail}` : '.'}`,
      );
    }
    return new AdapterError('rate_limited', 429, `Rate limit reached at ${provider.label}. Wait a moment and retry${detail ? ` (${detail})` : '.'}`);
  }
  return new AdapterError('upstream_error', 502, `${provider.label} returned an error (${status}).`);
}

export function normalizeOutputMediaType(v: unknown): ImageMediaType {
  const m = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return (ACCEPTED_MEDIA_TYPES as readonly string[]).includes(m) ? (m as ImageMediaType) : 'image/png';
}

/** 'Original', '' and anything that is not a W:H ratio mean "follow the input image". */
export function explicitAspect(aspect: string | undefined): string | undefined {
  const a = aspect?.trim();
  return a && /^\d{1,2}:\d{1,2}$/.test(a) ? a : undefined;
}
