/**
 * POST /api/transcribe — Whisper proxy.
 *
 * Accepts multipart/form-data with a single `file` field plus optional
 * `language` and `prompt`. Forwards to OpenAI using the server's
 * `OPENAI_API_KEY`. Checks the Clerk JWT and enforces per-user daily quota
 * before spending budget.
 *
 * Runs on Vercel's Edge runtime so multipart body streams straight through
 * without a Node buffer hop.
 */
import { errorResponse, HttpError, json, requireUser } from './_lib/auth';
import { checkQuota, incrementUsage } from './_lib/supabase';

export const config = { runtime: 'edge' };

const OPENAI_URL = 'https://api.openai.com/v1/audio/transcriptions';
const WHISPER_MAX_BYTES = 25 * 1024 * 1024; // Whisper rejects > 25 MB.

export default async function handler(req: Request): Promise<Response> {
  try {
    if (req.method !== 'POST') throw new HttpError(405, 'POST only');

    const { userId } = await requireUser(req);
    const quota = await checkQuota(userId);
    if (!quota.allowed) {
      return json(402, {
        error: 'Daily free-tier quota exceeded. Upgrade to Pro to continue.',
        usedSec: quota.usedSec,
        limitSec: quota.limitSec,
        plan: quota.plan,
      });
    }

    const form = await req.formData();
    const file = form.get('file');
    if (!(file instanceof Blob)) throw new HttpError(400, 'Missing audio file');
    if (file.size === 0) throw new HttpError(400, 'Empty audio file');
    if (file.size > WHISPER_MAX_BYTES) {
      throw new HttpError(413, `Audio chunk too large (${file.size} B). Max ${WHISPER_MAX_BYTES} B.`);
    }

    const language = typeof form.get('language') === 'string' ? (form.get('language') as string) : '';
    const prompt = typeof form.get('prompt') === 'string' ? (form.get('prompt') as string) : '';

    const upstream = new FormData();
    upstream.append('file', file, (file as File).name ?? 'chunk.webm');
    upstream.append('model', 'whisper-1');
    upstream.append('response_format', 'verbose_json');
    upstream.append('temperature', '0');
    if (language) upstream.append('language', language);
    if (prompt) upstream.append('prompt', prompt.slice(-900));

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new HttpError(500, 'OPENAI_API_KEY not configured');

    const res = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: upstream,
    });
    if (!res.ok) {
      const detail = await res.text();
      throw new HttpError(res.status, `Whisper: ${detail.slice(0, 400)}`);
    }
    const data = (await res.json()) as {
      text?: string;
      language?: string;
      duration?: number;
      segments?: Array<{ start: number; end: number; text: string }>;
    };

    // Meter usage. We await the RPC so the counter is never lost on Edge —
    // fire-and-forget here can be killed before the promise resolves, letting
    // users slip past the free-tier cap by spamming parallel chunks.
    const duration = Math.round(data.duration ?? 0);
    if (duration > 0) {
      try {
        await incrementUsage(userId, { transcribeSec: duration });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[transcribe] meter failed', (err as Error).message);
      }
    }

    return json(200, {
      text: data.text ?? '',
      language: data.language ?? language ?? null,
      duration: data.duration ?? null,
      segments: data.segments?.map((s) => ({ start: s.start, end: s.end, text: s.text })) ?? [],
      quota: { usedSec: quota.usedSec + duration, limitSec: quota.limitSec, plan: quota.plan },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
