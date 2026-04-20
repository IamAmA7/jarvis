/**
 * Browser-side API client.
 *
 * Calls OpenAI Whisper and Anthropic Claude directly from the browser. The
 * user supplies their own API keys through the Settings page. Keys live in
 * localStorage and are attached as headers on each request.
 *
 * CORS status (verified on both providers):
 *   - OpenAI       — `Authorization: Bearer <key>` is accepted from the browser.
 *   - Anthropic    — also accepted, but requires the explicit
 *     `anthropic-dangerous-direct-browser-access: true` header to signal that
 *     the caller knows keys are exposed to the user.
 *
 * Error handling keeps keys out of logs: we never echo the request headers.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { Insight, InsightType, TranscriptSegment } from '../types';
import type { ClaudeModel, Settings } from './settings';

const OPENAI_TRANSCRIBE_URL = 'https://api.openai.com/v1/audio/transcriptions';

export interface TranscribeResult {
  text: string;
  language: string | null;
  duration: number | null;
  segments: TranscriptSegment[];
}

export interface TranscribeOptions {
  language?: string;
  /** Biasing prompt — pass the tail of the prior transcript for continuity. */
  prompt?: string;
  signal?: AbortSignal;
}

export async function transcribeChunk(
  audio: Blob,
  settings: Settings,
  opts: TranscribeOptions = {},
): Promise<TranscribeResult> {
  if (!settings.openaiApiKey) {
    throw new Error('OpenAI API key is not set. Open Settings and paste your key.');
  }

  const form = new FormData();
  const ext = blobExtension(audio.type);
  form.append('file', audio, `chunk.${ext}`);
  form.append('model', 'whisper-1');
  form.append('response_format', 'verbose_json');
  form.append('temperature', '0');

  const language = opts.language ?? settings.language;
  if (language) form.append('language', language);
  if (opts.prompt) form.append('prompt', opts.prompt.slice(-900));

  const res = await fetch(OPENAI_TRANSCRIBE_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${settings.openaiApiKey}`,
    },
    body: form,
    signal: opts.signal,
  });
  if (!res.ok) throw await toError(res, 'Whisper');

  const data = (await res.json()) as {
    text?: string;
    language?: string;
    duration?: number;
    segments?: Array<{ start: number; end: number; text: string }>;
  };
  return {
    text: data.text ?? '',
    language: data.language ?? language ?? null,
    duration: data.duration ?? null,
    segments: data.segments?.map((s) => ({ start: s.start, end: s.end, text: s.text })) ?? [],
  };
}

export interface InsightsRequest {
  transcript: string;
  context?: string;
  insightTypes?: InsightType[];
  sessionId?: string;
  signal?: AbortSignal;
}

const INSIGHTS_SYSTEM_PROMPT = `You are Jarvis, a meeting-intelligence assistant. You read raw, possibly-messy
speech transcripts (which may mix Russian, Ukrainian, and English) and extract structured insight.

HARD RULES:
- Respond with a single JSON object. No prose before or after. No markdown fences.
- If a field has no content, use an empty array or null. Never invent facts.
- Owners and deadlines for action items must come from the transcript. If not stated, set them to null.
- energy_level is an integer 1-5: 1=flat/disengaged, 3=steady, 5=high-energy/urgent.
- sentiment is one of: "positive", "neutral", "tense".
- language_detected is one of: "ru", "en", "uk", or "mixed".

JSON SCHEMA:
{
  "session_id": string,
  "timestamp": ISO8601 string,
  "summary": string[],
  "action_items": [{ "action": string, "owner": string|null, "deadline": string|null }],
  "key_topics": string[],
  "open_questions": string[],
  "sentiment": "positive" | "neutral" | "tense",
  "energy_level": 1|2|3|4|5,
  "language_detected": "ru" | "en" | "uk" | "mixed"
}`;

export async function requestInsights(
  req: InsightsRequest,
  settings: Settings,
): Promise<Insight> {
  if (!settings.anthropicApiKey) {
    throw new Error('Anthropic API key is not set. Open Settings and paste your key.');
  }

  const client = new Anthropic({
    apiKey: settings.anthropicApiKey,
    dangerouslyAllowBrowser: true,
  });

  const sessionId = req.sessionId ?? makeFallbackId();
  const context = req.context?.trim();
  const insightTypes = req.insightTypes?.length
    ? req.insightTypes
    : ['summary', 'action_items', 'key_topics', 'open_questions', 'sentiment'];

  const userMessage = [
    context ? `SESSION CONTEXT: ${context}` : null,
    `REQUESTED INSIGHT TYPES: ${insightTypes.join(', ')}`,
    `SESSION ID: ${sessionId}`,
    `TIMESTAMP: ${new Date().toISOString()}`,
    '',
    'TRANSCRIPT:',
    req.transcript,
  ]
    .filter(Boolean)
    .join('\n');

  const response = await client.messages.create(
    {
      model: settings.model,
      max_tokens: 1500,
      temperature: 0.2,
      system: INSIGHTS_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    },
    { signal: req.signal },
  );

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((b) => b.text)
    .join('');

  const parsed = safeParseJson(text);
  if (!parsed) {
    throw new Error('Claude вернул некорректный JSON. Попробуйте ещё раз.');
  }
  return normalizeInsight(parsed, sessionId);
}

/**
 * Lightweight "does the key work?" test — used by Settings to validate a
 * freshly-pasted key without burning a full transcription/insight.
 */
export async function testOpenAIKey(key: string): Promise<void> {
  const res = await fetch('https://api.openai.com/v1/models', {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!res.ok) throw await toError(res, 'OpenAI');
}

export async function testAnthropicKey(key: string, model: ClaudeModel): Promise<void> {
  const client = new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true });
  await client.messages.create({
    model,
    max_tokens: 8,
    messages: [{ role: 'user', content: 'ping' }],
  });
}

// ————— internals —————

async function toError(res: Response, provider: string): Promise<Error> {
  let detail = `${res.status} ${res.statusText}`;
  try {
    const body = (await res.json()) as {
      error?: { message?: string } | string;
    };
    const msg =
      typeof body.error === 'string' ? body.error : body.error?.message ?? detail;
    detail = msg;
  } catch {
    // non-JSON
  }
  const err = new Error(`${provider}: ${detail}`);
  (err as unknown as { status?: number }).status = res.status;
  return err;
}

function safeParseJson(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through */
  }
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(trimmed.slice(first, last + 1));
    } catch {
      return null;
    }
  }
  return null;
}

function normalizeInsight(raw: Record<string, unknown>, sessionId: string): Insight {
  const asStringArray = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  const asActionItems = (v: unknown): Insight['action_items'] => {
    if (!Array.isArray(v)) return [];
    return v
      .map((item) => {
        if (!item || typeof item !== 'object') return null;
        const obj = item as Record<string, unknown>;
        return {
          action: typeof obj.action === 'string' ? obj.action : '',
          owner: typeof obj.owner === 'string' ? obj.owner : null,
          deadline: typeof obj.deadline === 'string' ? obj.deadline : null,
        };
      })
      .filter((x): x is Insight['action_items'][number] => x !== null && x.action.length > 0);
  };

  const sentiment = ((): Insight['sentiment'] => {
    const s = raw.sentiment;
    if (s === 'positive' || s === 'neutral' || s === 'tense') return s;
    return 'neutral';
  })();

  const energy = ((): Insight['energy_level'] => {
    const n = Number(raw.energy_level);
    if (n >= 1 && n <= 5 && Number.isInteger(n)) return n as Insight['energy_level'];
    return 3;
  })();

  const language = ((): Insight['language_detected'] => {
    const v = raw.language_detected;
    if (v === 'ru' || v === 'en' || v === 'uk' || v === 'mixed') return v;
    return 'mixed';
  })();

  return {
    session_id: sessionId,
    timestamp: typeof raw.timestamp === 'string' ? raw.timestamp : new Date().toISOString(),
    summary: asStringArray(raw.summary),
    action_items: asActionItems(raw.action_items),
    key_topics: asStringArray(raw.key_topics),
    open_questions: asStringArray(raw.open_questions),
    sentiment,
    energy_level: energy,
    language_detected: language,
  };
}

function blobExtension(mime: string): string {
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('mp4')) return 'mp4';
  if (mime.includes('wav')) return 'wav';
  return 'webm';
}

function makeFallbackId(): string {
  return (
    (globalThis.crypto as { randomUUID?: () => string }).randomUUID?.() ??
    String(Date.now())
  );
}
