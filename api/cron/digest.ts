/**
 * GET /api/cron/digest — daily yellow-tier digest.
 *
 * Scheduled by vercel.json cron. Vercel sends a header
 *   `Authorization: Bearer <CRON_SECRET>` — we verify against CRON_SECRET
 * (falls back to the Vercel-injected x-vercel-cron header).
 *
 * For each user with at least one verified telegram subscription:
 *   - Collect yellow alerts in the last 24h
 *   - Format a single digest message
 *   - Send to each verified chat whose `severities` includes 'yellow'
 *
 * Runs on Node runtime because Supabase + multiple Telegram sends per user
 * is easier without the Edge streaming model and this is a ~once-a-day job.
 */
import { errorResponse, HttpError, json } from '../_lib/auth';
import { admin } from '../_lib/supabase';
import { formatDigest, sendMessage } from '../_lib/telegram';

export const config = { runtime: 'nodejs20.x' };

export default async function handler(req: Request): Promise<Response> {
  try {
    if (req.method !== 'GET' && req.method !== 'POST') throw new HttpError(405, 'GET/POST only');
    verifyCron(req);

    const now = new Date();
    const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const dashboardBase = process.env.APP_URL ?? 'https://jarvis.example.com';

    // Group alerts by user in one query. We only need yellow severity here.
    const { data: alerts, error } = await admin()
      .from('alerts')
      .select('id, clerk_user_id, category, summary, window_start')
      .eq('severity', 'yellow')
      .gte('window_start', since.toISOString())
      .order('window_start', { ascending: true });
    if (error) throw new HttpError(500, error.message);

    const byUser = new Map<
      string,
      Array<{ id: string; category: string; summary: string; time: Date }>
    >();
    for (const a of alerts ?? []) {
      const list = byUser.get(a.clerk_user_id) ?? [];
      list.push({
        id: a.id,
        category: a.category,
        summary: a.summary,
        time: new Date(a.window_start),
      });
      byUser.set(a.clerk_user_id, list);
    }

    // Users with at least one verified subscription AND yellow enabled.
    const { data: subs } = await admin()
      .from('telegram_subscriptions')
      .select('clerk_user_id, chat_id, severities, verified_at')
      .not('verified_at', 'is', null);

    // We also need child_name per user for friendlier copy.
    const { data: configs } = await admin()
      .from('alert_config')
      .select('clerk_user_id, child_name');
    const childName = new Map<string, string | null>();
    for (const c of configs ?? []) childName.set(c.clerk_user_id, c.child_name ?? null);

    const sendsByUser = new Map<string, string[]>();
    for (const s of subs ?? []) {
      const wantsYellow =
        Array.isArray(s.severities) && (s.severities as string[]).includes('yellow');
      if (!wantsYellow) continue;
      const list = sendsByUser.get(s.clerk_user_id) ?? [];
      list.push(s.chat_id as string);
      sendsByUser.set(s.clerk_user_id, list);
    }

    let messagesSent = 0;
    const results: Array<{ user: string; chats: number; entries: number }> = [];

    for (const [userId, chats] of sendsByUser) {
      const entries = byUser.get(userId) ?? [];
      const text = formatDigest({
        when: now,
        childName: childName.get(userId) ?? null,
        entries,
        dashboardUrl: `${dashboardBase.replace(/\/$/, '')}/dashboard`,
      });
      for (const chat of chats) {
        try {
          await sendMessage({ chatId: chat, text, quiet: entries.length === 0 });
          messagesSent += 1;
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('[digest] send failed', (err as Error).message);
        }
      }
      results.push({ user: userId, chats: chats.length, entries: entries.length });
    }

    return json(200, { ok: true, messagesSent, users: results.length, detail: results });
  } catch (err) {
    return errorResponse(err);
  }
}

function verifyCron(req: Request): void {
  // Vercel's cron invoker sends one of these — either the standard
  // `authorization: Bearer <CRON_SECRET>` or the newer `x-vercel-cron: 1`.
  const secret = process.env.CRON_SECRET;
  const header = req.headers.get('authorization') ?? '';
  const isVercelCron = req.headers.get('x-vercel-cron') === '1';
  if (secret) {
    if (header === `Bearer ${secret}`) return;
  }
  if (isVercelCron) return;
  throw new HttpError(401, 'cron auth failed');
}
