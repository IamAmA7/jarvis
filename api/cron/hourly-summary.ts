/**
 * GET /api/cron/hourly-summary — Aggregates all cloud recordings from the
 * previous full hour and produces a single Russian rollup per user via Claude.
 *
 * Runs at :05 of each hour via Vercel cron. Reuses gcs_synced_files rows that
 * the 5-min sync has already populated with transcript_text + insights.
 *
 * Auth:
 *   - Vercel cron sends `x-vercel-cron: 1` header (trusted).
 *   - Manual triggers must include `Authorization: Bearer <CRON_SECRET>`.
 */
import { admin } from '../_lib/supabase.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const config = { maxDuration: 60 };

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

const SUMMARY_SYSTEM = `Ты — child-safety аналитик. Тебе дают набор записей за один час (примерно 5-минутные фрагменты с устройства ребёнка), каждая с готовым mini-инсайтом и текстом расшифровки.

Сформулируй ОДНУ цельную сводку часа на русском, 5-7 предложений. Включи:
1. Какая активность была у ребёнка в этот час (учёба, игра, разговор, прогулка, отдых).
2. Какое было общее настроение (спокойное, возбуждённое, грустное, радостное).
3. С кем взаимодействовал (родители, сверстники, учитель, один).
4. Значимые моменты — позитивные или негативные.
5. Если были маркеры \u26a0\ufe0f КРИТИЧНО или \u26a0\ufe0f ВНИМАНИЕ из mini-инсайтов — подчеркни их с указанием момента.
6. Завершающую фразу-вывод: общий тон часа.

Если содержательного материала мало (тишина, шум, обрывки) — напиши коротко: "Час прошёл тихо, значимой активности не зафиксировано."

Пиши прозой, без буллетов и заголовков. Без markdown.`;

interface SyncedRow {
  id: number;
  clerk_user_id: string;
  recorded_at: string | null;
  transcript_text: string | null;
  insights: { summary?: string[] } | null;
}

function hourStartUtc(d: Date): Date {
  const r = new Date(d);
  r.setUTCMinutes(0, 0, 0);
  return r;
}

async function summarizeHour(rows: SyncedRow[]): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY missing');

  const parts: string[] = [];
  rows.forEach((r, i) => {
    const lines: string[] = [`[Запись ${i + 1} @ ${r.recorded_at ?? '?'}]`];
    const mini = r.insights?.summary;
    if (mini && mini.length) lines.push(`mini-инсайт: ${mini.join(' ')}`);
    if (r.transcript_text) lines.push(`текст: ${r.transcript_text.slice(0, 3500)}`);
    parts.push(lines.join('\n'));
  });
  const userText = parts.join('\n\n---\n\n');

  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 800,
      temperature: 0.3,
      system: SUMMARY_SYSTEM,
      messages: [{ role: 'user', content: userText }],
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Claude ${res.status}: ${detail.slice(0, 400)}`);
  }
  const data = (await res.json()) as { content?: { text?: string }[] };
  const text = (data.content?.[0]?.text ?? '').trim();
  return text;
}

async function upsertSummary(row: {
  clerk_user_id: string;
  hour_start: string;
  summary_text: string | null;
  record_count: number;
  record_ids: number[];
  status: 'ok' | 'empty' | 'error';
  error_message: string | null;
}): Promise<void> {
  const { error } = await admin().from('hourly_summaries').upsert(
    { ...row, updated_at: new Date().toISOString() },
    { onConflict: 'clerk_user_id,hour_start' },
  );
  if (error) throw new Error(`upsert failed: ${error.message}`);
}

async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const auth = (req.headers['authorization'] ?? '') as string;
  const secret = process.env.CRON_SECRET;
  const isManual = !!secret && auth.startsWith('Bearer ') && auth.slice(7) === secret;
  if (!isVercelCron && !isManual) {
    res.statusCode = 401;
    res.end('Unauthorized');
    return;
  }

  try {
    const now = new Date();
    const currentHourStart = hourStartUtc(now);
    const prevHourStart = new Date(currentHourStart.getTime() - 60 * 60 * 1000);
    const hourIso = prevHourStart.toISOString();

    console.log(`[hourly-summary] window: ${hourIso} -> ${currentHourStart.toISOString()}`);

    const { data, error } = await admin()
      .from('gcs_synced_files')
      .select('id, clerk_user_id, recorded_at, transcript_text, insights')
      .gte('recorded_at', hourIso)
      .lt('recorded_at', currentHourStart.toISOString())
      .eq('status', 'done')
      .not('clerk_user_id', 'is', null);

    if (error) throw new Error(`load failed: ${error.message}`);
    const rows = (data ?? []) as SyncedRow[];

    const byUser = new Map<string, SyncedRow[]>();
    for (const r of rows) {
      if (!r.clerk_user_id) continue;
      const list = byUser.get(r.clerk_user_id) ?? [];
      list.push(r);
      byUser.set(r.clerk_user_id, list);
    }

    const results: { userId: string; status: string; records?: number; error?: string }[] = [];

    for (const [userId, userRows] of byUser) {
      try {
        const usable = userRows.filter(
          (r) => (r.transcript_text?.length ?? 0) > 30 || (r.insights?.summary?.length ?? 0) > 0,
        );
        if (usable.length === 0) {
          await upsertSummary({
            clerk_user_id: userId,
            hour_start: hourIso,
            summary_text: null,
            record_count: userRows.length,
            record_ids: userRows.map((r) => r.id),
            status: 'empty',
            error_message: null,
          });
          results.push({ userId, status: 'empty' });
          continue;
        }

        const summary = await summarizeHour(usable);
        await upsertSummary({
          clerk_user_id: userId,
          hour_start: hourIso,
          summary_text: summary,
          record_count: usable.length,
          record_ids: usable.map((r) => r.id),
          status: 'ok',
          error_message: null,
        });
        results.push({ userId, status: 'ok', records: usable.length });
        console.log(`[hourly-summary] ok: ${userId} (${usable.length} records)`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[hourly-summary] failed for ${userId}: ${msg}`);
        try {
          await upsertSummary({
            clerk_user_id: userId,
            hour_start: hourIso,
            summary_text: null,
            record_count: userRows.length,
            record_ids: userRows.map((r) => r.id),
            status: 'error',
            error_message: msg.slice(0, 1000),
          });
        } catch {
          /* swallow secondary error */
        }
        results.push({ userId, status: 'error', error: msg.slice(0, 200) });
      }
    }

    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        hour_start: hourIso,
        users_processed: results.length,
        results,
      }),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[hourly-summary] FATAL: ${msg}`);
    res.statusCode = 500;
    res.end(`Error: ${msg}`);
  }
}

export default handler;
