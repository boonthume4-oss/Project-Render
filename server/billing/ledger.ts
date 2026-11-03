// Token balance + ledger (1 token = ฿1). Balances change ONLY through the security-definer RPC apply_tokens (see
// supabase/schema.sql): atomic, idempotent per `ref`, never negative. Render prices come from the same estimate the
// Render page shows (src/data/renderPricing) × TOKEN_MARKUP, rounded up to whole tokens.

import type { SupabaseClient } from '@supabase/supabase-js';
import { RENDER_ENGINES, engineSize, type RenderEngine } from '../../src/data/renderEngines';
import { UNKNOWN_RENDER_USD, USD_THB, estimateCost, unknownRenderUsd } from '../../src/data/renderPricing';
import { DEFAULT_GEMINI_IMAGE_MODEL } from '../adapters/gemini';
import { DEFAULT_OPENAI_IMAGE_MODEL } from '../adapters/openai';
import type { GenerationProvider, ImageSize } from '../adapters/types';

export type LedgerKind = 'topup' | 'render' | 'refund' | 'admin';

/** Providers that cost real money per render (billed in tokens when billing is enabled). */
export const PAID_PROVIDERS: readonly GenerationProvider[] = ['gemini', 'openai'];

export { UNKNOWN_RENDER_USD };

export const DEFAULT_MODELS: Record<string, string> = { gemini: DEFAULT_GEMINI_IMAGE_MODEL, openai: DEFAULT_OPENAI_IMAGE_MODEL };

export function isPaidProvider(provider: string | undefined): provider is GenerationProvider {
  return !!provider && (PAID_PROVIDERS as readonly string[]).includes(provider);
}

/** The Render engine for a provider + API model id (no model → the adapter's default model); null when not listed. */
export function engineForModel(provider: string, model?: string): RenderEngine | null {
  const m = model?.trim() || DEFAULT_MODELS[provider] || '';
  return RENDER_ENGINES.find((e) => e.provider === provider && e.model === m) ?? null;
}

/**
 * Estimated USD of one render; 0 for free providers. Unknown price → unknownRenderUsd (scales with size and inputs). An unlisted
 * model is refused by /api/generate when billing is on (chargeRender); here it gets the same conservative fallback.
 */
export function renderCostUsd(target: { provider: string; model?: string }, imageSize: ImageSize | undefined, inputCount: number): number {
  if (!isPaidProvider(target.provider)) return 0;
  const engine = engineForModel(target.provider, target.model);
  if (!engine) return unknownRenderUsd(imageSize, inputCount);
  if (engine.free) return 0;
  const size = engineSize(engine, imageSize);
  const est = estimateCost(engine.id, size, inputCount);
  if (est.usd !== null && Number.isFinite(est.usd)) return est.usd;
  return est.fallbackUsd ?? unknownRenderUsd(size, inputCount);
}

/** Tokens for one render: ceil(USD × USD_THB × markup), at least 1 for a paid provider; free providers 0. */
export function renderCostTokens(target: { provider: string; model?: string }, imageSize: ImageSize | undefined, inputCount: number, markup: number): number {
  if (!isPaidProvider(target.provider)) return 0;
  const m = Number.isFinite(markup) && markup > 0 ? markup : 1.2;
  const raw = renderCostUsd(target, imageSize, inputCount) * USD_THB * m;
  // the epsilon keeps float noise (5.000000001) from adding a whole token
  return Math.max(1, Math.ceil(raw - 1e-9));
}

/** apply_tokens refused because the balance would go below zero. */
export class InsufficientTokensError extends Error {
  readonly balance: number;
  constructor(balance: number) {
    super('insufficient_tokens');
    this.name = 'InsufficientTokensError';
    this.balance = balance;
  }
}

/** Any other database failure (message is the Postgres / PostgREST message; never contains keys). */
export class LedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerError';
  }
}

const toNumber = (v: unknown): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : 0;
};

/** Creates the profile row when it is missing (users created before the signup trigger). Errors are ignored. */
export async function ensureProfile(db: SupabaseClient, userId: string, email: string): Promise<void> {
  try {
    await db.from('profiles').upsert({ id: userId, email }, { onConflict: 'id', ignoreDuplicates: true });
  } catch {
    /* best effort: apply_tokens reports profile_not_found if it is still missing */
  }
}

/** Current balance in tokens (0 when the profile does not exist yet). */
export async function getBalance(db: SupabaseClient, userId: string): Promise<number> {
  const { data, error } = await db.from('profiles').select('balance').eq('id', userId).maybeSingle();
  if (error) throw new LedgerError(error.message);
  return toNumber((data as { balance?: unknown } | null)?.balance);
}

/**
 * Adds `delta` tokens (negative = debit) with a unique `ref`; returns the new balance. A ref that was applied before changes
 * nothing and returns the current balance (idempotent). Throws InsufficientTokensError when the balance would go negative.
 */
export async function applyTokens(
  db: SupabaseClient,
  userId: string,
  delta: number,
  kind: LedgerKind,
  ref: string,
  meta: Record<string, unknown> = {},
): Promise<number> {
  const { data, error } = await db.rpc('apply_tokens', { p_user: userId, p_delta: delta, p_kind: kind, p_ref: ref, p_meta: meta });
  if (error) {
    if (/insufficient_tokens/.test(error.message ?? '')) throw new InsufficientTokensError(await getBalance(db, userId).catch(() => 0));
    throw new LedgerError(error.message ?? 'apply_tokens failed');
  }
  return toNumber(data);
}
