# Jarvis — architecture & integration layers

The web prototype in this repo is one client of a broader system. Every
integration — mobile, wearable, Raspberry Pi, Alexa — speaks to the same
backend contract: **audio in → transcript + insight JSON out.**

```
                    ┌──────────────────────────────────────┐
                    │         Jarvis core backend          │
                    │   /api/transcribe   /api/insights    │
                    │   /api/sessions/:id  /stream (WS)    │
                    └───────▲──────▲────────▲──────▲───────┘
                            │      │        │      │
           ┌────────────────┘      │        │      └────────────────┐
           │                       │        │                        │
   ┌───────┴──────┐        ┌──────┴───┐  ┌──┴──────────┐   ┌─────────┴────────┐
   │  Web app     │        │ Mobile   │  │ Hardware    │   │ Smart speakers   │
   │  (this repo) │        │ (RN/iOS) │  │ (Py/MQTT)   │   │ (Alexa / Google) │
   └──────────────┘        └──────────┘  └─────────────┘   └──────────────────┘
```

## Contract every client must implement

Any client — regardless of platform — must be able to:

1. Capture mono 16-bit PCM audio (16 kHz recommended).
2. Chunk audio on VAD or a fixed cadence (2–5 s per chunk).
3. Either:
   - POST the chunk as a blob to `/api/transcribe` (simple, stateless), **or**
   - Open a WebSocket to `/stream` and send binary PCM frames (low latency).
4. Buffer the running transcript locally and POST it to `/api/insights` on a
   debounced cadence.
5. Render the returned JSON against the shared `Insight` schema (see
   `src/types.ts`).

That's it. Every integration below is just a different incarnation of those
five steps.

## Layer 3 — Session storage + export *(partially done)*

Today, sessions live in `localStorage` (last 5). The next step:

- Add `GET /api/sessions`, `GET /api/sessions/:id`, `POST /api/sessions`.
- Store in Supabase (Postgres) — schema:
  ```sql
  create table sessions (
    id uuid primary key,
    user_id uuid references auth.users(id),
    context text,
    created_at timestamptz default now(),
    transcript text,
    insight jsonb
  );
  ```
- Client toggles "persist to cloud" per-session (privacy opt-in).
- Auth via Supabase magic-link or JWT.

## Layer 4 — REST backend expansion

Roughly: promote the current Express app from "proxy" to full backend.

- **WebSocket `/stream`** — accepts `{ type: 'audio', payload: binary }` and
  `{ type: 'context', payload: string }` frames, emits `{ type: 'transcript' }`
  and `{ type: 'insight' }` frames. Wraps the same Whisper + Claude flow but
  with lower latency.
- **API key auth** — middleware checks `Authorization: Bearer <key>` or a
  Supabase JWT. Personal keys for SDK users; JWT for first-party apps.
- **Rate limiting** — per-key token bucket.
- **Structured logging** — swap `console.log` for `pino`.

## Layer 5 — React Native mobile app

- Expo project, Expo Audio or bare RN with AVFoundation (iOS) / MediaRecorder
  (Android).
- Share `src/types.ts`, `src/lib/api.ts`, `src/hooks/useInsights.ts`,
  `src/hooks/useTranscription.ts` with the web app via a `packages/core`
  workspace. The only platform-specific code is `useAudioRecorder`.
- Background audio via `expo-av` with `staysActiveInBackground: true`.
- Push notifications (Expo Notifications) when an insight is ready after the
  user backgrounded the session.

## Layer 6 — Hardware SDK (Python / Raspberry Pi)

Reference implementation lives at `hardware/python-sdk/` (to be added). Shape:

```python
from jarvis import VoiceIntelligence

session = VoiceIntelligence(
    api_key=os.environ["JARVIS_API_KEY"],
    language="ru",
    context="Kitchen timer assistant",
    insight_types=["summary", "action_items"],
    on_transcript=lambda chunk: print("T:", chunk),
    on_insight=lambda insight: publish_mqtt(insight),
)

# Option A — blocking mic capture
session.start_from_microphone(device_index=1)

# Option B — stream PCM frames from wherever
for frame in my_i2s_reader():        # bytes, 16-bit LE mono 16 kHz
    session.push_pcm(frame)
```

Under the hood the SDK opens a WebSocket to `/stream`, sends raw PCM, and
relays events back to the user's callbacks. MQTT publishing is a one-liner
wrapper.

## Layer 7 — Smart speaker integrations

### Alexa

- Build an **Alexa Smart Home skill** with a custom intent that forwards the
  captured audio URL to `POST /api/transcribe` server-side.
- Insight response is shaped into an Alexa `SpeakDirective` (summary bullets)
  plus a card.

### Google Assistant / Nest

- Google Actions project with a fulfillment webhook → forwards transcribed
  text to `POST /api/insights` and returns a summary SSML response.

Both integrations fit entirely on the server side — no changes to the core
contract. The `/api/insights` endpoint is intentionally device-agnostic.

## TS/JS SDK (`VoiceIntelligence`)

The third-party integration surface described in the spec. Lives at
`packages/sdk/` (to be added). Same runtime as the web app's hooks but packaged
for consumption by other apps:

```ts
import { VoiceIntelligence } from '@jarvis/sdk';

const session = new VoiceIntelligence({
  apiKey: 'YOUR_KEY',
  language: 'ru',
  context: 'Board meeting, strategic review',
  insightTypes: ['summary', 'actions', 'sentiment'],
  onTranscript: (chunk) => console.log(chunk.text),
  onInsight: (insight) => renderInsight(insight),
});

await session.startFromMicrophone();
// OR
await session.startFromStream(audioStream);
// OR
await session.startFromFile(audioBlob);
```

Internally it reuses `useAudioRecorder`'s logic stripped of React, plus the
same `/api/transcribe` and `/api/insights` endpoints — so the web app, the
SDK, and the mobile app all drive through identical server-side code paths.

## Privacy & data-retention defaults

- **Audio** is never stored. Chunks are transcribed and immediately discarded.
- **Transcripts** are stored client-side only (localStorage or the mobile app
  local DB) unless the user explicitly enables cloud persistence.
- **Context strings** follow the same rule as transcripts.
- **Exports** (Markdown / PDF) are always user-initiated — nothing is written
  to disk automatically.

## Latency budget

| Step                        | Target | Notes |
| --------------------------- | ------ | ----- |
| First audio chunk           |  3.5 s | Recorder cycle length. |
| Whisper RTT                 |  1–2 s | `whisper-1` REST. |
| First transcript rendered   |   ~5 s |
| Insight debounce            |   4 s  | After last new transcript. |
| Claude (sonnet-4-6) RTT     |  2–4 s |
| **First insight visible**   | **~9–11 s** | Meets the 10 s target on average. |

If users demand tighter latency, switch to AssemblyAI streaming WebSocket
(transcript within ~300 ms of speech) and the first-insight budget drops
below 6 s.
