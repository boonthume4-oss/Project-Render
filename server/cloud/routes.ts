// Account + billing routes: /api/config, /api/me, PromptPay top-ups (Omise), the Omise webhook, and the token charge
// around paid renders in /api/generate. Money is credited ONLY after re-reading the charge from Omise (never from the client
// or the webhook body), once per charge (ledger ref 'omise:<chargeId>'). Tokens and keys are never logged.

import { randomUUID } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import { USD_THB } from '../../src/data/renderPricing';
import { AdapterError, type GenerationRequest } from '../adapters/types';
import { InsufficientTokensError, applyTokens, engineForModel, ensureProfile, getBalance, renderCostTokens } from '../billing/ledger';
import { CHARGE_ID_RE, type OmiseCharge, type OmiseChargeStatus } from '../billing/omise';
import { type CloudDeps, DEFAULT_TOKEN_MARKUP, type VerifiedUser, isExempt, verifyUser } from './supabase';

export const TOPUP_MIN_THB = 20;
export const TOPUP_MAX_THB = 50_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The webhook answers 200 after at most this long, even when the Omise re-read is still running. */
const WEBHOOK_MAX_WAIT_MS = 5_000;

interface TopupRow {
  id: string;
  user_id: string;
  omise_charge_id: string | null;
  amount_thb: number;
  status: string;
  credited_at: string | null;
}

function fail(res: Response, status: number, error: string, message: string, extra: Record<string, unknown> = {}) {
  if (!res.headersSent) res.status(status).json({ error, message, ...extra });
}

function sendRouteError(res: Response, e: unknown) {
  if (e instanceof AdapterError) {
    if (e.status >= 500) console.error(`[cloud] ${e.code}: ${e.message}`);
    fail(res, e.status, e.code, e.message);
    return;
  }
  console.error(`[cloud] ${e instanceof Error ? e.message : 'unexpected error'}`);
  fail(res, 500, 'server_error', 'Unexpected server error.');
}

/** GET /api/config body. Without Supabase: accounts and billing off (the app runs locally as before). */
export function publicConfig(cloud: CloudDeps | null | undefined) {
  if (!cloud) return { supabase: null, billing: { enabled: false, markup: DEFAULT_TOKEN_MARKUP, usdThb: USD_THB, omise: null } };
  const { config, omise } = cloud;
  return {
    supabase: { url: config.supabaseUrl, anonKey: config.anonKey },
    billing: {
      enabled: true,
      markup: config.markup,
      usdThb: USD_THB,
      omise: omise ? { publicKey: omise.publicKey, testMode: omise.testMode } : null,
    },
  };
}

async function requireUser(cloud: CloudDeps, req: Request, res: Response): Promise<VerifiedUser | null> {
  const user = await verifyUser(cloud.db, req);
  if (!user) fail(res, 401, 'login_required', 'Sign in to continue.');
  return user;
}

async function findTopup(cloud: CloudDeps, column: 'id' | 'omise_charge_id', value: string): Promise<TopupRow | null> {
  const { data, error } = await cloud.db.from('topups').select('*').eq(column, value).maybeSingle();
  if (error) throw new Error(`topups read failed: ${error.message}`);
  return (data as TopupRow | null) ?? null;
}

/**
 * Settles a top-up from a charge freshly retrieved from Omise: credits `amount_thb` tokens once when the charge is successful,
 * paid, in THB, for the stored amount and belongs to this top-up; otherwise records the charge status. Returns the status.
 */
export async function settleTopup(cloud: CloudDeps, topup: TopupRow, charge: OmiseCharge): Promise<OmiseChargeStatus> {
  if (charge.id !== topup.omise_charge_id) throw new Error('charge does not belong to the top-up');
  const metaTopup = charge.metadata.topup_id;
  const matches = charge.currency === 'thb' && charge.amount === topup.amount_thb * 100 && (metaTopup === undefined || metaTopup === topup.id);
  if (charge.status === 'successful' && charge.paid) {
    if (!matches) {
      console.error(`[cloud] top-up ${topup.id}: charge amount / currency / metadata mismatch — not credited`);
      return 'failed';
    }
    await applyTokens(cloud.db, topup.user_id, topup.amount_thb, 'topup', `omise:${charge.id}`, { topup_id: topup.id, charge_id: charge.id });
    if (!topup.credited_at) {
      await cloud.db.from('topups').update({ status: 'successful', credited_at: new Date().toISOString() }).eq('id', topup.id);
    }
    return 'successful';
  }
  if (charge.status !== topup.status && !topup.credited_at) await cloud.db.from('topups').update({ status: charge.status }).eq('id', topup.id);
  return charge.status;
}

async function ownTopup(cloud: CloudDeps, user: VerifiedUser, req: Request, res: Response): Promise<TopupRow | null> {
  const id = String(req.params.id ?? '');
  const topup = UUID_RE.test(id) ? await findTopup(cloud, 'id', id) : null;
  if (!topup || topup.user_id !== user.id) {
    fail(res, 404, 'not_found', 'No such top-up.');
    return null;
  }
  return topup;
}

