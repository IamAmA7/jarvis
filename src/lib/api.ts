/**
 * Browser-side API client.
 *
 * All calls now go through our Vercel functions (`/api/*`). We no longer ship
 * any user-supplied OpenAI/Anthropic keys in the browser — they live as
 * server env vars on Vercel and are proxied per-request, with Clerk's JWT
 * on every outbound call so the server can bill the right user.
 *
 * `getToken` is supplied by the `useJarvisAuth` hook and returns a fresh
 * short-lived JWT. We call it on every request rather than caching because
 * Clerk rotates tokens; paying the JWKS lookup on the server is cheap.
 */
import type { Insight, InsightType, TranscriptSegment } from '../types';

export type GetToken = () => Promise<string | null>;

export interface TranscribeResult {
  text: string;
  language: string | null;
  duration: number | null;
  segments: TranscriptSegment[];
  quota?: { usedSec: number; limitSec: number | null; plan: 'free' | 'pro' };
}

export interface TranscribeOptions {
  language?: string;
  prompt?: string;
  signal?: AbortSignal;
}

async function authedFetch(path: string, getToken: GetToken, init: RequestInit = {}): Promise<Response> {
  const token = await getToken();
  if (!token) throw new Error('Not signed in');
  const headers = new Headers(init.headers ?? {});
  headers.set('Authorization', `Bearer ${token}`);
  return fetch(path, { ...init, headers });
}

export async function transcribeChunk(
  audio: Blob,
  getToken: GetToken,
  opts: TranscribeOptions = {},
): Promise<TranscribeResult> {
  const form = new FormData();
  const ext = blobExtension(audio.type);
  form.append('file', audio, `chunk.${ext}`);
  if (opts.language) form.append('language', opts.language);
  if (opts.prompt) form.append('prompt', opts.prompt.slice(-900));

  const res = await authedFetch('/api/transcribe', getToken, {
    method: 'POST',
    body: form,
    signal: opts.signal,
  });
  if (!res.ok) throw await toError(res, 'Whisper');
  return (await res.json()) as TranscribeResult;
}

export interface InsightsRequest {
  transcript: string;
  context?: string;
  insightTypes?: InsightType[];
  sessionId?: string;
  model?: string;
  signal?: AbortSignal;
}

export async function requestInsights(req: InsightsRequest, getToken: GetToken): Promise<Insight> {
  const res = await authedFetch('/api/insights', getToken, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      transcript: req.transcript,
      context: req.context,
      insightTypes: req.insightTypes,
      sessionId: req.sessionId,
      model: req.model,
    }),
    signal: req.signal,
  });
  if (!res.ok) throw await toError(res, 'Claude');
  return (await res.json()) as Insight;
}

export interface UsageSnapshot {
  plan: 'free' | 'pro';
  usedSec: number;
  limitSec: number | null;
  usedInsights: number;
  limitInsights: number | null;
  allowed: boolean;
}

export async function fetchUsage(getToken: GetToken): Promise<UsageSnapshot> {
  const res = await authedFetch('/api/usage', getToken);
  if (!res.ok) throw await toError(res, 'Usage');
  return (await res.json()) as UsageSnapshot;
}

// ————— sessions —————

export interface SessionRow {
  id: string;
  title: string;
  context: string | null;
  language: string;
  model: string;
  started_at: string;
  ended_at: string | null;
  duration_sec: number;
}

export async function listSessions(getToken: GetToken): Promise<SessionRow[]> {
  const res = await authedFetch('/api/sessions', getToken);
  if (!res.ok) throw await toError(res, 'Sessions');
  const body = (await res.json()) as { sessions: SessionRow[] };
  return body.sessions;
}

export interface SessionDetail {
  session: SessionRow;
  segments: Array<{
    idx: number;
    start_sec: number;
    end_sec: number;
    text: string;
    speaker: string | null;
  }>;
  insight: {
    summary: string[];
    action_items: Array<{ action: string; owner: string | null; deadline: string | null }>;
    key_topics: string[];
    open_questions: string[];
    sentiment: 'positive' | 'neutral' | 'tense';
    energy_level: 1 | 2 | 3 | 4 | 5;
    language_detected: 'ru' | 'en' | 'uk' | 'mixed';
  } | null;
}

export async function getSession(getToken: GetToken, id: string): Promise<SessionDetail> {
  const res = await authedFetch(`/api/sessions/${encodeURIComponent(id)}`, getToken);
  if (!res.ok) throw await toError(res, 'Sessions');
  return (await res.json()) as SessionDetail;
}

export async function createSession(
  getToken: GetToken,
  payload: { title?: string; context?: string; language?: string; model?: string },
): Promise<SessionRow> {
  const res = await authedFetch('/api/sessions', getToken, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw await toError(res, 'Sessions');
  return (await res.json()) as SessionRow;
}

export async function patchSession(
  getToken: GetToken,
  id: string,
  body: {
    title?: string;
    context?: string;
    ended_at?: string;
    duration_sec?: number;
    segments?: Array<{ idx: number; start: number; end: number; text: string; speaker?: string }>;
    insight?: Insight;
  },
): Promise<void> {
  const res = await authedFetch(`/api/sessions/${encodeURIComponent(id)}`, getToken, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await toError(res, 'Sessions');
}

export async function deleteSession(getToken: GetToken, id: string): Promise<void> {
  const res = await authedFetch(`/api/sessions/${encodeURIComponent(id)}`, getToken, {
    method: 'DELETE',
  });
  if (!res.ok) throw await toError(res, 'Sessions');
}

// ————— Deepgram (streaming) —————

export async function mintDeepgramKey(getToken: GetToken): Promise<{ key: string; expiresInSec: number }> {
  const res = await authedFetch('/api/deepgram/token', getToken);
  if (!res.ok) throw await toError(res, 'Deepgram');
  return (await res.json()) as { key: string; expiresInSec: number };
}

// ————— billing —————

export async function startCheckout(getToken: GetToken): Promise<string> {
  const res = await authedFetch('/api/stripe/checkout', getToken, { method: 'POST' });
  if (!res.ok) throw await toError(res, 'Stripe');
  const body = (await res.json()) as { url: string };
  return body.url;
}

export async function openBillingPortal(getToken: GetToken): Promise<string> {
  const res = await authedFetch('/api/stripe/portal', getToken, { method: 'POST' });
  if (!res.ok) throw await toError(res, 'Stripe');
  const body = (await res.json()) as { url: string };
  return body.url;
}

// ————— internals —————

async function toError(res: Response, label: string): Promise<Error> {
  let detail = `${res.status} ${res.statusText}`;
  try {
    const body = (await res.json()) as { error?: string };
    if (body.error) detail = body.error;
  } catch {
    /* non-JSON */
  }
  const err = new Error(`${label}: ${detail}`);
  (err as { status?: number }).status = res.status;
  return err;
}

function blobExtension(mime: string): string {
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('mp4')) return 'mp4';
  if (mime.includes('wav')) return 'wav';
  return 'webm';
}
