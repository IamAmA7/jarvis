/**
 * GET /api/cron/gcs-sync — Pulls audio recordings from a Google Cloud Storage
 * bucket every 5 minutes, transcribes them via Whisper, generates Claude
 * insights, and persists the result to Supabase.
 *
 * Auth:
 *   - Vercel cron sends `x-vercel-cron: 1` header (trusted).
 *   - Manual triggers must include `Authorization: Bearer <CRON_SECRET>`.
 *
 * GCS auth:
 *   - Service account JSON stored as env var `GCP_SERVICE_ACCOUNT_JSON`.
 *   - We mint a short-lived JWT with `jose` and exchange it for an OAuth2
 *     access token at https://oauth2.googleapis.com/token.
 */
import { SignJWT, importPKCS8 } from 'jose';
import { admin } from '../_lib/supabase.js';

export const config = { runtime: 'nodejs', maxDuration: 60 };

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GCS_READ_SCOPE = 'https://www.googleapis.com/auth/devstorage.read_only';
const STORAGE_BASE = 'https://storage.googleapis.com/storage/v1';
const OPENAI_TRANSCRIBE_URL = 'https://api.openai.com/v1/audio/transcriptions';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const MAX_FILES_PER_RUN = 5;
const WHISPER_MAX_BYTES = 25 * 1024 * 1024;

interface ServiceAccount { client_email: string; private_key: string; token_uri?: string; }
interface GcsObject { name: string; size: number; contentType: string; timeCreated: string; updated: string; }
interface InsightJson {
  summary: string[];
  action_items: { action: string; owner: string | null; deadline: string | null }[];
  key_topics: string[];
  open_questions: string[];
  sentiment: 'positive' | 'neutral' | 'tense';
  energy_level: number;
  language_detected: 'ru' | 'en' | 'uk' | 'mixed';
}

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

function getHeader(req: any, name: string): string | null {
  const h = req?.headers;
  if (!h) return null;
  if (typeof h.get === 'function') return h.get(name);
  if (typeof h === 'object') {
    const v = h[name.toLowerCase()];
    if (Array.isArray(v)) return v[0] ?? null;
    return (v ?? null) as string | null;
  }
  return null;
}

function verifyCron(req: any): void {
  if (getHeader(req, 'x-vercel-cron')) return;
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) throw new HttpError(500, 'CRON_SECRET not configured');
  const auth = getHeader(req, 'authorization') ?? '';
  if (auth !== `Bearer ${cronSecret}`) throw new HttpError(401, 'Unauthorized cron request');
}

interface CachedToken { token: string; expiresAt: number; }
let tokenCache: CachedToken | null = null;

async function getAccessToken(): Promise<string> {
  const now = Date.now();
  if (tokenCache && tokenCache.expiresAt > now + 60_000) return tokenCache.token;
  const raw = process.env.GCP_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new HttpError(500, 'GCP_SERVICE_ACCOUNT_JSON not configured');
  let sa: ServiceAccount;
  try { sa = JSON.parse(raw) as ServiceAccount; } catch { throw new HttpError(500, 'GCP_SERVICE_ACCOUNT_JSON is not valid JSON'); }
  if (!sa.client_email || !sa.private_key) throw new HttpError(500, 'service account JSON missing client_email/private_key');
  const issuedAt = Math.floor(now / 1000);
  const expiresAt = issuedAt + 3600;
  const tokenUri = sa.token_uri || GOOGLE_TOKEN_URL;
  const pem = sa.private_key.replace(/\\n/g, '\n');
  const key = await importPKCS8(pem, 'RS256');
  const assertion = await new SignJWT({ scope: GCS_READ_SCOPE })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuer(sa.client_email)
    .setSubject(sa.client_email)
    .setAudience(tokenUri)
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiresAt)
    .sign(key);
  const body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion });
  const res = await fetch(tokenUri, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
  if (!res.ok) {
    const text = await res.text();
    throw new HttpError(500, `Google token exchange failed: ${res.status} ${text.slice(0, 500)}`);
  }
  const data = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) throw new HttpError(500, 'Google did not return access_token');
  tokenCache = { token: data.access_token, expiresAt: now + (data.expires_in ?? 3600) * 1000 };
  return tokenCache.token;
}

interface ListResponse {
  items?: Array<{ name: string; size?: string; contentType?: string; timeCreated?: string; updated?: string }>;
  nextPageToken?: string;
}