async function checkAndRespond(cloud: CloudDeps, user: VerifiedUser, topup: TopupRow, res: Response, charge?: OmiseCharge) {
  if (!topup.omise_charge_id) {
    res.json({ status: 'failed', balance: await getBalance(cloud.db, user.id) });
    return;
  }
  if (!cloud.omise) throw new AdapterError('not_configured', 503, 'Top-up is not configured on the server (OMISE_SECRET_KEY).');
  const fresh = charge && charge.id === topup.omise_charge_id ? charge : await cloud.omise.retrieveCharge(topup.omise_charge_id);
  const status = await settleTopup(cloud, topup, fresh);
  res.json({ status, balance: await getBalance(cloud.db, user.id) });
}

export function registerCloudRoutes(app: Express, cloud: CloudDeps | null | undefined): void {
  app.get('/api/config', (_req, res) => {
    res.json(publicConfig(cloud));
  });

  if (!cloud) {
    const off = (_req: Request, res: Response) => fail(res, 503, 'not_configured', 'Accounts are not configured on this server (Supabase).');
    app.get('/api/me', off);
    app.post('/api/topup/promptpay', off);
    app.get('/api/topup/:id', off);
    app.post('/api/topup/:id/test-pay', off);
    // nothing to credit: acknowledge so Omise stops retrying
    app.post('/api/omise/webhook', (_req, res) => res.status(200).json({ ok: true }));
    return;
  }

  app.get('/api/me', async (req, res) => {
    try {
      const user = await requireUser(cloud, req, res);
      if (!user) return;
      await ensureProfile(cloud.db, user.id, user.email);
      res.json({ email: user.email, balance: await getBalance(cloud.db, user.id), exempt: isExempt(cloud.config, user) });
    } catch (e) {
      sendRouteError(res, e);
    }
  });

  app.post('/api/topup/promptpay', async (req, res) => {
    try {
      const user = await requireUser(cloud, req, res);
      if (!user) return;
      const amountThb = (req.body as Record<string, unknown> | undefined)?.amountThb;
      if (typeof amountThb !== 'number' || !Number.isInteger(amountThb) || amountThb < TOPUP_MIN_THB || amountThb > TOPUP_MAX_THB) {
        fail(res, 400, 'invalid_request', `amountThb must be a whole number of baht from ${TOPUP_MIN_THB} to ${TOPUP_MAX_THB}.`);
        return;
      }
      if (!cloud.omise) throw new AdapterError('not_configured', 503, 'Top-up is not configured on the server (OMISE_SECRET_KEY).');
      await ensureProfile(cloud.db, user.id, user.email);
      const { data, error } = await cloud.db.from('topups').insert({ user_id: user.id, amount_thb: amountThb }).select('id').single();
      const topupId = (data as { id?: string } | null)?.id;
      if (error || !topupId) throw new Error(`topups insert failed: ${error?.message ?? 'no id'}`);
      let charge;
      try {
        charge = await cloud.omise.createPromptPayCharge(amountThb, { user_id: user.id, topup_id: topupId });
      } catch (e) {
        await cloud.db.from('topups').update({ status: 'failed' }).eq('id', topupId);
        throw e;
      }
      await cloud.db.from('topups').update({ omise_charge_id: charge.chargeId, status: charge.status }).eq('id', topupId);
      if (!charge.qrImageUrl) throw new AdapterError('invalid_output', 502, 'Omise did not return a PromptPay QR code.');
      res.json({ topupId, qrImageUrl: charge.qrImageUrl, expiresAt: charge.expiresAt, amountThb });
    } catch (e) {
      sendRouteError(res, e);
    }
  });

  app.get('/api/topup/:id', async (req, res) => {
    try {
      const user = await requireUser(cloud, req, res);
      if (!user) return;
      const topup = await ownTopup(cloud, user, req, res);
      if (topup) await checkAndRespond(cloud, user, topup, res);
    } catch (e) {
      sendRouteError(res, e);
    }
  });

  app.post('/api/topup/:id/test-pay', async (req, res) => {
    try {
      const user = await requireUser(cloud, req, res);
      if (!user) return;
      if (!cloud.omise?.testMode) {
        fail(res, 403, 'test_mode_only', 'Simulated payment is only available with Omise test keys.');
        return;
      }
      const topup = await ownTopup(cloud, user, req, res);
      if (!topup) return;
      if (!topup.omise_charge_id) {
        fail(res, 409, 'invalid_request', 'This top-up has no charge.');
        return;
      }
      let charge: OmiseCharge | undefined;
      if (!topup.credited_at) {
        const current = await cloud.omise.retrieveCharge(topup.omise_charge_id);
        // only a pending charge can be marked as paid; the result is re-read below either way
        if (current.status === 'pending') await cloud.omise.markAsPaid(topup.omise_charge_id);
        else charge = current;
      }
      await checkAndRespond(cloud, user, topup, res, charge);
    } catch (e) {
      sendRouteError(res, e);
    }
  });

  app.post('/api/omise/webhook', async (req, res) => {
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const data = (body.data && typeof body.data === 'object' ? body.data : {}) as Record<string, unknown>;
    const chargeId = body.key === 'charge.complete' && typeof data.id === 'string' && CHARGE_ID_RE.test(data.id) ? data.id : null;
    if (chargeId && cloud.omise) {
      const omise = cloud.omise;
      // only the id is taken from the body: amount and status come from Omise itself
      const work = (async () => {
        const topup = await findTopup(cloud, 'omise_charge_id', chargeId);
        if (!topup) return;
        await settleTopup(cloud, topup, await omise.retrieveCharge(chargeId));
      })().catch((e: unknown) => console.error(`[cloud] webhook ${chargeId}: ${e instanceof Error ? e.message : 'failed'}`));
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([work, new Promise<void>((r) => (timer = setTimeout(r, WEBHOOK_MAX_WAIT_MS)))]);
      clearTimeout(timer);
    }
    res.status(200).json({ ok: true });
  });
}

