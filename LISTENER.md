# Jarvis Listener Mode — always-on wearable + auto alerts

This doc covers the second half of Jarvis: the backend that powers an
always-on microphone device (ESP32-S3 pendant, phone, smart watch) and the
automatic Telegram alert pipeline.

The browser app (live-mic sessions, insights on demand) remains untouched.
Listener mode runs alongside it and reuses the same auth/user model.

## Flow at a glance

```
device ──POST /api/ingest──▶  storage  ──▶  Whisper  ──▶  transcripts
                                                 │
                                                 ▼
                                          Claude classifier
                                                 │
                         ┌───────────────────────┼───────────────┐
                         ▼                       ▼               ▼
                    severity=red            severity=yellow   severity=green
                         │                       │               │
                 Telegram (minutes)       daily digest cron    archive
```

## Endpoints

All user endpoints require `Authorization: Bearer <Clerk JWT>`. `/api/ingest`
requires `Authorization: Device <device_id>.<raw_token>`. `/api/telegram/webhook`
authenticates via Telegram's secret-token header. `/api/cron/digest` is
invoked by Vercel Cron with `Authorization: Bearer <CRON_SECRET>` (or the
`x-vercel-cron: 1` header as fallback).

| Method | Path | Who | What |
| --- | --- | --- | --- |
| POST | `/api/ingest` | device | upload a chunk, run pipeline |
| GET | `/api/devices` | user | list devices |
| POST | `/api/devices` | user | provision (returns raw token ONCE) |
| PATCH | `/api/devices/:id` | user | rename |
| DELETE | `/api/devices/:id` | user | revoke |
| POST | `/api/devices/:id?action=rotate` | user | mint a new token |
| GET | `/api/alerts` | user | list (filter by severity, time, device) |
| GET | `/api/alerts/:id` | user | detail + referenced transcripts |
| POST | `/api/alerts/:id/ack` | user | mark acknowledged |
| GET | `/api/alert_config` | user | read classifier config |
| PUT | `/api/alert_config` | user | write classifier config |
| POST | `/api/telegram/link` | user | generate one-time bind code |
| POST | `/api/telegram/webhook` | Telegram | bot message handler |
| GET | `/api/cron/digest` | Vercel Cron | send yellow digest |

## Schema (migration 0002)

- `devices` — one row per hardware unit. Stores `token_hash` (sha256 of raw
  token; raw is shown once at provisioning time). Tracks `last_seen_at`,
  `battery_pct`, `wifi_rssi` for telemetry.
- `chunks` — raw audio segments. `storage_path` points into the private
  `audio` bucket. `transcription_status` goes
  `pending → transcribing → done | failed | skipped`.
- `transcripts` — Whisper output per chunk, including word-level timestamps
  for scrubbing.
- `alerts` — one classification per rolling window. Severity red/yellow/green;
  `confidence` 0..1; `transcript_refs[]` points back at the evidence.
- `telegram_subscriptions` — one row per (user, chat). `severities[]` controls
  which alert levels deliver to this chat. Linked via a one-time `link_code`.
- `alert_config` — per-user tuning: red/yellow category lists, child name/age,
  language hint, quiet hours.

All tables have RLS enabled keyed on `public.clerk_user_id()`. The server
uses the service-role key and filters by `clerk_user_id` explicitly.

RPCs:

- `claim_chunk_for_transcription(uuid)` — atomic status flip so two Edge
  invocations can't both bill Whisper for the same chunk.
- `transcript_window(user, device, from, to)` — fetch the sliding-window
  transcript the classifier chews on.

## Storage bucket

Create a **private** bucket named `audio`. Structure:

```
audio/<clerk_user_id>/<device_id>/<yyyy>/<mm>/<dd>/<chunk_id>.<ext>
```

The server writes via service role; the dashboard reads through short-lived
signed URLs produced by `storage.ts#signedUrl`.

## Device provisioning

1. User clicks "Add device" in the dashboard → `POST /api/devices` →
   response body includes `token` (raw) and `auth_header` (ready-to-paste
   `Device <id>.<token>`). **Shown exactly once.**
2. User pastes the header string into the firmware flasher.
3. Firmware uses it on every `POST /api/ingest`.
4. If lost: dashboard → `POST /api/devices/:id?action=rotate` mints a new one.

## Firmware contract

On every chunk:

```
POST /api/ingest
Authorization: Device <device_id>.<raw_token>
Content-Type: multipart/form-data

file          = <audio blob, <= 25 MB, webm/ogg/wav/mp3/m4a>
recorded_at   = "2026-04-21T07:55:12.000Z"
duration_sec  = 28.4           (optional)
vad_score     = 0.92           (optional)
battery_pct   = 83             (optional)
wifi_rssi     = -57            (optional)
firmware      = "0.4.1"        (optional)
language      = "ru"           (optional Whisper hint)
```

Response: `{ chunk_id, transcript_id, text, alert? }`.

Sensible chunk size is 20–60 seconds of speech. VAD on the device keeps
chunks compact — silent windows should not be uploaded.

## Telegram setup (operator side)

1. `@BotFather` → `/newbot`. Copy the token into `TELEGRAM_BOT_TOKEN`.
   Copy the @username into `TELEGRAM_BOT_USERNAME`.
2. Generate a webhook secret: `openssl rand -hex 32` → `TELEGRAM_WEBHOOK_SECRET`.
3. Register the webhook (once per deploy):

   ```bash
   curl -s "https://api.telegram.org/bot<TOKEN>/setWebhook" \
     -d "url=https://<your-vercel-domain>/api/telegram/webhook" \
     -d "secret_token=<webhook-secret>"
   ```

4. From the dashboard, a user clicks "Link Telegram" → gets a code like
   `JV-ABCD-1234` + a deep link. Opening the link or typing `/start JV-ABCD-1234`
   into the bot binds the chat. Afterwards the chat starts receiving alerts.

## Cron

`vercel.json` registers one cron:

```json
{ "path": "/api/cron/digest", "schedule": "0 19 * * *" }
```

19:00 UTC daily. Change the schedule to suit your parents' timezone; Vercel
parses standard cron.

## Environment variables (new)

```
TELEGRAM_BOT_TOKEN=       # from @BotFather
TELEGRAM_BOT_USERNAME=    # bot's @username (without @)
TELEGRAM_WEBHOOK_SECRET=  # shared secret for setWebhook
CRON_SECRET=              # optional — if unset we accept Vercel's header
```

See `.env.example` for the full list.

## Severity knobs

Defaults for `alert_config.red_categories`:

```
aggression, physical_violence, threats, screaming, panic, weapons, drugs,
sexual_content, suicide_mention, fall_or_pain
```

Defaults for `alert_config.yellow_categories`:

```
isolation, sadness, recurring_conflict, negative_peer_dynamic, bullying_signals
```

You can extend either list via `PUT /api/alert_config`. The classifier sees
these lists inside its system prompt, so tuning is zero-code.

One important guard: if the classifier says red with `confidence < 0.7`, we
demote to yellow. Better a late-evening digest than pinging the parent on a
mishearing.
