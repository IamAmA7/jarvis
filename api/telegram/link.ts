/**
 * POST /api/telegram/link — issue a one-time link code for bot binding.
 *
 * The web UI calls this to get a code like "JV-ABCD-1234" plus a
 * `https://t.me/<bot>?start=<code>` URL. The user clicks the URL (or types
 * `/start <code>` in the bot) — `api/telegram/webhook.ts` then upserts a
 * telegram_subscriptions row with `verified_at = now()`.
 */
import { errorResponse, HttpError, json, requireUser } from '../_lib/auth';
import { admin } from '../_lib/supabase';

export const config = { runtime: 'edge' };

const LINK_TTL_MIN = 30;

export default async function handler(req: Request): Promise<Response> {
  try {
    if (req.method !== 'POST') throw new HttpError(405, 'POST only');
    const { userId } = await requireUser(req);
    const body = (await req.json().catch(() => ({}))) as { label?: string };
    const label = (body.label ?? 'Personal').trim().slice(0, 40);

    const code = makeLinkCode();
    const expires = new Date(Date.now() + LINK_TTL_MIN * 60_000).toISOString();

    // We create a placeholder row with chat_id = 'pending:<code>' so the
    // `unique(user,chat_id)` constraint is satisfied. The webhook overwrites
    // chat_id with the real numeric id when the user runs /start.
    const { data, error } = await admin()
      .from('telegram_subscriptions')
      .insert({
        clerk_user_id: userId,
        chat_id: `pending:${code}`,
        label,
        link_code: code,
        link_expires_at: expires,
      })
      .select('id')
      .single();
    if (error) throw new HttpError(500, error.message);

    const botName = process.env.TELEGRAM_BOT_USERNAME ?? 'your_bot';
    return json(201, {
      subscription_id: data.id,
      code,
      expires_at: expires,
      deep_link: `https://t.me/${botName}?start=${code}`,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

function makeLinkCode(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  const alpha = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no look-alikes
  let s = 'JV-';
  for (let i = 0; i < 4; i += 1) s += alpha[bytes[i] % alpha.length];
  s += '-';
  for (let i = 4; i < 6; i += 1) s += String(bytes[i] % 10);
  s += String(bytes[0] % 10) + String(bytes[1] % 10);
  return s;
}
