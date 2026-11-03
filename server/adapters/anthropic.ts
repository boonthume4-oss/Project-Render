// VisionAdapter implementation backed by Anthropic Claude (@anthropic-ai/sdk).
// The API key is read ONLY from process.env.ANTHROPIC_API_KEY on the server.

import Anthropic from '@anthropic-ai/sdk';
import type { AnalysisResult, ReferenceAnalysis } from '../../src/types/index';
import { normalizeAnalysis, normalizeReference } from '../normalize';
import {
  REFERENCE_USER_TEXT,
  SOURCE_SCHEMA,
  SOURCE_SYSTEM,
  SOURCE_TH_SCHEMA,
  SOURCE_USER_TEXT,
  TRANSLATE_SYSTEM,
  referenceSchema,
  referenceSystem,
  translateUserText,
} from '../prompts';
import { AdapterError, type CallOptions, type ImageInput, type VisionAdapter } from './types';

export const DEFAULT_VISION_MODEL = 'claude-opus-5-5';

/** Models that accept the server-side refusal fallback parameter (`fallbacks: "default"`). */
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-sonnet-5-5']);
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/** The analysis now carries a full Thai mirror of the English text, so allow more time and output. */
const REQUEST_TIMEOUT_MS = 240_000;
/** English + Thai text (Thai tokenizes heavier) + adaptive thinking; the explicit client timeout keeps this non-streaming call valid. */
export const MAX_OUTPUT_TOKENS = 32_000;

type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

function readEffort(): Effort {
  const v = (process.env.VISION_EFFORT ?? '').trim();
  return (['low', 'medium', 'high', 'xhigh', 'max'] as const).includes(v as Effort) ? (v as Effort) : 'medium';
}

/** Map SDK errors to AdapterErrors with clear, user-presentable messages. Most specific first. */
export function mapSdkError(e: unknown): AdapterError {
  if (e instanceof AdapterError) return e;
  if (e instanceof Anthropic.APIUserAbortError) {
    return new AdapterError('aborted', 499, 'The request was cancelled.');
  }
  if (e instanceof Anthropic.APIConnectionTimeoutError) {
    return new AdapterError('timeout', 504, 'The vision service did not respond in time. Try again.');
  }
  if (e instanceof Anthropic.APIConnectionError) {
    return new AdapterError('upstream_unreachable', 502, 'Could not reach the Anthropic API from the server.');
  }
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
    return new AdapterError(
      'auth_failed',
      502,
      'The Anthropic API key was rejected. Check ANTHROPIC_API_KEY in the server .env file.',
    );
  }
  if (e instanceof Anthropic.RateLimitError) {
    return new AdapterError('rate_limited', 429, 'Rate limit reached at the vision provider. Wait a moment and retry.');
  }
  if (e instanceof Anthropic.NotFoundError) {
    return new AdapterError('invalid_request', 400, 'The configured VISION_MODEL was not found.');
  }
  if (e instanceof Anthropic.BadRequestError) {
    // The API reports oversized images as a 400; the message is the only discriminator available.
    if (/image/i.test(e.message) && /(exceed|too large|size|dimension|pixels)/i.test(e.message)) {
      return new AdapterError('image_too_large', 413, 'The image is too large for the vision model. Use a smaller image.');
    }
    return new AdapterError('invalid_request', 400, `The vision request was rejected: ${e.message}`);
  }
  if (e instanceof Anthropic.APIError) {
    return new AdapterError('upstream_error', 503, `The vision provider returned an error (${e.status ?? 'unknown'}).`);
  }
  return new AdapterError('upstream_error', 500, e instanceof Error ? e.message : 'Unknown error');
}

