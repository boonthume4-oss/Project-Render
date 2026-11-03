// Adapter layer between the HTTP API and AI providers.
// Vision (image analysis) and image generation are deliberately separate interfaces:
// analysis turns images into text/structured data; generation is a different, opt-in pipeline.

import type { AnalysisResult, ReferenceAnalysis } from '../../src/types/index';

export const ACCEPTED_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type ImageMediaType = (typeof ACCEPTED_MEDIA_TYPES)[number];

export interface ImageInput {
  /** Raw base64 (no data: URL prefix) */
  base64: string;
  mediaType: ImageMediaType;
}

export interface CallOptions {
  /** Aborted when the HTTP client disconnects */
  signal?: AbortSignal;
}

export interface VisionAdapter {
  readonly provider: string;
  readonly model: string;
  isConfigured(): boolean;
  analyzeSource(image: ImageInput, opts?: CallOptions): Promise<AnalysisResult>;
  analyzeReference(image: ImageInput, categories: string[], opts?: CallOptions): Promise<ReferenceAnalysis>;
}

export interface GenerationRequest {
  prompt: string;
  negativePrompt?: string;
  /** Input images: the first is the main input to edit, the rest are references. */
  guideImages?: ImageInput[];
  /** Undefined = keep the input image's framing ('Original' in the UI). */
  aspectRatio?: string;
  /** Which provider renders the request; the multi-provider adapter defaults to 'gemini'. */
  provider?: GenerationProvider;
  /** Provider model id; each adapter falls back to its default. */
  model?: string;
  imageSize?: ImageSize;
}

/** Paid (key + billing): gemini, openai. Free tiers: pollinations (works keyless, text only), cloudflare (daily free quota). */
export const GENERATION_PROVIDERS = ['gemini', 'openai', 'pollinations', 'cloudflare'] as const;
export type GenerationProvider = (typeof GENERATION_PROVIDERS)[number];
export const IMAGE_SIZES = ['1K', '2K', '4K'] as const;
export type ImageSize = (typeof IMAGE_SIZES)[number];

export interface GenerationResult {
  provider: string;
  model: string;
  images: { base64: string; mediaType: ImageMediaType }[];
  /** The model's text reply, when it sent one alongside the image. */
  text?: string;
}

/** What a configured provider can do right now (reported by /api/health). */
export interface ProviderCapabilities {
  /** Input images are sent to the model (image-to-image); false = text-to-image only. */
  imageInput: boolean;
  /** Running without a key (e.g. Pollinations' anonymous endpoint). */
  keyless?: boolean;
}

export interface GenerationAdapter {
  readonly provider: string;
  isAvailable(): boolean;
  /** Providers with a key configured (multi-provider adapters); single adapters may omit it. */
  availableProviders?(): GenerationProvider[];
  /** Capabilities of each available provider (multi-provider adapters). */
  providerCapabilities?(): Partial<Record<GenerationProvider, ProviderCapabilities>>;
  /** Capabilities of a single adapter. */
  capabilities?(): ProviderCapabilities;
  generate(req: GenerationRequest, opts?: CallOptions): Promise<GenerationResult>;
}

export type AdapterErrorCode =
  | 'not_configured'
  | 'invalid_request'
  | 'image_too_large'
  | 'auth_failed'
  | 'rate_limited'
  | 'quota_exceeded'
  | 'refused'
  | 'invalid_output'
  | 'timeout'
  | 'aborted'
  | 'upstream_unreachable'
  | 'upstream_error'
  | 'not_implemented';

/** Error with an HTTP status and a stable machine-readable code that the API returns as JSON. */
export class AdapterError extends Error {
  readonly code: AdapterErrorCode;
  readonly status: number;
  constructor(code: AdapterErrorCode, status: number, message: string) {
    super(message);
    this.name = 'AdapterError';
    this.code = code;
    this.status = status;
  }
}