async function listObjects(bucket: string, token: string, prefix: string): Promise<GcsObject[]> {
  const out: GcsObject[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(`${STORAGE_BASE}/b/${encodeURIComponent(bucket)}/o`);
    url.searchParams.set('maxResults', '1000');
    url.searchParams.set('fields', 'items(name,size,contentType,timeCreated,updated),nextPageToken');
    if (prefix) url.searchParams.set('prefix', prefix);
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      const detail = await res.text();
      throw new HttpError(res.status, `GCS list failed: ${detail.slice(0, 400)}`);
    }
    const data = (await res.json()) as ListResponse;
    for (const it of data.items ?? []) {
      out.push({
        name: it.name,
        size: Number(it.size ?? 0),
        contentType: it.contentType ?? 'application/octet-stream',
        timeCreated: it.timeCreated ?? '',
        updated: it.updated ?? '',
      });
    }
    pageToken = data.nextPageToken;
  } while (pageToken);
  return out;
}

async function downloadObject(bucket: string, name: string, token: string): Promise<Blob> {
  const url = `${STORAGE_BASE}/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(name)}?alt=media`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const detail = await res.text();
    throw new HttpError(res.status, `GCS download failed: ${detail.slice(0, 400)}`);
  }
  return res.blob();
}

async function transcribeWhisper(file: Blob, filename: string): Promise<{ text: string; language: string | null; duration: number | null }> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new HttpError(500, 'OPENAI_API_KEY not configured');
  const form = new FormData();
  form.append('file', file, filename);
  form.append('model', 'whisper-1');
  form.append('response_format', 'verbose_json');
  form.append('temperature', '0');
  const res = await fetch(OPENAI_TRANSCRIBE_URL, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form });
  if (!res.ok) {
    const detail = await res.text();
    throw new HttpError(res.status, `Whisper failed: ${detail.slice(0, 400)}`);
  }
  const data = (await res.json()) as { text?: string; language?: string; duration?: number };
  return { text: (data.text ?? '').trim(), language: data.language ?? null, duration: data.duration ?? null };
}

const INSIGHTS_SYSTEM = `You are Jarvis, a meeting-intelligence assistant. You read raw, possibly-messy speech transcripts (which may mix Russian, Ukrainian, and English) and extract structured insight.

HARD RULES:
- Respond with a single JSON object. No prose before or after. No markdown fences.
- If a field has no content, use an empty array or null. Never invent facts.
- Owners and deadlines for action items must come from the transcript. If not stated, set them to null.
- energy_level is an integer 1-5: 1=flat/disengaged, 3=steady, 5=high-energy/urgent.
- sentiment is one of: "positive", "neutral", "tense".
- language_detected is one of: "ru", "en", "uk", or "mixed".

JSON SCHEMA:
{
  "summary": string[],
  "action_items": [{ "action": string, "owner": string|null, "deadline": string|null }],
  "key_topics": string[],
  "open_questions": string[],
  "sentiment": "positive" | "neutral" | "tense",
  "energy_level": 1|2|3|4|5,
  "language_detected": "ru" | "en" | "uk" | "mixed"
}`;

async function generateInsights(transcript: string): Promise<InsightJson | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      temperature: 0.2,
      system: INSIGHTS_SYSTEM,
      messages: [{ role: 'user', content: `TRANSCRIPT:\n${transcript}` }],
    }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new HttpError(res.status, `Claude failed: ${detail.slice(0, 400)}`);
  }
  const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
  const text = (data.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('').trim();
  return parseInsightJson(text);
}

function parseInsightJson(text: string): InsightJson | null {
  const tryParse = (s: string): unknown => { try { return JSON.parse(s); } catch { return null; } };
  let raw = tryParse(text);
  if (!raw) {
    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    if (first >= 0 && last > first) raw = tryParse(text.slice(first, last + 1));
  }
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const asStringArray = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  const sentiment = ((): InsightJson['sentiment'] => { const s = r.sentiment; return s === 'positive' || s === 'tense' ? s : 'neutral'; })();
  const energy = ((): InsightJson['energy_level'] => { const n = Number(r.energy_level); return n >= 1 && n <= 5 && Number.isInteger(n) ? n : 3; })();
  const language = ((): InsightJson['language_detected'] => { const v = r.language_detected; return v === 'ru' || v === 'en' || v === 'uk' || v === 'mixed' ? v : 'mixed'; })();
  const actionItems = Array.isArray(r.action_items)
    ? (r.action_items as unknown[]).map((it) => {
        if (!it || typeof it !== 'object') return null;
        const o = it as Record<string, unknown>;
        return { action: typeof o.action === 'string' ? o.action : '', owner: typeof o.owner === 'string' ? o.owner : null, deadline: typeof o.deadline === 'string' ? o.deadline : null };
      }).filter((x): x is InsightJson['action_items'][number] => x !== null && x.action.length > 0)
    : [];
  return { summary: asStringArray(r.summary), action_items: actionItems, key_topics: asStringArray(r.key_topics), open_questions: asStringArray(r.open_questions), sentiment, energy_level: energy, language_detected: language };
}

