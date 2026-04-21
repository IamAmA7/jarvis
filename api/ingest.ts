/**
 * POST /api/ingest — device audio ingestion.
 *
 * Accepts multipart/form-data from a Jarvis listener device (ESP32 firmware
 * or phone/watch app). Runs the full pipeline synchronously:
 *
 *   1. Verify device token (HMAC in Authorization header)
 *   2. Persist raw audio to Supabase Storage (audio/<user>/<device>/...)
 *   3. Row in public.chunks, status=pending
 *   4. Claim the row (atomic) and call Whisper
 *   5. Write public.transcripts, flip chunk status=done
 *   6. Classify the last N minutes of transcript with Claude
 *   7. If severity=red, push Telegram notifications to user's verified chats
 *
 * Runs on the Node runtime (not Edge) because:
 *   - Multipart uploads with Supabase Storage are more robust with native fetch
 *     buffering than the stream-through Edge path, and audio chunks are small.
 *   - We want to do several awaits (storage + Whisper + Claude + Telegram)
 *     inside one request; Node gives us a longer soft budget.
 *
 * Multipart fields:
 *   file           — required, audio blob (webm/ogg/wav/mp3/m4a), <= 25 MB
 *   recorded_at    — required, ISO8601 string (device wall clock)
 *   duration_sec   — optional, numeric
 *   vad_score      — optional, 0..1
 *   battery_pct    — optional, 0..100
 *   wifi_rssi      — optional, integer dBm
 *   firmware       — optional, semver-ish string
 *   language       — optional, Whisper language hint
 *
 * Response: { chunk_id, transcript, alert? } — the device can log or ignore.
 */
import { errorResponse, HttpError, json } from './_lib/auth';
import { requireDevice, touchDevice } from './_lib/device-auth';
import { admin } from './_lib/supabase';
import { extFromMime, putChunk, storageKey } from './_lib/storage';
import { transcribe as whisperTranscribe } from './_lib/whisper';
import { classifyTranscriptWindow } from './_lib/alerts';
import { formatRedAlert, sendMessage } from './_lib/telegram';

export const config = { runtime: 'nodejs20.x' };

// How far back the classifier looks when a new chunk arrives. 3 minutes is
// short enough to catch an escalating situation in time and long enough to
// carry context across silent gaps.
const CLASSIFIER_WINDOW_MS = 3 * 60 * 1000;

