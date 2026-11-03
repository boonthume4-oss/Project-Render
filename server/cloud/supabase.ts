// Supabase on the server: env config, the service-role client (bypasses RLS: server only) and access-token verification.
// Accounts and billing are active only when SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are all set;
// otherwise the app runs locally with no login, exactly as before. Keys and tokens are never logged or sent anywhere.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Request } from 'express';
import type { FetchLike } from '../adapters/http';
import { OmiseClient } from '../billing/omise';

export const DEFAULT_TOKEN_MARKUP = 1.2;

export interface CloudConfig {
  supabaseUrl: string;
  /** public: served to the browser by GET /api/config */
  anonKey: string;
  /** server only */
  serviceRoleKey: string;
  omisePublicKey: string;
  omiseSecretKey: string;
  /** price multiplier on the API cost (TOKEN_MARKUP, default 1.2) */
  markup: number;
  /** lower-cased emails that render paid engines without tokens */
  exemptEmails: string[];
  appPublicUrl: string;
}

export interface VerifiedUser {
  id: string;
  email: string;
  /** the email address is confirmed (auth.users.email_confirmed_at is set): required for the billing exemption */
  confirmed: boolean;
}

/** Everything the routes need for accounts + billing. `null` in AppDeps = local mode (no login, no billing). */
export interface CloudDeps {
  config: CloudConfig;
  /** service-role Supabase client (or a fake in tests) */
  db: SupabaseClient;
  /** null when the Omise keys are not set (top-up answers 503) */
  omise: OmiseClient | null;
}

/** TOKEN_MARKUP as a positive number; junk or ≤ 0 → the default 1.2. */
export function parseMarkup(raw: string | undefined): number {
  const n = Number(raw?.trim());
  return raw?.trim() && Number.isFinite(n) && n > 0 ? n : DEFAULT_TOKEN_MARKUP;
}

export function readCloudConfig(env: NodeJS.ProcessEnv = process.env): CloudConfig {
  const s = (name: string) => env[name]?.trim() ?? '';
  return {
    supabaseUrl: s('SUPABASE_URL').replace(/\/+$/, ''),
    anonKey: s('SUPABASE_ANON_KEY'),
    serviceRoleKey: s('SUPABASE_SERVICE_ROLE_KEY'),
    omisePublicKey: s('OMISE_PUBLIC_KEY'),
    omiseSecretKey: s('OMISE_SECRET_KEY'),
    markup: parseMarkup(env.TOKEN_MARKUP),
    exemptEmails: s('BILLING_EXEMPT_EMAILS')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
    appPublicUrl: s('APP_PUBLIC_URL'),
  };
}

export function isSupabaseConfigured(c: CloudConfig): boolean {
  return !!(c.supabaseUrl && c.anonKey && c.serviceRoleKey);
}

/** Service-role client from env, or null when Supabase is not configured. No session is stored or refreshed. */
export function createServiceClient(config: CloudConfig): SupabaseClient | null {
  if (!isSupabaseConfigured(config)) return null;
  return createClient(config.supabaseUrl, config.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

/** Cloud deps from env, or null (local mode) when Supabase is not configured. */
export function createCloudFromEnv(env: NodeJS.ProcessEnv = process.env, fetchImpl?: FetchLike): CloudDeps | null {
  const config = readCloudConfig(env);
  const db = createServiceClient(config);
  if (!db) return null;
  const omise = config.omiseSecretKey ? new OmiseClient(config.omiseSecretKey, config.omisePublicKey, fetchImpl) : null;
  return { config, db, omise };
}

/** The access token from `Authorization: Bearer <token>`, or null. */
export function bearerToken(req: Pick<Request, 'headers'>): string | null {
  const h = req.headers.authorization;
  const m = typeof h === 'string' ? /^Bearer\s+(\S+)$/i.exec(h.trim()) : null;
  return m ? m[1] : null;
}

/** The signed-in user of the request (verified by Supabase Auth), or null for no / invalid / expired token. */
export async function verifyUser(db: SupabaseClient, req: Pick<Request, 'headers'>): Promise<VerifiedUser | null> {
  const token = bearerToken(req);
  if (!token || token.length > 8192) return null;
  try {
    const { data, error } = await db.auth.getUser(token);
    const user = data?.user;
    if (error || !user?.id) return null;
    return { id: user.id, email: (user.email ?? '').toLowerCase(), confirmed: !!user.email_confirmed_at };
  } catch {
    // network trouble reaching Supabase: treated as signed out (the token itself is never logged)
    return null;
  }
}

/**
 * The user renders paid engines without tokens: the email is in BILLING_EXEMPT_EMAILS AND confirmed. Without the confirmation
 * check anyone could sign up with the owner's address (with "Confirm email" off, or before the owner signs up) and render free.
 */
export function isExempt(config: CloudConfig, user: Pick<VerifiedUser, 'email' | 'confirmed'>): boolean {
  return !!user.email && user.confirmed && config.exemptEmails.includes(user.email.toLowerCase());
}
