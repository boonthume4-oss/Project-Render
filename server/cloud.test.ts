import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from './app';
import { AdapterError, type GenerationAdapter, type GenerationProvider, type GenerationRequest, type VisionAdapter } from './adapters/types';
import { UNKNOWN_RENDER_USD, applyTokens, engineForModel, isPaidProvider, renderCostTokens } from './billing/ledger';
import { OmiseClient, parseCharge } from './billing/omise';
import { ANALYZE_LIMIT_PER_HOUR } from './cloud/routes';
import { bearerToken, createCloudFromEnv, parseMarkup, readCloudConfig, verifyUser } from './cloud/supabase';
import type { CloudDeps } from './cloud/supabase';
import { createFakeDb, createFakeOmise, fakeCloud, type FakeDb } from './testCloud';
import { pngB64 } from './testImages';
import { UNKNOWN_INPUT_USD, UNKNOWN_OUTPUT_USD, USD_THB } from '../src/data/renderPricing';

const IMG = pngB64(64, 64);
const USER = { id: '11111111-1111-4111-8111-111111111111', email: 'user@example.com' };
const OTHER = { id: '22222222-2222-4222-8222-222222222222', email: 'other@example.com' };

const vision: VisionAdapter = {
  provider: 'anthropic',
  model: 'fake',
  isConfigured: () => false,
  analyzeSource: async () => {
    throw new Error('unused');
  },
  analyzeReference: async () => {
    throw new Error('unused');
  },
};

function fakeGeneration(fail?: AdapterError) {
  const calls: GenerationRequest[] = [];
  const adapter: GenerationAdapter = {
    provider: 'multi',
    isAvailable: () => true,
    availableProviders: (): GenerationProvider[] => ['gemini', 'openai', 'pollinations'],
    generate: async (req) => {
      calls.push(req);
      if (fail) throw fail;
      return { provider: req.provider ?? 'gemini', model: req.model ?? 'm', images: [{ base64: IMG, mediaType: 'image/png' }] };
    },
  };
  return { adapter, calls };
}

