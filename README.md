# Jarvis — AI voice intelligence

A microphone that listens, transcribes in real time, and produces structured
insights with Claude. Multi-tenant SaaS with per-user auth, cloud history,
metered free tier, and a Pro subscription — all wired up to production
providers.

```
                ┌────────────┐      ┌──────────────────────────┐
   🎤  mic  ───▶│  browser   │─────▶│  /api/transcribe (Edge)  │──▶ Whisper
      WebHID    │  (React)   │      │  /api/insights (Edge)    │──▶ Claude
      push to   │            │      │  /api/sessions (Edge)    │◀─▶ Supabase
      talk      └─────┬──────┘      │  /api/stripe/* (Node)    │◀─▶ Stripe
                      │             │  /api/deepgram/token     │──▶ Deepgram
                      │             └──────────────────────────┘
                      ▼
                  Deepgram WS (streaming, Pro only)
```

All secrets live as Vercel environment variables. The browser never sees
Whisper/Claude/Deepgram/Stripe/Supabase service-role keys — every call is
authenticated with a Clerk JWT and proxied server-side.

## What's included

- **Auth.** Clerk. JWTs verified server-side via JWKS (`jose`).
- **Storage.** Supabase Postgres with Row-Level Security keyed on
  `clerk_user_id`. Schema in `supabase/migrations/0001_init.sql`.
- **Transcription.** OpenAI Whisper (batched) by default; Deepgram Nova-2
  over a WebSocket with 60-second scoped keys when the user flips the switch
  (Pro only).
- **Insights.** Claude Sonnet 4.6 with a strict JSON system prompt, validated
  and normalized server-side.
- **Billing.** Stripe Checkout + Billing Portal + webhooks (HMAC-verified).
  Free tier = 60 min of transcription per UTC day; Pro = unlimited.
- **Hardware.** WebHID for generic input devices (foot pedals, jog dials,
  programmable buttons) — connect once, toggle push-to-talk in Settings.
- **Telemetry.** Sentry (errors) + PostHog (product analytics). Both optional
  — omit the env vars and the init calls no-op.
- **Tests.** Vitest for the pure libs, Playwright for a smoke suite against
  the production build.

## Quick start (local)

```bash
cp .env.example .env.local
# …fill in the values (see Env reference below)

npm install
npm run dev
# open http://localhost:5173
```

Run the tests:

```bash
npm run typecheck
npm run test
npm run test:e2e       # requires `npx playwright install chromium` once
```

## Env reference

See `.env.example` for the full list. The short version:

| Variable                         | Where           | Required |
| -------------------------------- | --------------- | -------- |
| `VITE_CLERK_PUBLISHABLE_KEY`     | browser         | yes      |
| `VITE_SUPABASE_URL`              | browser         | yes      |
| `VITE_SUPABASE_ANON_KEY`         | browser         | yes      |
| `VITE_POSTHOG_KEY`               | browser         | no       |
| `VITE_POSTHOG_HOST`              | browser         | no       |
| `VITE_SENTRY_DSN`                | browser         | no       |
| `OPENAI_API_KEY`                 | server          | yes      |
| `ANTHROPIC_API_KEY`              | server          | yes      |
| `DEEPGRAM_API_KEY`               | server          | for Pro  |
| `DEEPGRAM_PROJECT_ID`            | server          | for Pro  |
| `CLERK_SECRET_KEY`               | server          | yes      |
| `CLERK_JWT_ISSUER`               | server          | no (pin) |
| `SUPABASE_URL`                   | server          | yes      |
| `SUPABASE_SERVICE_ROLE_KEY`      | server          | yes      |
| `STRIPE_SECRET_KEY`              | server          | yes      |
| `STRIPE_WEBHOOK_SECRET`          | server          | yes      |
| `STRIPE_PRICE_ID_PRO`            | server          | yes      |
| `APP_URL`                        | server          | yes      |

## Deploy

One-time:

1. Import the repo into Vercel.
2. Run the migration in `supabase/migrations/0001_init.sql` against your
   Supabase project (SQL editor or `supabase db push`).
3. Create the Pro price in Stripe and grab the `price_xxx` id.
4. In the Stripe dashboard, add a webhook endpoint →
   `https://<your-app>.vercel.app/api/stripe/webhook` → copy the signing
   secret to `STRIPE_WEBHOOK_SECRET`.
5. In the Clerk dashboard, add your production domain to the allowed origins.
6. Paste every key from `.env.example` into Vercel → Settings → Environment
   Variables (Production + Preview).
7. Push to `main`. Vercel builds and deploys.

To add a new Claude model, edit `api/insights.ts` → `ALLOWED_MODELS`.
To change the free-tier quota, edit `api/_lib/supabase.ts` → `FREE_DAILY_SEC`.

## Insight JSON schema (output contract)

```ts
interface Insight {
  session_id: string;
  timestamp: string;                      // ISO 8601
  summary: string[];                      // 3–5 bullets
  action_items: Array<{
    action: string;
    owner: string | null;
    deadline: string | null;
  }>;
  key_topics: string[];
  open_questions: string[];
  sentiment: 'positive' | 'neutral' | 'tense';
  energy_level: 1 | 2 | 3 | 4 | 5;
  language_detected: 'ru' | 'en' | 'uk' | 'mixed';
}
```

## Security model

- **No secrets in the browser.** Every third-party API is called from a
  Vercel Function; the browser only ever holds the Clerk JWT (scoped to the
  user) and the Supabase anon key (read-only, RLS-protected).
- **RLS everywhere.** Every table carries a `clerk_user_id` column and a
  policy that reads `request.jwt.claims.sub`. Even if the anon key leaks,
  nobody can read somebody else's sessions.
- **Scoped Deepgram keys.** We mint a fresh Deepgram API key per session
  with a 60-second TTL, so a compromised frontend can't accumulate billing.
- **Webhook verification.** Stripe webhooks are verified with
  `crypto.timingSafeEqual` over the raw body; Clerk JWTs are verified against
  the project's JWKS.

## Browser support

- `getUserMedia`, `MediaRecorder` with Opus — all evergreen browsers.
- `WebHID` for push-to-talk — Chrome, Edge, Opera.
- HTTPS is required for the microphone; `localhost` works during dev.

## Commands

```bash
npm run dev         # vite dev server on :5173
npm run build       # typecheck + production build to dist/
npm run preview     # serve dist/ locally
npm run typecheck   # tsc --noEmit (app + node + api projects)
npm run test        # vitest — pure libs
npm run test:e2e    # playwright smoke
```

## Architecture

See `ARCHITECTURE.md` for the long version: how each layer connects, the
trade-offs we took, and how to extend this to React Native, Raspberry Pi,
Alexa skills, or a third-party SDK.

## License

MIT
