# Jarvis — launch checklist

Everything on the code side is done. Typecheck, production build, and the
21-test Vitest suite all pass. The list below is **only the actions that
require you (Alex) to press buttons in third-party dashboards** — no code
changes left.

## 1. Provision the accounts

- [ ] **Vercel** project imported from the GitHub repo (already done).
- [ ] **Supabase** project — run `supabase/migrations/0001_init.sql` in the
      SQL editor. Grab the project URL, the anon key, and the service-role
      key.
- [ ] **Clerk** project — note the publishable key and the secret key. Add
      your Vercel domain to "Allowed origins".
- [ ] **Stripe** account — create a recurring `$15 / month` price for "Pro",
      copy the `price_xxx` id. Create a webhook endpoint pointing to
      `https://<your-vercel-domain>/api/stripe/webhook` with events
      `checkout.session.completed`, `customer.subscription.updated`,
      `customer.subscription.deleted`, `invoice.payment_failed`. Copy the
      signing secret (`whsec_...`).
- [ ] **OpenAI** + **Anthropic** + **Deepgram** keys — one of each, paid
      plans with sensible monthly caps.
- [ ] (Optional) **Sentry** + **PostHog** — omit if you don't want telemetry.

## 2. Paste everything into Vercel

Go to **Vercel → Project → Settings → Environment Variables** and set every
variable listed in `.env.example`. Apply to **Production** and **Preview**.

Browser-visible (start with `VITE_`):
`VITE_CLERK_PUBLISHABLE_KEY`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`,
`VITE_POSTHOG_KEY` (optional), `VITE_POSTHOG_HOST` (optional),
`VITE_SENTRY_DSN` (optional).

Server-only (no `VITE_` prefix):
`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `DEEPGRAM_API_KEY`,
`DEEPGRAM_PROJECT_ID`, `CLERK_SECRET_KEY`, **`CLERK_JWT_ISSUER` (REQUIRED —
find in Clerk Dashboard → API Keys → "Issuer URL"; without it /api/* returns
500 for every request)**, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID_PRO`,
`APP_URL`.

## 3. Promote to production

```bash
git push origin main         # Vercel builds + deploys automatically
```

## 4. Smoke test the live site

- [ ] Sign up with a new account via Clerk.
- [ ] Start a recording, talk for 30 seconds, verify Whisper transcript
      appears and Claude insight renders.
- [ ] Open the Sessions tab — the finished session should appear there.
- [ ] Open Settings → connect a foot pedal via WebHID (optional).
- [ ] Open Billing → click **Оформить Pro** → complete Stripe checkout in
      test mode. Back on the app, the header pill should flip to "Pro".
- [ ] In Settings, switch the transcription engine to Deepgram → verify
      streaming transcript.

## 5. Things I can't do from the sandbox (still pending)

- [ ] Upload all the new files in this session to
      `github.com/IamAmA7/jarvis`. Once you tell me to proceed, I'll push
      them via the same Chrome MCP flow we used for `package-lock.json`.
      (Or you can `git pull` locally + `git push` if it's easier — every
      file is already committed-shaped on disk.)

## Operational knobs

- **Free tier transcription cap.** Edit `api/_lib/supabase.ts` → `FREE_DAILY_SEC`.
- **Free tier insights cap.** Edit `api/_lib/supabase.ts` → `FREE_DAILY_INSIGHTS`.
- **Allowed Claude models.** Edit `api/insights.ts` → `ALLOWED_MODELS`.
- **Pricing / plan copy.** Edit `src/components/BillingView.tsx`.

## Costs to budget for (ballpark)

- Whisper: ~$0.006/min transcribed.
- Claude Sonnet 4.6: ~$0.003 per insight-refresh on a 5-minute transcript.
- Deepgram Nova-2: ~$0.0043/min (only when Pro users toggle it on).
- Vercel Hobby/Pro: free-to-$20/mo depending on traffic.
- Supabase free tier is fine up to ~500 MB / 50k MAUs; upgrade if you
  outgrow it.
- Stripe: 2.9% + $0.30 per charge, 0.5% for recurring billing add-on if you
  turn it on.

That's it. Everything else is on our side.
