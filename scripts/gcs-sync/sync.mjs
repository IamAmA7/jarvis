#!/usr/bin/env node
/**
 * Standalone GCS audio sync.
 *
 * Pulls audio recordings from a Google Cloud Storage bucket, transcribes them
 * with OpenAI Whisper, generates structured insights with Anthropic Claude,
 * and persists the result into the Supabase `gcs_synced_files` table.
 *
 * Designed to run from a GitHub Actions cron (every 5 minutes). Each run is
 * bounded by MAX_FILES_PER_RUN to keep the job short and predictable.
 *
 * Required env vars:
 *   GCP_SERVICE_ACCOUNT_JSON   - full service account JSON (from gcp console)
 *   GCP_BUCKET                 - bucket name, e.g. aa_audio_2026
 *   SUPABASE_URL               - https://<project>.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY  - service-role key (bypasses RLS)
 *   OPENAI_API_KEY             - OpenAI key for Whisper
 *
 * Optional:
 *   GCP_BUCKET_PREFIX     - only objects whose name starts with this prefix
 *   GCS_OWNER_USER_ID     - clerk_user_id assigned to inserted rows
 *   ANTHROPIC_API_KEY     - if set, generate insights via Claude
 */
import { SignJWT, importPKCS8 } from 'jose';
import { createClient } from '@supabase/supabase-js';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GCS_READ_SCOPE = 'https://www.googleapis.com/auth/devstorage.read_only';
const STORAGE_BASE = 'https://storage.googleapis.com/storage/v1';
const OPENAI_TRANSCRIBE_URL = 'https://api.openai.com/v1/audio/transcriptions';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const MAX_FILES_PER_RUN = 20
const WHISPER_MAX_BYTES = 25 * 1024 * 1024;

function envRequired(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`[gcs-sync] missing required env: ${name}`);
    process.exit(1);
  }
  return v;
}

async function getAccessToken() {
  const sa = JSON.parse(envRequired('GCP_SERVICE_ACCOUNT_JSON'));
  if (!sa.client_email || !sa.private_key) {
    throw new Error('service account JSON missing client_email/private_key');
  }
  const issuedAt = Math.floor(Date.now() / 1000);
  const tokenUri = sa.token_uri || GOOGLE_TOKEN_URL;
  const pem = sa.private_key.replace(/\\n/g, '\n');
  const key = await importPKCS8(pem, 'RS256');
  const assertion = await new SignJWT({ scope: GCS_READ_SCOPE })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuer(sa.client_email)
    .setSubject(sa.client_email)
    .setAudience(tokenUri)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + 3600)
    .sign(key);
  const res = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`token exchange failed: ${res.status} ${detail.slice(0, 400)}`);
  }
  const data = await res.json();
  if (!data.access_token) throw new Error('Google did not return access_token');
  return data.access_token;
}

async function listObjects(bucket, token, prefix) {
  const out = [];
  let pageToken;
  do {
    const url = new URL(`${STORAGE_BASE}/b/${encodeURIComponent(bucket)}/o`);
    url.searchParams.set('maxResults', '1000');
    url.searchParams.set('fields', 'items(name,size,contentType,timeCreated,updated),nextPageToken');
    if (prefix) url.searchParams.set('prefix', prefix);
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`GCS list failed: ${res.status} ${detail.slice(0, 400)}`);
    }
    const data = await res.json();
    for (const it of data.items ?? []) {
      out.push({
        name: it.name,
        size: Number(it.size ?? 0),
        contentType: it.contentType ?? 'application/octet-stream',
        timeCreated: it.timeCreated ?? '',
      });
    }
    pageToken = data.nextPageToken;
  } while (pageToken);
  return out;
}

async function downloadObject(bucket, name, token) {
  const url = `${STORAGE_BASE}/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(name)}?alt=media`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`GCS download failed: ${res.status} ${detail.slice(0, 400)}`);
  }
  return res.blob();
}