async function loadSeen(bucket: string): Promise<Set<string>> {
  const { data, error } = await admin().from('gcs_synced_files').select('name').eq('bucket', bucket);
  if (error) throw new HttpError(500, `Supabase load failed: ${error.message}`);
  return new Set((data ?? []).map((r) => r.name as string));
}

async function processObject(bucket: string, obj: GcsObject, token: string, ownerUserId: string | null): Promise<string> {
  if (obj.size > WHISPER_MAX_BYTES) {
    throw new Error(`File ${obj.name} is ${(obj.size / 1024 / 1024).toFixed(1)} MB — exceeds Whisper 25 MB limit`);
  }
  const blob = await downloadObject(bucket, obj.name, token);
  const filename = baseName(obj.name);
  const transcript = await transcribeWhisper(blob, filename);
  let insights: InsightJson | null = null;
  if (transcript.text.length > 0) insights = await generateInsights(transcript.text);
  const { error } = await admin().from('gcs_synced_files').insert({
    bucket, name: obj.name, size_bytes: obj.size, content_type: obj.contentType,
    recorded_at: parseRfc3339(obj.timeCreated), transcript_text: transcript.text,
    language: transcript.language, duration_sec: transcript.duration,
    insights: insights ?? null, status: 'done', error_message: null, clerk_user_id: ownerUserId,
  });
  if (error) throw new HttpError(500, `Supabase insert failed: ${error.message}`);
  return `transcribed ${transcript.text.length} chars` + (insights ? ' + insights' : '');
}

async function markError(bucket: string, obj: GcsObject, message: string, ownerUserId: string | null): Promise<void> {
  await admin().from('gcs_synced_files').insert({
    bucket, name: obj.name, size_bytes: obj.size, content_type: obj.contentType,
    recorded_at: parseRfc3339(obj.timeCreated), transcript_text: null, language: null, duration_sec: null,
    insights: null, status: 'error', error_message: message.slice(0, 1000), clerk_user_id: ownerUserId,
  });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

function baseName(path: string): string {
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.slice(i + 1) : path;
}

function parseRfc3339(s: string): string | null {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

export default async function handler(req: any): Promise<Response> {
  try {
    if (req.method !== 'GET' && req.method !== 'POST') {
      return json(405, { error: 'GET/POST only' });
    }
    verifyCron(req);
    const bucket = (process.env.GCP_BUCKET ?? '').trim();
    const prefix = (process.env.GCP_BUCKET_PREFIX ?? '').trim();
    const ownerUserId = (process.env.GCS_OWNER_USER_ID ?? '').trim() || null;
    if (!bucket) return json(500, { error: 'GCP_BUCKET env var not set' });
    const token = await getAccessToken();
    const objects = await listObjects(bucket, token, prefix);
    const seen = await loadSeen(bucket);
    const fresh = objects
      .filter((o) => !seen.has(o.name))
      .sort((a, b) => (a.timeCreated > b.timeCreated ? 1 : -1))
      .slice(0, MAX_FILES_PER_RUN);
    const results: { name: string; status: 'done' | 'error'; message?: string }[] = [];
    for (const obj of fresh) {
      try {
        const result = await processObject(bucket, obj, token, ownerUserId);
        results.push({ name: obj.name, status: 'done', message: result });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await markError(bucket, obj, msg, ownerUserId);
        results.push({ name: obj.name, status: 'error', message: msg });
      }
    }
    return json(200, {
      bucket,
      total_in_bucket: objects.length,
      already_seen: seen.size,
      processed_this_run: results.length,
      remaining: Math.max(0, objects.length - seen.size - results.length),
      results,
    });
  } catch (err) {
    if (err instanceof HttpError) return json(err.status, { error: err.message });
    const msg = err instanceof Error ? err.message : 'Internal error';
    console.error('[gcs-sync] unhandled', err);
    return json(500, { error: msg });
  }
}
