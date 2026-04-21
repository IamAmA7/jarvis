/**
 * Minimal Claude client used by /api/insights and the listener alert
 * classifier. Returns the concatenated text of the `text` content blocks
 * and throws HttpError on a non-2xx response.
 */
import { HttpError } from './auth';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

export const ALLOWED_MODELS = new Set([
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
  'claude-opus-4-6',
]);

export function pickModel(requested?: string | null, fallback = 'claude-sonnet-4-6'): string {
  return requested && ALLOWED_MODELS.has(requested) ? requested : fallback;
}

export interface ClaudeRequest {
  model: string;
  system: string;
  user: string;
  maxTokens?: number;
  temperature?: number;
}

export async function callClaude(req: ClaudeRequest): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new HttpError(500, 'ANTHROPIC_API_KEY not configured');
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: req.model,
      max_tokens: req.maxTokens ?? 1500,
      temperature: req.temperature ?? 0.2,
      system: req.system,
      messages: [{ role: 'user', content: req.user }],
    }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new HttpError(res.status, `Anthropic: ${detail.slice(0, 400)}`);
  }
  const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
  return (data.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('');
}

/** Permissive JSON extractor: tries full parse, then {...} fallback. */
export function safeParseJson<T = Record<string, unknown>>(text: string): T | null {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    /* fall through */
  }
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(trimmed.slice(first, last + 1)) as T;
    } catch {
      return null;
    }
  }
  return null;
}