let server: Server | null = null;
async function start(cloud: CloudDeps | null, generation: GenerationAdapter = fakeGeneration().adapter): Promise<string> {
  server = createApp({ vision, generation, cloud }).listen(0);
  await new Promise<void>((r) => server!.once('listening', () => r()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = null;
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;
const req = async (url: string, opts: { method?: string; token?: string; body?: unknown } = {}): Promise<{ status: number; body: J }> => {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const res = await fetch(url, {
    method: opts.method ?? (opts.body === undefined ? 'GET' : 'POST'),
    headers,
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

function seed(db: FakeDb, balance = 0) {
  db.tokens.set('tok-user', USER);
  db.tokens.set('tok-other', OTHER);
  db.tables.profiles.push({ id: USER.id, email: USER.email, balance });
  db.tables.profiles.push({ id: OTHER.id, email: OTHER.email, balance: 0 });
}

describe('cloud config', () => {
  it('reads env, trims the URL and parses the markup and exempt list', () => {
    const c = readCloudConfig({ SUPABASE_URL: 'https://x.supabase.co///', TOKEN_MARKUP: '1.5', BILLING_EXEMPT_EMAILS: ' Owner@X.com , ,b@y.co' });
    expect(c.supabaseUrl).toBe('https://x.supabase.co');
    expect(c.markup).toBe(1.5);
    expect(c.exemptEmails).toEqual(['owner@x.com', 'b@y.co']);
    expect(parseMarkup('abc')).toBe(1.2);
    expect(parseMarkup('-1')).toBe(1.2);
    expect(parseMarkup(undefined)).toBe(1.2);
  });

  it('is local mode (null) without all three Supabase values', () => {
    expect(createCloudFromEnv({})).toBeNull();
    expect(createCloudFromEnv({ SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'a' })).toBeNull();
  });

  it('GET /api/config without Supabase: accounts and billing off', async () => {
    const base = await start(null);
    const r = await req(`${base}/api/config`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ supabase: null, billing: { enabled: false, markup: 1.2, usdThb: USD_THB, omise: null } });
    expect((await req(`${base}/api/me`, { token: 'x' })).status).toBe(503);
    expect((await req(`${base}/api/omise/webhook`, { body: { key: 'charge.complete', data: { id: 'chrg_test_1' } } })).status).toBe(200);
  });

  it('GET /api/config with Supabase serves the anon key but never the service role or Omise secret', async () => {
    const db = createFakeDb();
    const base = await start(fakeCloud(db, createFakeOmise(), { markup: '1.3' }));
    const r = await req(`${base}/api/config`);
    expect(r.body).toEqual({
      supabase: { url: 'https://example.supabase.co', anonKey: 'anon-public-test' },
      billing: { enabled: true, markup: 1.3, usdThb: USD_THB, omise: { publicKey: 'pkey_test_123', testMode: true } },
    });
    const text = JSON.stringify(r.body);
    expect(text).not.toContain('service-role-test');
    expect(text).not.toContain('skey_');
  });
});

describe('verifyUser', () => {
  it('reads only a Bearer token and verifies it with Supabase Auth', async () => {
    const db = createFakeDb();
    db.tokens.set('good', { id: 'u1', email: 'A@B.co' });
    expect(bearerToken({ headers: { authorization: 'Bearer good' } })).toBe('good');
    expect(bearerToken({ headers: { authorization: 'Basic good' } })).toBeNull();
    expect(await verifyUser(db.client, { headers: { authorization: 'Bearer good' } })).toEqual({ id: 'u1', email: 'a@b.co', confirmed: true });
    db.tokens.set('unconfirmed', { id: 'u2', email: 'c@d.co', confirmed: false });
    expect(await verifyUser(db.client, { headers: { authorization: 'Bearer unconfirmed' } })).toMatchObject({ id: 'u2', confirmed: false });
    expect(await verifyUser(db.client, { headers: { authorization: 'Bearer bad' } })).toBeNull();
    expect(await verifyUser(db.client, { headers: {} })).toBeNull();
  });

  it('GET /api/me requires login and reports balance and exemption', async () => {
    const db = createFakeDb();
    seed(db, 42);
    const base = await start(fakeCloud(db, false, { exempt: 'USER@example.com' }));
    expect((await req(`${base}/api/me`)).body.error).toBe('login_required');
    expect((await req(`${base}/api/me`, { token: 'nope' })).status).toBe(401);
    expect((await req(`${base}/api/me`, { token: 'tok-user' })).body).toEqual({ email: USER.email, balance: 42, exempt: true });
    expect((await req(`${base}/api/me`, { token: 'tok-other' })).body).toEqual({ email: OTHER.email, balance: 0, exempt: false });
  });

  it('an exempt address with an unconfirmed email is not exempt (no free renders by signing up as the owner)', async () => {
    const db = createFakeDb();
    seed(db, 100);
    db.tokens.set('tok-user', { ...USER, confirmed: false });
    const gen = fakeGeneration();
    const base = await start(fakeCloud(db, false, { exempt: USER.email }), gen.adapter);
    expect((await req(`${base}/api/me`, { token: 'tok-user' })).body).toMatchObject({ exempt: false });
    const body = { prompt: 'x', provider: 'gemini', model: 'gemini-3-pro-image', imageSize: '2K' };
    const r = await req(`${base}/api/generate`, { body, token: 'tok-user' });
    expect(r.status).toBe(200);
    expect(r.body.charged).toBeGreaterThan(0);
  });

  it('GET /api/me creates a missing profile', async () => {
    const db = createFakeDb();
    db.tokens.set('t', { id: 'new-user', email: 'n@x.co' });
    const base = await start(fakeCloud(db, false));
    expect((await req(`${base}/api/me`, { token: 't' })).body).toEqual({ email: 'n@x.co', balance: 0, exempt: false });
    expect(db.tables.profiles.some((p) => p.id === 'new-user')).toBe(true);
  });
});

describe('render cost in tokens', () => {
  it('ceil(USD × USD_THB × markup), min 1, free providers 0', () => {
    // Nano Banana Pro 2K, no input images: $0.134
    expect(renderCostTokens({ provider: 'gemini', model: 'gemini-3-pro-image' }, '2K', 0, 1.2)).toBe(Math.ceil(0.134 * USD_THB * 1.2));
    // default model = Pro; 4K with 2 inputs
    const usd = 0.24 + 2 * ((560 * 2) / 1e6);
    expect(renderCostTokens({ provider: 'gemini' }, '4K', 2, 1)).toBe(Math.ceil(usd * USD_THB));
    // cheapest paid engine still costs at least 1 token
    expect(renderCostTokens({ provider: 'gemini', model: 'gemini-3.1-flash-lite-image' }, undefined, 0, 0.01)).toBe(1);
    // unknown official price (gpt-image) and unknown models use the conservative fallback
    expect(renderCostTokens({ provider: 'openai' }, '1K', 0, 1.2)).toBe(Math.ceil(UNKNOWN_RENDER_USD * USD_THB * 1.2));
    expect(renderCostTokens({ provider: 'gemini', model: 'gemini-9-image' }, '1K', 0, 1)).toBe(Math.ceil(UNKNOWN_RENDER_USD * USD_THB));
    // the fallback grows with the output size and every input image
    expect(renderCostTokens({ provider: 'openai' }, '2K', 14, 1)).toBe(Math.ceil((UNKNOWN_OUTPUT_USD['2K'] + 14 * UNKNOWN_INPUT_USD) * USD_THB));
    expect(renderCostTokens({ provider: 'openai' }, '2K', 14, 1)).toBeGreaterThan(renderCostTokens({ provider: 'openai' }, '1K', 0, 1));
    expect(renderCostTokens({ provider: 'pollinations' }, '1K', 3, 1.2)).toBe(0);
    expect(renderCostTokens({ provider: 'cloudflare' }, '1K', 3, 1.2)).toBe(0);
    expect(isPaidProvider('openai')).toBe(true);
    expect(isPaidProvider('cloudflare')).toBe(false);
    expect(engineForModel('gemini')?.id).toBe('nano-banana-pro');
  });

  it('applyTokens is idempotent per ref and never goes negative', async () => {
    const db = createFakeDb();
    seed(db, 10);
    expect(await applyTokens(db.client, USER.id, 5, 'topup', 'r1')).toBe(15);
    expect(await applyTokens(db.client, USER.id, 5, 'topup', 'r1')).toBe(15);
    await expect(applyTokens(db.client, USER.id, -16, 'render', 'r2')).rejects.toMatchObject({ name: 'InsufficientTokensError', balance: 15 });
    expect(db.tables.token_ledger).toHaveLength(1);
  });
});

describe('POST /api/generate billing', () => {
  const body = { prompt: 'a house', provider: 'gemini', model: 'gemini-3-pro-image', imageSize: '2K', images: [{ imageBase64: IMG, mediaType: 'image/png' }] };
  const cost = renderCostTokens({ provider: 'gemini', model: 'gemini-3-pro-image' }, '2K', 1, 1.2);

  it('without Supabase paid providers stay unbilled and need no login (backward compatible)', async () => {
    const gen = fakeGeneration();
    const base = await start(null, gen.adapter);
    const r = await req(`${base}/api/generate`, { body });
    expect(r.status).toBe(200);
    expect(r.body.charged).toBeUndefined();
    expect(gen.calls).toHaveLength(1);
  });

  it('requires login for a paid provider (also when the provider defaults to gemini)', async () => {
    const db = createFakeDb();
    seed(db, 100);
    const gen = fakeGeneration();
    const base = await start(fakeCloud(db, false), gen.adapter);
    const r = await req(`${base}/api/generate`, { body });
    expect(r.status).toBe(401);
    expect(r.body.error).toBe('login_required');
    expect((await req(`${base}/api/generate`, { body: { prompt: 'x' } })).body.error).toBe('login_required');
    expect(gen.calls).toHaveLength(0);
  });

  it('400 for a model that is not a listed engine (it could cost more than the fallback price); nothing debited', async () => {
    const db = createFakeDb();
    seed(db, 100);
    const gen = fakeGeneration();
    const base = await start(fakeCloud(db, false), gen.adapter);
    const r = await req(`${base}/api/generate`, { body: { ...body, model: 'gemini-9-ultra-image' }, token: 'tok-user' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('invalid_request');
    expect(db.rpcCalls).toHaveLength(0);
    expect(gen.calls).toHaveLength(0);
  });

  it('free providers need no login and are not charged', async () => {
    const db = createFakeDb();
    const gen = fakeGeneration();
    const base = await start(fakeCloud(db, false), gen.adapter);
    const r = await req(`${base}/api/generate`, { body: { prompt: 'x', provider: 'pollinations' } });
    expect(r.status).toBe(200);
    expect(r.body.charged).toBeUndefined();
    expect(db.rpcCalls).toHaveLength(0);
  });

  it('debits before calling the provider and returns charged + balance', async () => {
    const db = createFakeDb();
    seed(db, 100);
    const gen = fakeGeneration();
    const base = await start(fakeCloud(db, false), gen.adapter);
    const r = await req(`${base}/api/generate`, { body, token: 'tok-user' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ charged: cost, balance: 100 - cost });
    expect(db.tables.token_ledger).toHaveLength(1);
    expect(db.tables.token_ledger[0]).toMatchObject({ kind: 'render', delta: -cost });
    expect(String(db.tables.token_ledger[0].ref)).toMatch(/^render:[0-9a-f-]{36}$/);
  });

  it('refunds when the provider fails', async () => {
    const db = createFakeDb();
    seed(db, 100);
    const gen = fakeGeneration(new AdapterError('rate_limited', 429, 'slow down'));
    const base = await start(fakeCloud(db, false), gen.adapter);
    const r = await req(`${base}/api/generate`, { body, token: 'tok-user' });
    expect(r.status).toBe(429);
    expect(db.tables.profiles.find((p) => p.id === USER.id)?.balance).toBe(100);
    const [debit, refund] = db.tables.token_ledger;
    expect(refund).toMatchObject({ kind: 'refund', delta: cost });
    expect(String(refund.ref).slice('refund:'.length)).toBe(String(debit.ref).slice('render:'.length));
  });

  it('402 insufficient_tokens with needed + balance, provider not called', async () => {
    const db = createFakeDb();
    seed(db, 1);
    const gen = fakeGeneration();
    const base = await start(fakeCloud(db, false), gen.adapter);
    const r = await req(`${base}/api/generate`, { body, token: 'tok-user' });
    expect(r.status).toBe(402);
    expect(r.body).toMatchObject({ error: 'insufficient_tokens', needed: cost, balance: 1 });
    expect(gen.calls).toHaveLength(0);
  });

  it('exempt owner renders without being charged', async () => {
    const db = createFakeDb();
    seed(db, 0);
    const gen = fakeGeneration();
    const base = await start(fakeCloud(db, false, { exempt: USER.email }), gen.adapter);
    const r = await req(`${base}/api/generate`, { body, token: 'tok-user' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ charged: 0, balance: 0 });
    expect(db.rpcCalls).toHaveLength(0);
  });
});

describe('PromptPay top-up', () => {
  it('Omise client: satang, promptpay source, metadata, Basic auth; QR from scannable_code', async () => {
    const om = createFakeOmise();
    const client = new OmiseClient('skey_test_abc', 'pkey_test_abc', om.fetch);
    const c = await client.createPromptPayCharge(150, { user_id: 'u', topup_id: 't' });
    expect(c).toMatchObject({ chargeId: 'chrg_test_0001', status: 'pending', expiresAt: '2026-11-03T00:00:00Z' });
    expect(c.qrImageUrl).toContain('/documents/qr.svg');
    const call = om.calls[0];
    expect(call.method).toBe('POST');
    expect(call.url).toBe('https://api.omise.co/charges');
    const f = new URLSearchParams(call.body);
    expect(f.get('amount')).toBe('15000');
    expect(f.get('currency')).toBe('thb');
    expect(f.get('source[type]')).toBe('promptpay');
    expect(f.get('metadata[topup_id]')).toBe('t');
    expect(call.auth).toBe(`Basic ${Buffer.from('skey_test_abc:').toString('base64')}`);
    await expect(new OmiseClient('skey_live_abc', '', om.fetch).markAsPaid(c.chargeId)).rejects.toMatchObject({ status: 403 });
    expect(() => parseCharge({ object: 'error' })).toThrow();
  });

  it('creates a topup + charge, credits once after Omise says paid, and is idempotent', async () => {
    const db = createFakeDb();
    seed(db, 0);
    const om = createFakeOmise();
    const base = await start(fakeCloud(db, om));
    expect((await req(`${base}/api/topup/promptpay`, { body: { amountThb: 100 } })).status).toBe(401);
    for (const bad of [19, 50001, 10.5, '100']) {
      expect((await req(`${base}/api/topup/promptpay`, { body: { amountThb: bad }, token: 'tok-user' })).status).toBe(400);
    }
    const start1 = await req(`${base}/api/topup/promptpay`, { body: { amountThb: 300 }, token: 'tok-user' });
    expect(start1.status).toBe(200);
    expect(start1.body).toMatchObject({ amountThb: 300, expiresAt: '2026-11-03T00:00:00Z' });
    const { topupId, qrImageUrl } = start1.body;
    expect(qrImageUrl).toContain('qr.svg');
    const row = db.tables.topups.find((t) => t.id === topupId)!;
    expect(row).toMatchObject({ user_id: USER.id, amount_thb: 300, omise_charge_id: 'chrg_test_0001' });
    expect(om.charges.get('chrg_test_0001')?.metadata).toEqual({ user_id: USER.id, topup_id: topupId });

    // still pending: nothing credited
    expect((await req(`${base}/api/topup/${topupId}`, { token: 'tok-user' })).body).toEqual({ status: 'pending', balance: 0 });
    // other users cannot see it
    expect((await req(`${base}/api/topup/${topupId}`, { token: 'tok-other' })).status).toBe(404);

    om.pay('chrg_test_0001');
    expect((await req(`${base}/api/topup/${topupId}`, { token: 'tok-user' })).body).toEqual({ status: 'successful', balance: 300 });
    expect((await req(`${base}/api/topup/${topupId}`, { token: 'tok-user' })).body).toEqual({ status: 'successful', balance: 300 });
    expect(db.tables.token_ledger).toEqual([expect.objectContaining({ kind: 'topup', delta: 300, ref: 'omise:chrg_test_0001' })]);
    expect(row.credited_at).toBeTruthy();
  });

  it('does not credit a charge whose amount does not match the topup', async () => {
    const db = createFakeDb();
    seed(db, 0);
    const om = createFakeOmise();
    const base = await start(fakeCloud(db, om));
    const { topupId } = (await req(`${base}/api/topup/promptpay`, { body: { amountThb: 100 }, token: 'tok-user' })).body;
    Object.assign(om.charges.get('chrg_test_0001')!, { amount: 2000, status: 'successful', paid: true });
    expect((await req(`${base}/api/topup/${topupId}`, { token: 'tok-user' })).body).toEqual({ status: 'failed', balance: 0 });
  });

  it('test-pay works only in Omise test mode', async () => {
    const db = createFakeDb();
    seed(db, 5);
    const om = createFakeOmise();
    const base = await start(fakeCloud(db, om));
    const { topupId } = (await req(`${base}/api/topup/promptpay`, { body: { amountThb: 20 }, token: 'tok-user' })).body;
    const r = await req(`${base}/api/topup/${topupId}/test-pay`, { method: 'POST', token: 'tok-user', body: {} });
    expect(r.body).toEqual({ status: 'successful', balance: 25 });
    expect(om.calls.some((c) => c.url.endsWith('/mark_as_paid'))).toBe(true);
    // again: no second credit
    expect((await req(`${base}/api/topup/${topupId}/test-pay`, { method: 'POST', token: 'tok-user', body: {} })).body.balance).toBe(25);

    server!.close();
    const db2 = createFakeDb();
    seed(db2, 0);
    const om2 = createFakeOmise();
    const base2 = await start(fakeCloud(db2, om2, { secretKey: 'skey_live_123' }));
    const t2 = (await req(`${base2}/api/topup/promptpay`, { body: { amountThb: 20 }, token: 'tok-user' })).body.topupId;
    const r2 = await req(`${base2}/api/topup/${t2}/test-pay`, { method: 'POST', token: 'tok-user', body: {} });
    expect(r2.status).toBe(403);
    expect(r2.body.error).toBe('test_mode_only');
    expect(om2.calls.some((c) => c.url.endsWith('/mark_as_paid'))).toBe(false);
    expect((await req(`${base2}/api/config`)).body.billing.omise.testMode).toBe(false);
  });

  it('top-up answers 503 when Omise is not configured', async () => {
    const db = createFakeDb();
    seed(db, 0);
    const base = await start(fakeCloud(db, false));
    expect((await req(`${base}/api/topup/promptpay`, { body: { amountThb: 100 }, token: 'tok-user' })).status).toBe(503);
  });

  it('webhook re-reads the charge from Omise, ignores amounts in the body and credits idempotently', async () => {
    const db = createFakeDb();
    seed(db, 0);
    const om = createFakeOmise();
    const base = await start(fakeCloud(db, om));
    await req(`${base}/api/topup/promptpay`, { body: { amountThb: 100 }, token: 'tok-user' });
    const forged = {
      object: 'event',
      key: 'charge.complete',
      data: { object: 'charge', id: 'chrg_test_0001', status: 'successful', paid: true, amount: 99999900 },
    };

    // Omise still says pending: the forged body credits nothing
    expect((await req(`${base}/api/omise/webhook`, { body: forged })).status).toBe(200);
    expect(db.tables.token_ledger).toHaveLength(0);
    expect(om.calls.filter((c) => c.method === 'GET' && c.url.endsWith('/charges/chrg_test_0001'))).toHaveLength(1);

    om.pay('chrg_test_0001');
    await req(`${base}/api/omise/webhook`, { body: forged });
    await req(`${base}/api/omise/webhook`, { body: forged });
    expect(db.tables.token_ledger).toEqual([expect.objectContaining({ delta: 100, ref: 'omise:chrg_test_0001' })]);
    expect(db.tables.profiles.find((p) => p.id === USER.id)?.balance).toBe(100);

    // junk / other events / unknown charges: still 200
    expect((await req(`${base}/api/omise/webhook`, { body: { key: 'charge.create', data: { id: 'chrg_test_0001' } } })).status).toBe(200);
    expect((await req(`${base}/api/omise/webhook`, { body: { key: 'charge.complete', data: { id: 'chrg_test_9999' } } })).status).toBe(200);
    expect((await req(`${base}/api/omise/webhook`, { body: { nonsense: true } })).status).toBe(200);
  });
});

describe('image analysis with accounts on', () => {
  let calls = 0;
  const paidVision: VisionAdapter = {
    provider: 'anthropic',
    model: 'fake',
    isConfigured: () => true,
    analyzeSource: async () => {
      calls++;
      return { summary: 'ok' } as unknown as Awaited<ReturnType<VisionAdapter['analyzeSource']>>;
    },
    analyzeReference: async () => {
      calls++;
      return { categories: {} } as unknown as Awaited<ReturnType<VisionAdapter['analyzeReference']>>;
    },
  };
  async function startVision(cloud: CloudDeps | null): Promise<string> {
    server = createApp({ vision: paidVision, generation: fakeGeneration().adapter, cloud }).listen(0);
    await new Promise<void>((r) => server!.once('listening', () => r()));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  const img = { imageBase64: IMG, mediaType: 'image/png' };

  it('requires login for the paid vision endpoints, rate limits each account, and stays open in local mode', async () => {
    calls = 0;
    const db = createFakeDb();
    seed(db, 0);
    let base = await startVision(fakeCloud(db, false, { exempt: OTHER.email }));
    expect((await req(`${base}/api/analyze/source`, { body: img })).status).toBe(401);
    expect((await req(`${base}/api/analyze/reference`, { body: { ...img, categories: ['material'] } })).body.error).toBe('login_required');
    expect(calls).toBe(0);
    for (let i = 0; i < ANALYZE_LIMIT_PER_HOUR; i++) expect((await req(`${base}/api/analyze/source`, { body: img, token: 'tok-user' })).status).toBe(200);
    const limited = await req(`${base}/api/analyze/source`, { body: img, token: 'tok-user' });
    expect(limited.status).toBe(429);
    expect(limited.body.error).toBe('rate_limited');
    expect(calls).toBe(ANALYZE_LIMIT_PER_HOUR);
    // the exempt owner is not limited
    expect((await req(`${base}/api/analyze/source`, { body: img, token: 'tok-other' })).status).toBe(200);

    await new Promise<void>((r) => server!.close(() => r()));
    base = await startVision(null);
    expect((await req(`${base}/api/analyze/source`, { body: img })).status).toBe(200);
  });
});