export default async function handler(req: Request): Promise<Response> {
  try {
    if (req.method !== 'POST') throw new HttpError(405, 'POST only');
    const device = await requireDevice(req);

    const form = await req.formData();
    const file = form.get('file');
    if (!(file instanceof Blob)) throw new HttpError(400, 'Missing audio file');
    if (file.size === 0) throw new HttpError(400, 'Empty audio file');

    const recordedAt = parseDate(form.get('recorded_at'));
    if (!recordedAt) throw new HttpError(400, 'recorded_at (ISO8601) is required');

    const durationFromForm = parseNum(form.get('duration_sec'));
    const vadScore = parseNum(form.get('vad_score'));
    const battery = parseNum(form.get('battery_pct'));
    const wifi = parseNum(form.get('wifi_rssi'));
    const firmware = (form.get('firmware') as string | null) ?? null;
    const languageHintIn = (form.get('language') as string | null) ?? null;

    const mime = (file.type || 'audio/webm').toLowerCase();
    const ext = extFromMime(mime);

    // Create chunk row first so we have an id for the storage path.
    const chunkId = crypto.randomUUID();
    const key = storageKey(device.userId, device.deviceId, chunkId, recordedAt, ext);

    // Stream bytes into Storage before we touch the DB — if upload fails we
    // don't want orphan DB rows.
    const bytes = await file.arrayBuffer();
    await putChunk(key, bytes, mime);

    const { error: insertErr } = await admin().from('chunks').insert({
      id: chunkId,
      device_id: device.deviceId,
      clerk_user_id: device.userId,
      recorded_at: recordedAt.toISOString(),
      duration_sec: durationFromForm ?? 0,
      bytes: file.size,
      storage_path: key,
      mime_type: mime,
      vad_score: vadScore,
      transcription_status: 'pending',
    });
    if (insertErr) throw new HttpError(500, `chunks insert: ${insertErr.message}`);

    // Non-blocking device telemetry refresh. We don't fail the request on
    // this — the audio is already safe in storage.
    await touchDevice(device.deviceId, {
      battery,
      wifi,
      firmware,
      ip: req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    });

    // Claim the chunk so a retry or parallel worker can't double-bill Whisper.
    const { data: claimed, error: claimErr } = await admin().rpc(
      'claim_chunk_for_transcription',
      { p_chunk: chunkId },
    );
    if (claimErr) throw new HttpError(500, `claim: ${claimErr.message}`);
    if (!claimed) {
      return json(202, { chunk_id: chunkId, status: 'duplicate_claim' });
    }

    // Whisper.
    let whisper;
    try {
      whisper = await whisperTranscribe(file, {
        filename: `chunk-${chunkId}.${ext}`,
        language: languageHintIn ?? undefined,
      });
    } catch (err) {
      await admin()
        .from('chunks')
        .update({
          transcription_status: 'failed',
          transcription_error: (err as Error).message.slice(0, 500),
        })
        .eq('id', chunkId);
      throw err;
    }

    const durationSec = whisper.duration ?? durationFromForm ?? 0;

    // Persist transcript and flip the chunk. Two writes in sequence — both
    // idempotent enough that a retry after timeout is safe.
    const { data: transcriptRow, error: transErr } = await admin()
      .from('transcripts')
      .insert({
        chunk_id: chunkId,
        clerk_user_id: device.userId,
        device_id: device.deviceId,
        recorded_at: recordedAt.toISOString(),
        text: whisper.text,
        language: whisper.language,
        duration_sec: durationSec,
        words: whisper.words.length ? whisper.words : null,
        model: 'whisper-1',
      })
      .select('id')
      .single();
    if (transErr) throw new HttpError(500, `transcripts insert: ${transErr.message}`);

    await admin()
      .from('chunks')
      .update({
        transcription_status: whisper.text ? 'done' : 'skipped',
        transcribed_at: new Date().toISOString(),
        duration_sec: durationSec,
      })
      .eq('id', chunkId);

    // If Whisper returned no speech, we can skip classification entirely.
    if (!whisper.text) {
      return json(200, {
        chunk_id: chunkId,
        transcript_id: transcriptRow.id,
        text: '',
      });
    }

    // Classify a rolling window that includes THIS chunk plus the last few
    // minutes — gives Claude context for escalations that span chunks.
    const windowEnd = recordedAt;
    const windowStart = new Date(windowEnd.getTime() - CLASSIFIER_WINDOW_MS);

    const [configRow, windowRows] = await Promise.all([
      admin()
        .from('alert_config')
        .select('red_categories, yellow_categories, child_name, child_age, language_hint')
        .eq('clerk_user_id', device.userId)
        .maybeSingle(),
      admin().rpc('transcript_window', {
        p_user: device.userId,
        p_device: device.deviceId,
        p_from: windowStart.toISOString(),
        p_to: new Date(windowEnd.getTime() + 1).toISOString(),
      }),
    ]);

    const cfg = configRow.data ?? {
      red_categories: [
        'aggression',
        'physical_violence',
        'threats',
        'screaming',
        'panic',
        'weapons',
        'drugs',
        'sexual_content',
        'suicide_mention',
        'fall_or_pain',
      ],
      yellow_categories: [
        'isolation',
        'sadness',
        'recurring_conflict',
        'negative_peer_dynamic',
        'bullying_signals',
      ],
      child_name: null,
      child_age: null,
      language_hint: 'auto',
    };

    const windowTexts =
      (windowRows.data as Array<{ text: string; recorded_at: string; transcript_id: string; chunk_id: string }> | null) ??
      [];
    const joined = windowTexts.map((r) => r.text).join('\n').trim() || whisper.text;
    const refs = windowTexts.map((r) => r.transcript_id);

    const classification = await classifyTranscriptWindow({
      text: joined,
      windowStart,
      windowEnd,
      childName: cfg.child_name,
      childAge: cfg.child_age,
      redCategories: cfg.red_categories,
      yellowCategories: cfg.yellow_categories,
      languageHint: cfg.language_hint,
    });

    // Persist every classification, including green — useful for dashboards
    // and model QA. Downstream filters by severity.
    const { data: alertRow, error: alertErr } = await admin()
      .from('alerts')
      .insert({
        clerk_user_id: device.userId,
        device_id: device.deviceId,
        window_start: windowStart.toISOString(),
        window_end: windowEnd.toISOString(),
        severity: classification.severity,
        category: classification.category,
        summary: classification.summary,
        evidence: classification.evidence,
        confidence: classification.confidence,
        transcript_refs: refs.length ? refs : [transcriptRow.id],
      })
      .select('id')
      .single();
    if (alertErr) throw new HttpError(500, `alerts insert: ${alertErr.message}`);

    // Fire Telegram immediately for red. Yellow goes through the daily cron.
    if (classification.severity === 'red') {
      await fireRedTelegram({
        userId: device.userId,
        alertId: alertRow.id,
        classification,
        windowStart,
        childName: cfg.child_name,
      });
    }

    return json(200, {
      chunk_id: chunkId,
      transcript_id: transcriptRow.id,
      text: whisper.text,
      alert: {
        id: alertRow.id,
        severity: classification.severity,
        category: classification.category,
        summary: classification.summary,
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}

async function fireRedTelegram(opts: {
  userId: string;
  alertId: string;
  classification: {
    severity: 'red' | 'yellow' | 'green';
    category: string;
    summary: string;
    evidence: string | null;
    confidence: number;
  };
  windowStart: Date;
  childName: string | null;
}): Promise<void> {
  const { data: subs } = await admin()
    .from('telegram_subscriptions')
    .select('chat_id, severities, verified_at')
    .eq('clerk_user_id', opts.userId)
    .not('verified_at', 'is', null);
  if (!subs || subs.length === 0) return;

  const dashboardBase = process.env.APP_URL ?? 'https://jarvis.example.com';
  const dashboardUrl = `${dashboardBase.replace(/\/$/, '')}/alerts/${opts.alertId}`;

  const text = formatRedAlert({
    category: opts.classification.category,
    summary: opts.classification.summary,
    evidence: opts.classification.evidence,
    confidence: opts.classification.confidence,
    windowStart: opts.windowStart,
    childName: opts.childName,
    dashboardUrl,
  });

  const sends = subs
    .filter((s) => (s.severities as string[] | null)?.includes('red') ?? true)
    .map(async (s) => {
      try {
        await sendMessage({ chatId: s.chat_id as string, text });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[ingest] telegram send failed', (err as Error).message);
      }
    });
  await Promise.all(sends);

  await admin()
    .from('alerts')
    .update({ notified_at: new Date().toISOString() })
    .eq('id', opts.alertId);
}

function parseDate(v: FormDataEntryValue | null): Date | null {
  if (typeof v !== 'string' || !v) return null;
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d : null;
}

function parseNum(v: FormDataEntryValue | null): number | null {
  if (typeof v !== 'string' || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
