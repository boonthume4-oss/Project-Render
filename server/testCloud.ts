// Test doubles for accounts + billing: an in-memory Supabase client (just the calls the server makes, apply_tokens emulated like
// supabase/schema.sql) and a fake Omise API behind an injected fetch. Nothing here touches a network.

import type { SupabaseClient } from '@supabase/supabase-js';
import { OmiseClient } from './billing/omise';
import { type CloudDeps, readCloudConfig } from './cloud/supabase';

type Row = Record<string, unknown>;

export interface FakeDb {
  tables: { profiles: Row[]; topups: Row[]; token_ledger: Row[] };
  /** access token → user */
  tokens: Map<string, { id: string; email: string; confirmed?: boolean }>;
  rpcCalls: { fn: string; args: Row }[];
  client: SupabaseClient;
}

export function createFakeDb(): FakeDb {
  const tables: FakeDb['tables'] = { profiles: [], topups: [], token_ledger: [] };
  const tokens = new Map<string, { id: string; email: string; confirmed?: boolean }>();
  const rpcCalls: FakeDb['rpcCalls'] = [];
  let seq = 0;

  const query = (name: keyof FakeDb['tables']) => {
    let op: 'select' | 'insert' | 'update' | 'upsert' | null = null;
    let payload: Row = {};
    let ignoreDuplicates = false;
    let mode: 'many' | 'single' | 'maybe' = 'many';
    const filters: [string, unknown][] = [];
    const exec = () => {
      const t = tables[name];
      const match = (r: Row) => filters.every(([c, v]) => r[c] === v);
      let rows: Row[] = [];
      if (op === 'insert') {
        const row = { id: `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`, status: 'pending', credited_at: null, ...payload };
        t.push(row);
        rows = [row];
      } else if (op === 'upsert') {
        const found = t.find((r) => r.id === payload.id);
        if (!found) t.push({ balance: 0, ...payload });
        else if (!ignoreDuplicates) Object.assign(found, payload);
      } else if (op === 'update') {
        rows = t.filter(match);
        rows.forEach((r) => Object.assign(r, payload));
      } else rows = t.filter(match);
      if (mode === 'many') return { data: rows.map((r) => ({ ...r })), error: null };
      if (mode === 'single' && rows.length !== 1) return { data: null, error: { message: 'JSON object requested, multiple (or no) rows returned' } };
      return { data: rows[0] ? { ...rows[0] } : null, error: null };
    };
    const q = {
      select: () => {
        op ??= 'select';
        return q;
      },
      insert: (p: Row) => {
        op = 'insert';
        payload = p;
        return q;
      },
      update: (p: Row) => {
        op = 'update';
        payload = p;
        return q;
      },
      upsert: (p: Row, opts?: { ignoreDuplicates?: boolean }) => {
        op = 'upsert';
        payload = p;
        ignoreDuplicates = !!opts?.ignoreDuplicates;
        return q;
      },
      eq: (c: string, v: unknown) => {
        filters.push([c, v]);
        return q;
      },
      single: () => {
        mode = 'single';
        return q;
      },
      maybeSingle: () => {
        mode = 'maybe';
        return q;
      },
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve().then(exec).then(resolve, reject),
    };
    return q;
  };

  const rpc = async (fn: string, args: Row) => {
    rpcCalls.push({ fn, args });
    if (fn !== 'apply_tokens') return { data: null, error: { message: `unknown function ${fn}` } };
    const profile = tables.profiles.find((p) => p.id === args.p_user);
    if (!profile) return { data: null, error: { message: 'profile_not_found' } };
    const balance = Number(profile.balance);
    if (tables.token_ledger.some((l) => l.ref === args.p_ref)) return { data: balance, error: null };
    const next = balance + Number(args.p_delta);
    if (next < 0) return { data: null, error: { message: 'insufficient_tokens' } };
    tables.token_ledger.push({ user_id: args.p_user, delta: args.p_delta, kind: args.p_kind, ref: args.p_ref, meta: args.p_meta });
    profile.balance = next;
    return { data: next, error: null };
  };

  const auth = {
    getUser: async (token: string) => {
      const u = tokens.get(token);
      // confirmed unless the test says otherwise (confirmed: false → no email_confirmed_at)
      const confirmedAt = u?.confirmed === false ? null : '2026-01-01T00:00:00Z';
      return u ? { data: { user: { id: u.id, email: u.email, email_confirmed_at: confirmedAt } }, error: null } : { data: { user: null }, error: { message: 'invalid JWT' } };
    },
  };

  const client = { from: query, rpc, auth } as unknown as SupabaseClient;
  return { tables, tokens, rpcCalls, client };
}

