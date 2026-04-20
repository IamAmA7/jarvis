# Jarvis — AI voice intelligence (browser service)

A microphone that listens, transcribes in real time, and produces structured
insights with Claude — **all in the browser**. No backend, no build-time
secrets, no server to deploy. Each user brings their own OpenAI and Anthropic
API keys, pasted into the Settings page and stored in their browser only.

```
                 ┌──────────────────────────────┐
                 │   OpenAI Whisper (browser    │
   🎤 mic  ────▶ │      → transcription)        │
                 └──────────────┬───────────────┘
                                │ text chunks
                                ▼
                 ┌──────────────────────────────┐
                 │   Anthropic Claude (browser  │
                 │      → structured insight)   │
                 └──────────────────────────────┘
```

## Try it locally in 30 seconds

```bash
npm install
npm run dev
# open http://localhost:5173
```

1. Open **Settings** and paste your `sk-…` (OpenAI) and `sk-ant-…`
   (Anthropic) keys. Press **Проверить** on each to confirm they work.
2. Go back to **Запись**. Click **Record** and start talking.
3. Transcript streams into the left column; Claude's insights (summary,
   action items, topics, open questions, sentiment, energy) render on the
   right.

## Deploy it as a public service

Because there's no backend, you can host the built `dist/` folder on any
static host.

### Vercel

```bash
npx vercel        # first run — pick settings
npx vercel --prod # publish
```

`vercel.json` is already present with the SPA rewrite and asset caching rules.

### Netlify

```bash
npx netlify deploy --build --prod
```

`netlify.toml` already configures the build command, publish directory, and
SPA fallback.

### GitHub Pages

Push to `main` and the included workflow
(`.github/workflows/deploy-pages.yml`) runs `npm run build` and publishes
`dist/` to Pages. Enable Pages with source = "GitHub Actions" in the repo
settings.

### Any static host

```bash
npm run build
# upload dist/ to S3 / Cloudflare Pages / R2 / a plain Nginx box — anywhere
```

Make sure your host rewrites unknown paths to `/index.html` (SPA fallback).

## How it works

1. **Capture.** `useAudioRecorder` asks for the mic, wires an `AnalyserNode`
   for level metering, and cycles `MediaRecorder` every ~3.5 s so each chunk
   is an independently-decodable WebM/Opus blob.
2. **VAD.** An energy-based detector (`lib/vad.ts`) tracks the rolling noise
   floor and drops silent chunks before they hit Whisper — saves money,
   kills hallucinated transcripts.
3. **Transcription.** Each speech chunk is POSTed straight to
   `https://api.openai.com/v1/audio/transcriptions` from the browser, with
   the tail of the prior transcript as a biasing prompt for continuity.
4. **Insights.** `useInsights` watches the growing transcript, debounces
   4 s, and fires when the transcript has grown by ≥200 chars. It calls
   Claude via `@anthropic-ai/sdk` with `dangerouslyAllowBrowser: true` and
   a strict JSON system prompt. The response is validated and normalized
   before being rendered.
5. **Storage + export.** Last 5 sessions live in `localStorage` (toggleable
   in Settings). Markdown / PDF / clipboard export at any time.

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

- **Keys are user-owned.** Each user pastes their own keys in the Settings
  page. They're stored in that user's `localStorage` and nowhere else.
- **No backend means no shared blast radius.** If you spin this up at
  `jarvis.example.com`, every visitor uses their own keys and pays their own
  bill. You never see their audio, transcripts, or keys.
- **Anthropic browser flag.** We set
  `anthropic-dangerous-direct-browser-access: true` — the visitor is
  knowingly exposing their key to the page they're using. Same posture as
  OpenAI's `dangerouslyAllowBrowser`.
- **Audio is never persisted.** Chunks are sent to Whisper and then garbage
  collected. Transcripts stay in `localStorage` only if the user enables
  session history.

If you need a multi-tenant setup with shared billing, add a thin proxy in
front — see `ARCHITECTURE.md`. The `server/` folder in this repo is a
reference Express implementation that can be adapted.

## Browser support

Requires a browser with:

- `getUserMedia` (all evergreen browsers)
- `MediaRecorder` with Opus support (Chrome, Edge, Firefox, Safari 14.1+)
- `fetch` + `FormData` + `AbortController`

Served over HTTPS is required for the microphone API — `localhost` works too
during dev.

## Commands

```bash
npm run dev         # vite dev server on :5173
npm run build       # production build to dist/
npm run preview     # serve dist/ locally
npm run typecheck   # tsc --noEmit
```

## What's next

See `ARCHITECTURE.md` for how the remaining layers from the original spec
plug into this same core: React Native mobile client, Python Raspberry-Pi
SDK, Alexa/Google webhooks, and a TS/JS `VoiceIntelligence` SDK for
third-party integrations.

## License

MIT