async function transcribeWhisper(file, filename) {
  const apiKey = envRequired('OPENAI_API_KEY');
  const form = new FormData();
  form.append('file', file, filename);
  form.append('model', 'gpt-4o-transcribe');
  form.append('response_format', 'json');
  form.append('language', 'ru');
  const res = await fetch(OPENAI_TRANSCRIBE_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Whisper failed: ${res.status} ${detail.slice(0, 400)}`);
  }
  return res.json();
}

const INSIGHTS_SYSTEM = `You are Jarvis, a child-safety audio-monitoring assistant. The microphone runs near a child throughout the day; you read raw transcripts (likely a mix of Russian, Ukrainian, and English) plus contextual cues to detect threats to the child's safety while respecting privacy.

ROLE & GOALS:
- Continuously analyze the child's auditory environment.
- Distinguish near voices (people directly interacting with the child) from distant ambient speech.
- Recognize emotion / intonation: fear, crying, aggression, joy, calm, anxiety, raised voice, threats, humiliation, mockery.
- Use context to avoid false positives: play != real conflict, joke != bullying, movie / cartoon dialogue != real speech.

TRIGGER LEVELS:
- CRITICAL — physical violence, cries of pain, suspicious adult contact (lure attempts, requests for secrecy, inappropriate offers), acute panic / fear in the child, self-harm references, sexually-charged speech directed at the child.
- HIGH — systematic peer bullying (insults, threats, isolation, mockery), verbal aggression toward the child, prolonged crying (>2 min) without adult response, signs of social isolation.
- MEDIUM — conflicts that resolve, episodes of sadness / anxiety, the child complaining about feelings or situations.
- NONE — ordinary play, learning, casual chat, ambient activity.

ANTI-FALSE-POSITIVE CHECKS (apply BEFORE escalating):
- Duration of the incident.
- The child's reaction.
- Context (movie, game, role-play).
- Whether the pattern repeats.

PRIVACY:
- Do NOT include verbatim quotes of conversations between other children / adults unless required to evidence a trigger.
- Do NOT analyze conversations of bystanders outside the child's interaction zone.
- Treat normal teen chat about personal matters as private unless danger signs appear.

ETHICS:
- The system protects the child, it doesn't surveil them. Don't flag normal behavior.

HARD OUTPUT RULES:
- Respond with a single JSON object. No prose before or after. No markdown fences.
- Never invent facts. If a field has no content, use [] or null per the schema below.
- Output text in summary, action_items, open_questions should match the dominant language of the transcript.

JSON SCHEMA — these EXACT field names and types are required by the UI. Do not rename, omit, or add fields:
{
  "summary": string[],
  "action_items": [{ "action": string, "owner": string|null, "deadline": string|null }],
  "key_topics": string[],
  "open_questions": string[],
  "sentiment": "positive" | "neutral" | "tense",
  "energy_level": 1|2|3|4|5,
  "language_detected": "ru" | "en" | "uk" | "mixed"
}

FIELD-LEVEL INSTRUCTIONS:

summary — array of 2-5 short bullets describing what happened during the period.
- If the trigger level is CRITICAL, the FIRST bullet MUST start with the marker "⚠️ КРИТИЧНО: " and state the specific safety concern in one sentence.
- If the trigger level is HIGH, the FIRST bullet MUST start with "⚠️ ВНИМАНИЕ: ".
- If the level is MEDIUM or NONE, no marker — describe normally.
- Do not include verbatim quotes of unrelated bystander speech.

action_items — ordered by priority. Each item:
- action: short imperative for the parent.
- owner: usually null (the parent is implicit).
- deadline: encode urgency as one of "СРОЧНО" (CRITICAL — immediate), "Сегодня" (HIGH — same-day follow-up), "На неделе" (MEDIUM follow-up), or null if not time-bound.
- Empty array if no action is required.

key_topics — short tag-like topics (1-3 words) for fast navigation.

open_questions — things you couldn't resolve and which need parent input. Empty array if none.

sentiment — overall emotional state of the child. Map finer judgment to the three allowed values:
- "tense" — concerning, negative, scared, distressed, or any HIGH / CRITICAL trigger present.
- "neutral" — mixed, calm-but-mildly-anxious, ambient, sleeping, or no clear emotional valence.
- "positive" — happy play, friendly interaction, content / relaxed.

energy_level — integer 1-5:
- 1 — very low / withdrawn / sleeping.
- 2 — low / calm.
- 3 — normal / steady.
- 4 — elevated / lively.
- 5 — high / very active OR distressed (panic, prolonged crying, acute fear). When 5 is due to distress, the marker in summary plus sentiment 'tense' must convey the difference.

language_detected — one of "ru", "en", "uk", or "mixed" if no clear majority.

WHEN THERE IS NO ACTIVITY (silence, child sleeping):
- summary: ["Тихий период, активности не зафиксировано."]
- action_items: []
- key_topics: []
- open_questions: []
- sentiment: "neutral"
- energy_level: 1
- language_detected: dominant of any speech, or "ru" by default.`;

async function generateInsights(transcript) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    },
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
    throw new Error(`Claude failed: ${res.status} ${detail.slice(0, 400)}`);
  }
  const data = await res.json();
  const text = (data.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('')
    .trim();
  return parseInsightJson(text);
}

function parseInsightJson(text) {
  const tryParse = (s) => {
    try { return JSON.parse(s); } catch { return null; }
  };
  let raw = tryParse(text);
  if (!raw) {
    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    if (first >= 0 && last > first) raw = tryParse(text.slice(first, last + 1));
  }
  if (!raw || typeof raw !== 'object') return null;
  return raw;
}

function makeSupabase() {
  return createClient(
    envRequired('SUPABASE_URL'),
    envRequired('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

function rfc3339ToIso(s) {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

function baseName(path) {
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.slice(i + 1) : path;
}

async function main() {
  const bucket = envRequired('GCP_BUCKET');
  const prefix = process.env.GCP_BUCKET_PREFIX ?? '';
  const ownerUserId = (process.env.GCS_OWNER_USER_ID ?? '').trim() || null;

  console.log(`[gcs-sync] start bucket=${bucket} prefix='${prefix}' maxPerRun=${MAX_FILES_PER_RUN}`);

  const supabase = makeSupabase();
  const { data: seenRows, error: seenError } = await supabase
    .from('gcs_synced_files')
    .select('name')
    .eq('bucket', bucket);
  if (seenError) throw new Error(`Supabase load seen failed: ${seenError.message}`);
  const seen = new Set((seenRows ?? []).map((r) => r.name));
  console.log(`[gcs-sync] already-seen=${seen.size}`);

  const token = await getAccessToken();
  console.log(`[gcs-sync] got Google access token`);

  const objects = await listObjects(bucket, token, prefix);
  console.log(`[gcs-sync] objects-in-bucket=${objects.length}`);

  const fresh = objects
    .filter((o) => !seen.has(o.name))
    .sort((a, b) => (a.timeCreated > b.timeCreated ? 1 : -1))
    .slice(0, MAX_FILES_PER_RUN);
  console.log(`[gcs-sync] fresh-this-run=${fresh.length}`);

  let done = 0;
  let errors = 0;

  for (const obj of fresh) {
    console.log(`[gcs-sync] -> ${obj.name} (${(obj.size / 1024 / 1024).toFixed(2)} MB)`);
    try {
      if (obj.size > WHISPER_MAX_BYTES) {
        throw new Error(`file is ${(obj.size / 1024 / 1024).toFixed(1)} MB - exceeds Whisper 25 MB limit`);
      }
      const blob = await downloadObject(bucket, obj.name, token);
      const filename = baseName(obj.name);
      const file = new File([blob], filename, {
        type: obj.contentType || blob.type || 'audio/wav',
      });

      const transcript = await transcribeWhisper(file, filename);
      const text = (transcript.text ?? '').trim();
      console.log(`[gcs-sync]    transcribed: ${text.length} chars, lang=${transcript.language ?? '?'}, dur=${transcript.duration ?? '?'}s`);

      const _hWords = text.split(' ').filter(Boolean);
      const _hUnique = new Set(_hWords.map((w) => w.toLowerCase())).size;
      if (_hWords.length > 20 && _hUnique / _hWords.length < 0.15) {
        console.warn('[gcs-sync]    possible repetition: ' + _hUnique + ' unique / ' + _hWords.length + ' total — keeping transcript');
      }
      let insights = null;
      if (text.length > 0) {
        try {
          insights = await generateInsights(text);
          console.log(`[gcs-sync]    insights: ${insights ? 'ok' : 'null'}`);
        } catch (err) {
          console.error(`[gcs-sync]    insights failed: ${err.message}`);
        }
      }

      const { error: insertErr } = await supabase.from('gcs_synced_files').insert({
        bucket,
        name: obj.name,
        size_bytes: obj.size,
        content_type: obj.contentType,
        recorded_at: rfc3339ToIso(obj.timeCreated),
        transcript_text: text,
        language: transcript.language ?? null,
        duration_sec: transcript.duration ?? null,
        insights: insights ?? null,
        status: 'done',
        error_message: null,
        clerk_user_id: ownerUserId,
      });
      if (insertErr) throw new Error(`Supabase insert failed: ${insertErr.message}`);
      done += 1;
      console.log(`[gcs-sync]    saved ${obj.name}`);
    } catch (err) {
      errors += 1;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[gcs-sync]    ERROR: ${msg}`);
      try {
        await supabase.from('gcs_synced_files').insert({
          bucket,
          name: obj.name,
          size_bytes: obj.size,
          content_type: obj.contentType,
          recorded_at: rfc3339ToIso(obj.timeCreated),
          transcript_text: null,
          language: null,
          duration_sec: null,
          insights: null,
          status: 'error',
          error_message: msg.slice(0, 1000),
          clerk_user_id: ownerUserId,
        });
      } catch (markErr) {
        console.error(`[gcs-sync]    failed to record error row: ${markErr.message}`);
      }
    }
  }

  console.log(`[gcs-sync] done. processed=${done} errors=${errors} remaining=${Math.max(0, objects.length - seen.size - fresh.length)}`);
}

main().catch((err) => {
  console.error(`[gcs-sync] FATAL: ${err.stack || err.message}`);
  process.exit(1);
});