/* ------------------------------------------------------------------ */
/* Fake Omise                                                          */
/* ------------------------------------------------------------------ */

export interface FakeOmise {
  charges: Map<string, Row>;
  calls: { method: string; url: string; body: string; auth: string }[];
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  /** what the "customer" does: pay a charge on Omise's side */
  pay(id: string): void;
}

export function createFakeOmise(): FakeOmise {
  const charges = new Map<string, Row>();
  const calls: FakeOmise['calls'] = [];
  let seq = 0;
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const view = (c: Row) => ({
    object: 'charge',
    ...c,
    source: { type: 'promptpay', scannable_code: { image: { download_uri: `https://api.omise.co/charges/${String(c.id)}/documents/qr.svg` } } },
  });
  const fetchImpl = async (input: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = typeof init?.body === 'string' ? init.body : '';
    calls.push({ method, url: input, body, auth: headers.authorization ?? '' });
    const path = input.replace('https://api.omise.co', '');
    if (method === 'POST' && path === '/charges') {
      const f = new URLSearchParams(body);
      const metadata: Row = {};
      for (const [k, v] of f) {
        const m = /^metadata\[(.+)\]$/.exec(k);
        if (m) metadata[m[1]] = v;
      }
      const c = {
        id: `chrg_test_${String(++seq).padStart(4, '0')}`,
        amount: Number(f.get('amount')),
        currency: f.get('currency'),
        status: 'pending',
        paid: false,
        expires_at: '2026-11-03T00:00:00Z',
        metadata,
      };
      charges.set(c.id, c);
      return json(200, view(c));
    }
    const m = /^\/charges\/([^/]+)(\/mark_as_paid)?$/.exec(path);
    const c = m ? charges.get(decodeURIComponent(m[1])) : undefined;
    if (!c) return json(404, { object: 'error', code: 'not_found', message: 'charge was not found' });
    if (m?.[2] && method === 'POST') {
      c.status = 'successful';
      c.paid = true;
    }
    return json(200, view(c));
  };
  return {
    charges,
    calls,
    fetch: fetchImpl,
    pay: (id) => {
      const c = charges.get(id);
      if (c) Object.assign(c, { status: 'successful', paid: true });
    },
  };
}

/** CloudDeps over the fakes. `secretKey` decides test / live mode; omise: false = no Omise keys. */
export function fakeCloud(db: FakeDb, omise: FakeOmise | false, opts: { secretKey?: string; markup?: string; exempt?: string } = {}): CloudDeps {
  const config = readCloudConfig({
    SUPABASE_URL: 'https://example.supabase.co/',
    SUPABASE_ANON_KEY: 'anon-public-test',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-test',
    OMISE_PUBLIC_KEY: omise ? 'pkey_test_123' : '',
    OMISE_SECRET_KEY: omise ? (opts.secretKey ?? 'skey_test_123') : '',
    TOKEN_MARKUP: opts.markup,
    BILLING_EXEMPT_EMAILS: opts.exempt,
  });
  return { config, db: db.client, omise: omise ? new OmiseClient(config.omiseSecretKey, config.omisePublicKey, omise.fetch) : null };
}
