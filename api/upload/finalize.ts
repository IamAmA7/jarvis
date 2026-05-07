/**
 * POST /api/upload/finalize — process a manually uploaded file.
 *
 * After the browser PUTs the file to Supabase Storage via /api/upload/init's
 * signed URL, it calls this endpoint to:
 *   1. Download the file server-side from Supabase Storage
 *   2. Send to OpenAI Whisper for transcription
 *   3. Send transcript to Claude for structured insights
 *   4. Insert into `gcs_synced_files` with `bucket = 'manual'` so it shows
 *      up in История alongside cloud recordings, but tagged as a manual upload.
 *
 * No interaction with GCS — the cloud sync (Raspberry Pi → GCS bucket → cron)
 * is a separate pipeline and is unaffected.
 */
import { errorResponse, HttpError, json, requireUser } from '../_lib/auth';
import { admin } from '../_lib/supabase';

export const config = { runtime: 'nodejs', maxDuration: 300 };
const BUCKET = 'manual-uploads';

interface FinalizeBody {
  path: string;
  filename: string;
  contentType?: string;
  size?: number;
}

interface ClaudeInsights {
  summary: string[];
  action_items: { action: string; owner?: string | null; deadline?: string | null }[];
  key_topics: string[];
  open_questions: string[];
}

const INSIGHTS_PROMPT = `You analyze meeting/voice-memo transcripts and extract structured insights.

Return ONLY a single JSON object with this exact shape (no markdown, no commentary):
{
  "summary": ["3-7 short bullet points (≤2 sentences each) capturing what was discussed"],
  "action_items": [{"action": "...", "owner": "name or null", "deadline": "YYYY-MM-DD / relative phrase / null"}],
  "key_topics": ["short tag-like topics, 1-3 words each"],
  "open_questions": ["unanswered questions raised"]
}

If a section has no items, return an empty array. Use the same language as the transcript.`;

async function transcribeWhisper(blob: Blob, filename: string): Promise<{ text: string; language: string | null; duration: number | null }> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new HttpError(500, 'OPENAI_API_KEY env var is missing');

  const form = new FormData();
  form.append('file', blob, filename);
  form.append('model', 'whisper-1');
  form.append('response_format', 'verbose_json');

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 400);
    throw new HttpError(502, `Whisper failed: ${res.status} ${detail}`);
  }
  const data = (await res.json()) as { text?: string; language?: string; duration?: number };
  return {
    text: data.text ?? '',
    language: data.language ?? null,
    duration: typeof data.duration === 'number' ? data.duration : null,
  };
}

async function generateInsights(transcript: string): Promise<ClaudeInsights | null> {
  if (!transcript.trim()) return null;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // eslint-disable-next-line no-console
    console.warn('[finalize] ANTHROPIC_API_KEY missing — skipping insights');
    return null;
  }

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 2000,
      system: INSIGHTS_PROMPT,
      messages: [
        { role: 'user', content: `Transcript:\n\n${transcript.slice(0, 50000)}\n\nReturn the JSON now.` },
      ],
    }),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    // eslint-disable-next-line no-console
    console.warn('[finalize] Claude failed', res.status, detail);
    return null;
  }
  const data = (await res.json()) as { content?: { type: string; text?: string }[] };
  const text = data.content?.find((c) => c.type === 'text')?.text ?? '';
  try {
    const jsonStr = text.replace(/^\s*```json\s*/i, '').replace(/\s*```\s*$/, '').trim();
    return JSON.parse(jsonStr) as ClaudeInsights;
  } catch {
    // eslint-disable-next-line no-console
    console.warn('[finalize] failed to parse Claude JSON', text.slice(0, 200));
    return null;
  }
}

export default async function handler(req: Request): Promise<Response> {
  try {
    const { userId } = await requireUser(req);
    if (req.method !== 'POST') throw new HttpError(405, 'POST only');

    const body = (await req.json().catch(() => null)) as FinalizeBody | null;
    if (!body || !body.path || !body.filename) {
      throw new HttpError(400, 'path and filename required');
    }

    // Path safety: must start with the calling user's prefix.
    const userPrefix = userId.replace(/[^A-Za-z0-9]/g, '');
    if (!body.path.startsWith(`${userPrefix}/`)) {
      throw new HttpError(403, 'Path does not belong to you');
    }

    const supa = admin();

    // 1. Download from Supabase Storage.
    const { data: blob, error: dlErr } = await supa.storage.from(BUCKET).download(body.path);
    if (dlErr || !blob) {
      throw new HttpError(500, `Storage download failed: ${dlErr?.message ?? 'no blob'}`);
    }

    // 2. Transcribe.
    const transcribed = await transcribeWhisper(blob, body.filename);

    // 3. Insights (best-effort).
    const insights = await generateInsights(transcribed.text);

    // 4. Save metadata. Reuse `gcs_synced_files` table with `bucket='manual'`
    //    so the file shows up in История through the existing /api/cloud listing.
    const now = new Date().toISOString();
    const insertRow = {
      bucket: 'manual',
      name: body.path,
      clerk_user_id: userId,
      size_bytes: body.size ?? null,
      content_type: body.contentType ?? null,
      recorded_at: now,
      transcript_text: transcribed.text,
      language: transcribed.language,
      duration_sec: transcribed.duration,
      insights: insights as unknown as Record<string, unknown> | null,
      status: 'done' as const,
      error_message: null,
      processed_at: now,
    };
    const { data: inserted, error: insertErr } = await supa
      .from('gcs_synced_files')
      .insert(insertRow)
      .select('id')
      .single();
    if (insertErr) {
      throw new HttpError(500, `DB insert failed: ${insertErr.message}`);
    }

    return json(200, {
      id: inserted.id,
      transcript: transcribed.text,
      language: transcribed.language,
      duration: transcribed.duration,
      insights,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
