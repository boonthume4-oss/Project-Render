// Image generation for the Render page. Paid providers are enabled by their key in the server .env
// (GEMINI_API_KEY, OPENAI_API_KEY); free ones: Cloudflare Workers AI (CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN)
// and Pollinations (works without a key; POLLINATIONS_API_KEY unlocks better models and image input,
// POLLINATIONS_DISABLED=1 turns it off). With no provider at all, /api/generate answers 501.

import { CloudflareGenerationAdapter } from './cloudflare';
import { GeminiGenerationAdapter } from './gemini';
import type { FetchLike } from './http';
import { OpenAIImageAdapter } from './openai';
import { PollinationsGenerationAdapter } from './pollinations';
import {
  AdapterError,
  GENERATION_PROVIDERS,
  type CallOptions,
  type GenerationAdapter,
  type GenerationProvider,
  type GenerationRequest,
  type GenerationResult,
  type ProviderCapabilities,
} from './types';

export const GENERATION_NOT_CONNECTED_MESSAGE =
  'Image generation is not connected. Free: set CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN (Workers AI) or remove POLLINATIONS_DISABLED. ' +
  'Paid: GEMINI_API_KEY (Nano Banana, billing required) or OPENAI_API_KEY (GPT Image) in the server .env file, then restart the server. ' +
  'Until then, copy the generated prompt into your image generator.';

export const DEFAULT_GENERATION_PROVIDER: GenerationProvider = 'gemini';

export class UnconnectedGenerationAdapter implements GenerationAdapter {
  readonly provider = 'none';
  isAvailable(): boolean {
    return false;
  }
  availableProviders(): GenerationProvider[] {
    return [];
  }
  async generate(): Promise<GenerationResult> {
    throw new AdapterError('not_implemented', 501, GENERATION_NOT_CONNECTED_MESSAGE);
  }
}

/** Routes each request to the adapter of `req.provider` (default 'gemini'). */
export class MultiProviderGenerationAdapter implements GenerationAdapter {
  readonly provider = 'multi';
  private readonly adapters: Record<GenerationProvider, GenerationAdapter>;

  constructor(adapters: Record<GenerationProvider, GenerationAdapter>) {
    this.adapters = adapters;
  }

  availableProviders(): GenerationProvider[] {
    return GENERATION_PROVIDERS.filter((p) => this.adapters[p].isAvailable());
  }

  providerCapabilities(): Partial<Record<GenerationProvider, ProviderCapabilities>> {
    const out: Partial<Record<GenerationProvider, ProviderCapabilities>> = {};
    for (const p of this.availableProviders()) out[p] = this.adapters[p].capabilities?.() ?? { imageInput: true };
    return out;
  }

  isAvailable(): boolean {
    return this.availableProviders().length > 0;
  }

  async generate(req: GenerationRequest, opts?: CallOptions): Promise<GenerationResult> {
    if (!this.isAvailable()) throw new AdapterError('not_implemented', 501, GENERATION_NOT_CONNECTED_MESSAGE);
    // No provider given: the default when it is configured, else the first configured one.
    const available = this.availableProviders();
    const provider = req.provider ?? (available.includes(DEFAULT_GENERATION_PROVIDER) ? DEFAULT_GENERATION_PROVIDER : available[0]);
    const adapter = this.adapters[provider];
    if (!adapter) throw new AdapterError('invalid_request', 400, `Unknown generation provider "${provider}".`);
    // An unconfigured provider throws its own not_configured (503) naming the missing key.
    return adapter.generate({ ...req, provider }, opts);
  }
}

export function createGenerationAdapter(env: NodeJS.ProcessEnv = process.env, fetchImpl?: FetchLike): MultiProviderGenerationAdapter {
  return new MultiProviderGenerationAdapter({
    gemini: new GeminiGenerationAdapter(env, fetchImpl),
    openai: new OpenAIImageAdapter(env, fetchImpl),
    pollinations: new PollinationsGenerationAdapter(env, fetchImpl),
    cloudflare: new CloudflareGenerationAdapter(env, fetchImpl),
  });
}
