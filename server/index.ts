// API server entry. Run with `npm run dev:api` (tsx) — Vite proxies /api to this port.
import 'dotenv/config';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createGenerationAdapter } from './adapters/generation';
import { createApp } from './app';
import { createCloudFromEnv } from './cloud/supabase';

// API_PORT, not PORT: dev tooling often sets PORT for the Vite server, which would collide.
const port = Number(process.env.API_PORT) || 8787;
const generation = createGenerationAdapter();
// Accounts + billing only when SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY are set; otherwise local mode.
const cloud = createCloudFromEnv();
const app = createApp({ generation, cloud });

// Serve the single-file app (npm run build:single) from the same origin as the API, so image
// analysis works without CORS and the API key never leaves this server.
const singleHtml = resolve(process.cwd(), 'dist-single', 'index.html');
const hasSingle = existsSync(singleHtml);
if (hasSingle) app.get('/', (_req, res) => res.sendFile(singleHtml));

app.listen(port, () => {
  const configured = !!process.env.ANTHROPIC_API_KEY?.trim();
  console.log(`[api] listening on http://localhost:${port}`);
  if (hasSingle) console.log(`[api] app: open http://localhost:${port}/ in your browser`);
  console.log(
    configured
      ? `[api] vision: anthropic (${process.env.VISION_MODEL?.trim() || 'claude-opus-5-5'})`
      : '[api] vision: NOT CONFIGURED — set ANTHROPIC_API_KEY in .env (the app runs in Demo Mode)',
  );
  // Names only — never the keys themselves.
  const generationProviders = generation.availableProviders();
  console.log(
    generationProviders.length
      ? `[api] image generation: ${generationProviders.join(', ')}${
          generationProviders.includes('pollinations') && !process.env.POLLINATIONS_API_KEY?.trim() ? ' (pollinations keyless: text only)' : ''
        }`
      : '[api] image generation: NOT CONFIGURED — free: CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN, or unset POLLINATIONS_DISABLED; ' +
          'paid: GEMINI_API_KEY (billing required) / OPENAI_API_KEY in .env (POST /api/generate returns 501)',
  );
  // Modes only — never the keys.
  console.log(
    cloud
      ? `[api] accounts: Supabase on · paid renders billed in tokens (markup ${cloud.config.markup})` +
          (cloud.omise ? ` · Omise PromptPay ${cloud.omise.testMode ? 'TEST mode' : 'LIVE'}` : ' · top-up off (no OMISE_SECRET_KEY)') +
          (cloud.omise && cloud.config.appPublicUrl ? ` · webhook ${cloud.config.appPublicUrl}/api/omise/webhook` : '')
      : '[api] accounts: off (Supabase not configured) — local mode, no login',
  );
});
