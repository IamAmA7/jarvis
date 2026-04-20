/**
 * POST /api/insights — Claude insights proxy.
 *
 * Body: { transcript, context?, insightTypes?, sessionId?, model? }
 * Returns a normalised Insight object matching `src/types.ts`.
 *
 * The system prompt lives here, not in the client, so we can ship prompt
 * changes without asking users to refresh. The model choice is clamped to a
 * short allow-list to stop budget leaks.
 */
import { errorResponse, HttpError, json, requireUser } from './_lib/auth';
import { incrementUsage } from './_lib/supabase';

export const config = { runtime: 'edge' };

const ALLOWED_MODELS = new Set([
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
  'claude-opus-4-6',
]);

const SYSTEM = `You are Jarvis, a meeting-intelligence assistant. You read raw, possibly-messy
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

export default async function handler(req: Request): Promise<Response> {
  try {
    if (req.method !== 'POST') throw new HttpError(405, 'POST only');
    const { userId } = await requireUser(req);

    const body = (await req.json()) as {
      transcript?: string;
      context?: string;
      insightTypes?: string[];
      sessionId?: string;
      model?: string;
    };

    const transcript = (body.transcript ?? '').trim();
    if (!transcript) throw new HttpError(400, 'transcript is required');

    const model = body.model && ALLOWED_MODELS.has(body.model) ? body.model : 'claude-sonnet-4-6';
    const sessionId = body.sessionId ?? crypto.randomUUID();
    const context = body.context?.trim();
    const types = body.insightTypes?.length
      ? body.insightTypes
      : ['summary', 'action_items', 'key_topics', 'open_questions', 'sentiment'];

    const userMessage = [
      context ? `SESSION CONTEXT: ${context}` : null,
      `REQUESTED INSIGHT TYPES: ${types.join(', ')}`,
      `SESSION ID: ${sessionId}`,
      `TIMESTAMP: ${new Date().toISOString()}`,
      '',
      'TRANSCRIPT:',
      transcript,
    ]
      .filter(Boolean)
      .join('\n');

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new HttpError(500, 'ANTHROPIC_API_KEY not configured');

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 1500,
        temperature: 0.2,
        system: SYSTEM,
        messages: [{ role: 'user', content: userMessage }],
      }),
    });
    if (!res.ok) {
      const detail = await res.text();
      throw new HttpError(res.status, `Anthropic: ${detail.slice(0, 400)}`);
    }
    const data = (await res.json()) as {
      content?: Array<{ type: string; text?: string }>;
    };
    const text = (data.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');

    const parsed = safeParseJson(text);
    if (!parsed) throw new HttpError(502, 'Claude returned invalid JSON');

    void incrementUsage(userId, { insightsCalls: 1 });

    return json(200, normalise(parsed, sessionId));
  } catch (err) {
    return errorResponse(err);
  }
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

function normalise(raw: Record<string, unknown>, sessionId: string) {
  const asStrArr = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  const asActions = (v: unknown) => {
    if (!Array.isArray(v)) return [];
    return v
      .map((item) => {
        if (!item || typeof item !== 'object') return null;
        const o = item as Record<string, unknown>;
        const action = typeof o.action === 'string' ? o.action : '';
        if (!action) return null;
        return {
          action,
          owner: typeof o.owner === 'string' ? o.owner : null,
          deadline: typeof o.deadline === 'string' ? o.deadline : null,
        };
      })
      .filter((x): x is { action: string; owner: string | null; deadline: string | null } => x !== null);
  };
  const sentiment = (() => {
    const s = raw.sentiment;
    return s === 'positive' || s === 'tense' ? s : 'neutral';
  })();
  const energy = (() => {
    const n = Number(raw.energy_level);
    return n >= 1 && n <= 5 && Number.isInteger(n) ? n : 3;
  })();
  const lang = (() => {
    const v = raw.language_detected;
    return v === 'ru' || v === 'en' || v === 'uk' ? v : 'mixed';
  })();
  return {
    session_id: sessionId,
    timestamp: typeof raw.timestamp === 'string' ? raw.timestamp : new Date().toISOString(),
    summary: asStrArr(raw.summary),
    action_items: asActions(raw.action_items),
    key_topics: asStrArr(raw.key_topics),
    open_questions: asStrArr(raw.open_questions),
    sentiment,
    energy_level: energy,
    language_detected: lang,
  };
}