export class AnthropicVisionAdapter implements VisionAdapter {
  readonly provider = 'anthropic';
  readonly model: string;
  private client: Anthropic | null = null;
  private readonly apiKey: string | undefined;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.apiKey = env.ANTHROPIC_API_KEY?.trim() || undefined;
    this.model = env.VISION_MODEL?.trim() || DEFAULT_VISION_MODEL;
  }

  isConfigured(): boolean {
    return !!this.apiKey;
  }

  private getClient(): Anthropic {
    if (!this.apiKey) {
      throw new AdapterError('not_configured', 503, 'ANTHROPIC_API_KEY is not set on the server.');
    }
    if (!this.client) {
      this.client = new Anthropic({ apiKey: this.apiKey, timeout: REQUEST_TIMEOUT_MS, maxRetries: 2 });
    }
    return this.client;
  }

  /** One structured-output vision call; returns the parsed JSON object. */
  private async callJson(
    system: string,
    userText: string,
    image: ImageInput | null,
    schema: Record<string, unknown>,
    opts: CallOptions,
  ): Promise<unknown> {
    const client = this.getClient();
    const useFallback = FALLBACK_MODELS.has(this.model);
    let response: Anthropic.Beta.BetaMessage;
    try {
      response = await client.beta.messages.create(
        {
          model: this.model,
          max_tokens: MAX_OUTPUT_TOKENS,
          system,
          output_config: { effort: readEffort(), format: { type: 'json_schema', schema } },
          ...(useFallback ? { betas: [FALLBACK_BETA], fallbacks: 'default' as const } : {}),
          messages: [
            {
              role: 'user',
              content: [
                ...(image
                  ? [{ type: 'image' as const, source: { type: 'base64' as const, media_type: image.mediaType, data: image.base64 } }]
                  : []),
                { type: 'text' as const, text: userText },
              ],
            },
          ],
        },
        { signal: opts.signal },
      );
    } catch (e) {
      throw mapSdkError(e);
    }

    if (response.stop_reason === 'refusal') {
      throw new AdapterError('refused', 422, 'The vision model declined to analyse this image.');
    }
    if (response.stop_reason === 'max_tokens') {
      throw new AdapterError('invalid_output', 502, 'The analysis was cut off before completion. Try again.');
    }
    const textOut = response.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    if (!textOut) throw new AdapterError('invalid_output', 502, 'The vision model returned no data.');
    try {
      return JSON.parse(textOut);
    } catch {
      // Tolerate stray prose around the JSON object
      const start = textOut.indexOf('{');
      const end = textOut.lastIndexOf('}');
      if (start >= 0 && end > start) {
        try {
          return JSON.parse(textOut.slice(start, end + 1));
        } catch {
          /* fall through */
        }
      }
      throw new AdapterError('invalid_output', 502, 'The vision model returned malformed JSON.');
    }
  }

  async analyzeSource(image: ImageInput, opts: CallOptions = {}): Promise<AnalysisResult> {
    const raw = await this.callJson(SOURCE_SYSTEM, SOURCE_USER_TEXT, image, SOURCE_SCHEMA, opts);
    // Thai comes from a second, text-only call (the combined schema is too large for structured
    // output). A failed translation is not fatal: the result stays English-only and Thai falls back.
    if (raw && typeof raw === 'object') {
      try {
        const th = await this.callJson(TRANSLATE_SYSTEM, translateUserText(raw), null, SOURCE_TH_SCHEMA, opts);
        (raw as Record<string, unknown>).th = th;
      } catch (e) {
        if (opts.signal?.aborted) throw e;
        console.warn('[api] Thai translation of the source analysis failed:', e instanceof Error ? e.message : e);
      }
    }
    return normalizeAnalysis(raw, { provider: this.provider, model: this.model });
  }

  async analyzeReference(image: ImageInput, categories: string[], opts: CallOptions = {}): Promise<ReferenceAnalysis> {
    const raw = await this.callJson(
      referenceSystem(categories),
      REFERENCE_USER_TEXT,
      image,
      referenceSchema(categories),
      opts,
    );
    return normalizeReference(raw, categories, { provider: this.provider, model: this.model });
  }
}
