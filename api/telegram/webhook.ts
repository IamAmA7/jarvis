/**
 * POST /api/telegram/webhook — Telegram calls us when users message the bot.
 *
 * Registered once via:
 *   curl -s "https://api.telegram.org/bot<token>/setWebhook" \
 *        -d "url=https://<your-vercel-domain>/api/telegram/webhook" \
 *        -d "secret_token=<random>"
 *
 * Only handles the `/start <code>` command. Any other text gets a gentle
 * help reply. Updates unrelated to this bot (edited messages, photos, etc.)
 * are ignored.
 *
 * Webhook auth uses Telegram's `X-Telegram-Bot-Api-Secret-Token` header
 * compared against TELEGRAM_WEBHOOK_SECRET. If the env var isn't set we
 * still accept requests (bootstrap scenario), but log a warning.
 */
import { errorResponse, HttpError, json } from '../_lib/auth';
import { admin } from '../_lib/supabase';
import { esc, sendMessage } from '../_lib/telegram';

export const config = { runtime: 'edge' };

interface TgUpdate {
  message?: {
    chat: { id: number; type: string };
    from?: { id: number; username?: string; first_name?: string };
    text?: string;
  };
}

export default async function handler(req: Request): Promise<Response> {
  try {
    if (req.method !== 'POST') throw new HttpError(405, 'POST only');

    const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
    if (expected) {
      const got = req.headers.get('x-telegram-bot-api-secret-token');
      if (got !== expected) throw new HttpError(401, 'Bad webhook secret');
    } else {
      // eslint-disable-next-line no-console
      console.warn('[telegram] TELEGRAM_WEBHOOK_SECRET not set');
    }

    const update = (await req.json()) as TgUpdate;
    const msg = update.message;
    if (!msg || !msg.text) return json(200, { ok: true });
    const chatId = String(msg.chat.id);
    const text = msg.text.trim();

    const startMatch = /^\/start(?:\s+(\S+))?$/i.exec(text);
    if (startMatch) {
      const code = (startMatch[1] ?? '').toUpperCase();
      if (!code) {
        await sendMessage({
          chatId,
          text:
            '👋 Это бот Jarvis. Чтобы подключить уведомления, зайди в дашборд, ' +
            'раздел Настройки → Telegram, нажми «Получить код» и открой бота ' +
            'по ссылке, которую там увидишь.',
        });
        return json(200, { ok: true });
      }

      const { data: sub } = await admin()
        .from('telegram_subscriptions')
        .select('id, clerk_user_id, link_expires_at, label')
        .eq('link_code', code)
        .maybeSingle();

      if (!sub) {
        await sendMessage({
          chatId,
          text: '🛑 Код не найден. Сгенерируй новый в дашборде.',
        });
        return json(200, { ok: true });
      }
      if (sub.link_expires_at && new Date(sub.link_expires_at) < new Date()) {
        await sendMessage({
          chatId,
          text: '⏱ Код устарел. Сгенерируй новый в дашборде.',
        });
        return json(200, { ok: true });
      }

      // Bind the chat id. If this chat already had a subscription we keep
      // the newer label and wipe the one-time code.
      await admin()
        .from('telegram_subscriptions')
        .update({
          chat_id: chatId,
          link_code: null,
          link_expires_at: null,
          verified_at: new Date().toISOString(),
        })
        .eq('id', sub.id);

      await sendMessage({
        chatId,
        text:
          `✅ Подключено. Это чат «${esc(sub.label ?? 'Personal')}».\n` +
          `Сюда будут приходить 🔴 срочные события сразу и 🟡 дневной отчёт вечером.\n` +
          `Отключить можно командой /stop.`,
      });
      return json(200, { ok: true });
    }

    if (/^\/stop\b/i.test(text)) {
      await admin().from('telegram_subscriptions').delete().eq('chat_id', chatId);
      await sendMessage({ chatId, text: '👋 Отключил уведомления.' });
      return json(200, { ok: true });
    }

    if (/^\/help\b/i.test(text) || /^\?+$/.test(text)) {
      await sendMessage({
        chatId,
        text:
          '<b>Команды</b>\n' +
          '/start &lt;code&gt; — подключить уведомления\n' +
          '/stop — отключить\n' +
          '/help — это сообщение',
      });
      return json(200, { ok: true });
    }

    // Unknown message — ignore silently so the bot isn't chatty.
    return json(200, { ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