/* ------------------------------------------------------------------ */
/* Image analysis (Anthropic vision, paid by the owner's key)          */
/* ------------------------------------------------------------------ */

/** Analyses one signed-in (non-exempt) account may run per rolling hour; the vision API is billed to the owner's key. */
export const ANALYZE_LIMIT_PER_HOUR = 30;
const ANALYZE_WINDOW_MS = 60 * 60 * 1000;
/** per CloudDeps (one per server; tests get their own): user id → start times of recent analyses */
const analyzeLog = new WeakMap<CloudDeps, Map<string, number[]>>();

/**
 * Before /api/analyze/*: with accounts on, requires a signed-in user (401 login_required) and limits each non-exempt account to
 * ANALYZE_LIMIT_PER_HOUR analyses (429 rate_limited), so an anonymous script cannot run up the owner's Anthropic bill.
 * Returns false when it already answered the request.
 */
export async function guardAnalysis(cloud: CloudDeps, req: Request, res: Response, now: number = Date.now()): Promise<boolean> {
  const user = await requireUser(cloud, req, res);
  if (!user) return false;
  if (isExempt(cloud.config, user)) return true;
  let log = analyzeLog.get(cloud);
  if (!log) analyzeLog.set(cloud, (log = new Map()));
  const recent = (log.get(user.id) ?? []).filter((t) => now - t < ANALYZE_WINDOW_MS);
  if (recent.length >= ANALYZE_LIMIT_PER_HOUR) {
    log.set(user.id, recent);
    fail(res, 429, 'rate_limited', 'Too many image analyses. Please wait a while and try again.');
    return false;
  }
  recent.push(now);
  log.set(user.id, recent);
  return true;
}

/* ------------------------------------------------------------------ */
/* Paid renders in /api/generate                                       */
/* ------------------------------------------------------------------ */

export interface RenderCharge {
  /** tokens debited (0 for the exempt owner) */
  charged: number;
  /** balance after the debit */
  balance: number;
  /** ledger ref suffix of the debit (refund uses 'refund:<id>'); null when nothing was debited */
  id: string | null;
  userId: string;
}

/**
 * Before a paid render: requires a signed-in user (401 login_required), skips the exempt owner, otherwise debits the price
 * (402 insufficient_tokens with { needed, balance }). Returns null when it already answered the request.
 */
export async function chargeRender(cloud: CloudDeps, req: Request, res: Response, request: GenerationRequest): Promise<RenderCharge | null> {
  const user = await requireUser(cloud, req, res);
  if (!user) return null;
  if (isExempt(cloud.config, user)) {
    return { charged: 0, balance: await getBalance(cloud.db, user.id).catch(() => 0), id: null, userId: user.id };
  }
  // only listed (priced) engines are billed: an unlisted model id could cost more than any fallback estimate
  if (!engineForModel(request.provider ?? '', request.model)) {
    fail(res, 400, 'invalid_request', 'This model is not available for paid renders.');
    return null;
  }
  const needed = renderCostTokens(
    { provider: request.provider ?? '', model: request.model },
    request.imageSize,
    request.guideImages?.length ?? 0,
    cloud.config.markup,
  );
  const id = randomUUID();
  try {
    const balance = await applyTokens(cloud.db, user.id, -needed, 'render', `render:${id}`, {
      provider: request.provider,
      model: request.model ?? null,
      imageSize: request.imageSize ?? null,
      inputs: request.guideImages?.length ?? 0,
    });
    return { charged: needed, balance, id, userId: user.id };
  } catch (e) {
    if (e instanceof InsufficientTokensError) {
      fail(res, 402, 'insufficient_tokens', `This render needs ${needed} tokens.`, { needed, balance: e.balance });
      return null;
    }
    throw e;
  }
}

/** Gives the tokens of a failed paid render back (ref 'refund:<id>', idempotent). Returns the new balance, or null on failure. */
export async function refundRender(cloud: CloudDeps, charge: RenderCharge): Promise<number | null> {
  if (!charge.id || charge.charged <= 0) return null;
  try {
    return await applyTokens(cloud.db, charge.userId, charge.charged, 'refund', `refund:${charge.id}`, { render: charge.id });
  } catch (e) {
    console.error(`[cloud] refund of render ${charge.id} failed: ${e instanceof Error ? e.message : 'unknown error'}`);
    return null;
  }
}
