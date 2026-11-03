// Omise REST client for PromptPay top-ups (https://docs.omise.co/promptpay, https://docs.omise.co/charges-api).
// Basic auth with the secret key (as the user name, empty password). Amounts go to Omise in satang (THB × 100).
// The secret key never appears in errors or logs.

import { AdapterError } from '../adapters/types';
import { type FetchLike, type ProviderInfo, fetchWithTimeout, readJson, readUpstreamError, scrubSecret, truncate } from '../adapters/http';

export const OMISE_API_BASE = 'https://api.omise.co';
const PROVIDER: ProviderInfo = { label: 'Omise', keyName: 'OMISE_SECRET_KEY' };
const TIMEOUT_MS = 20_000;
/** Omise charge ids: chrg_test_… / chrg_… */
export const CHARGE_ID_RE = /^chrg_[A-Za-z0-9_]{1,80}$/;

export type OmiseChargeStatus = 'pending' | 'successful' | 'failed' | 'expired' | 'reversed' | 'unknown';

export interface OmiseCharge {
  id: string;
  status: OmiseChargeStatus;
  paid: boolean;
  /** satang */
  amount: number;
  currency: string;
  /** PromptPay QR image (an SVG) — source.scannable_code.image.download_uri */
  qrImageUrl: string | null;
  expiresAt: string | null;
  metadata: Record<string, unknown>;
}

export interface PromptPayCharge {
  chargeId: string;
  qrImageUrl: string | null;
  expiresAt: string | null;
  status: OmiseChargeStatus;
}

const STATUSES: OmiseChargeStatus[] = ['pending', 'successful', 'failed', 'expired', 'reversed'];

/** Omise charge JSON → OmiseCharge (missing parts become null / defaults). */
export function parseCharge(raw: unknown): OmiseCharge {
  const c = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  if (c.object !== 'charge' || typeof c.id !== 'string') {
    throw new AdapterError('invalid_output', 502, 'Omise returned something that is not a charge.');
  }
  const source = (c.source && typeof c.source === 'object' ? c.source : {}) as Record<string, unknown>;
  const code = (source.scannable_code && typeof source.scannable_code === 'object' ? source.scannable_code : {}) as Record<string, unknown>;
  const image = (code.image && typeof code.image === 'object' ? code.image : {}) as Record<string, unknown>;
  const status = STATUSES.find((s) => s === c.status) ?? 'unknown';
  return {
    id: c.id,
    status,
    paid: c.paid === true,
    amount: typeof c.amount === 'number' ? c.amount : 0,
    currency: typeof c.currency === 'string' ? c.currency.toLowerCase() : '',
    qrImageUrl: typeof image.download_uri === 'string' ? image.download_uri : null,
    expiresAt: typeof c.expires_at === 'string' ? c.expires_at : null,
    metadata: c.metadata && typeof c.metadata === 'object' ? (c.metadata as Record<string, unknown>) : {},
  };
}

export class OmiseClient {
  private readonly secretKey: string;
  readonly publicKey: string;
  private readonly fetchImpl: FetchLike;

  constructor(secretKey: string, publicKey = '', fetchImpl: FetchLike = (input, init) => fetch(input, init)) {
    this.secretKey = secretKey;
    this.publicKey = publicKey;
    this.fetchImpl = fetchImpl;
  }

  /** Test keys only (skey_test_…): mark_as_paid is allowed, the UI shows the test badge. */
  get testMode(): boolean {
    return this.secretKey.startsWith('skey_test_');
  }

  private async call(method: 'GET' | 'POST', path: string, form?: URLSearchParams): Promise<OmiseCharge> {
    const headers: Record<string, string> = {
      authorization: `Basic ${Buffer.from(`${this.secretKey}:`).toString('base64')}`,
      accept: 'application/json',
    };
    if (form) headers['content-type'] = 'application/x-www-form-urlencoded';
    const res = await fetchWithTimeout(
      this.fetchImpl,
      `${OMISE_API_BASE}${path}`,
      { method, headers, ...(form ? { body: form.toString() } : {}) },
      { timeoutMs: TIMEOUT_MS, provider: PROVIDER },
    );
    if (!res.ok) {
      const up = await readUpstreamError(res);
      const detail = truncate(scrubSecret(up.message, this.secretKey));
      if (res.status === 401) throw new AdapterError('auth_failed', 502, 'The Omise secret key was rejected. Check OMISE_SECRET_KEY in the server .env file.');
      if (res.status === 404) throw new AdapterError('invalid_request', 404, 'Omise has no such charge.');
      throw new AdapterError('upstream_error', 502, `Omise returned an error (${res.status})${detail ? `: ${detail}` : '.'}`);
    }
    return parseCharge(await readJson(res, PROVIDER));
  }

  /** New PromptPay charge of `amountThb` baht; metadata (e.g. user_id, topup_id) is stored on the charge. */
  async createPromptPayCharge(amountThb: number, meta: Record<string, string> = {}): Promise<PromptPayCharge> {
    if (!Number.isInteger(amountThb) || amountThb <= 0) throw new AdapterError('invalid_request', 400, 'amountThb must be a positive integer.');
    const form = new URLSearchParams();
    form.set('amount', String(amountThb * 100));
    form.set('currency', 'thb');
    form.set('source[type]', 'promptpay');
    for (const [k, v] of Object.entries(meta)) form.set(`metadata[${k}]`, v);
    const c = await this.call('POST', '/charges', form);
    return { chargeId: c.id, qrImageUrl: c.qrImageUrl, expiresAt: c.expiresAt, status: c.status };
  }

  async retrieveCharge(id: string): Promise<OmiseCharge> {
    if (!CHARGE_ID_RE.test(id)) throw new AdapterError('invalid_request', 400, 'Not an Omise charge id.');
    return this.call('GET', `/charges/${encodeURIComponent(id)}`);
  }

  /** TEST MODE ONLY: marks a pending charge as paid (POST /charges/:id/mark_as_paid). Refuses with live keys. */
  async markAsPaid(id: string): Promise<OmiseCharge> {
    if (!this.testMode) throw new AdapterError('invalid_request', 403, 'Simulated payment is only available with Omise test keys.');
    if (!CHARGE_ID_RE.test(id)) throw new AdapterError('invalid_request', 400, 'Not an Omise charge id.');
    return this.call('POST', `/charges/${encodeURIComponent(id)}/mark_as_paid`);
  }
}
