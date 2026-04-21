/**
 * Telegram Bot API wrapper.
 *
 * We use a single bot (the one you register with @BotFather) — users link
 * their own chat to it by typing `/start <one-time-code>` after we hand them
 * the code in the dashboard. The bot then posts red alerts and the daily
 * digest. No third-party service, just the stock HTTP API.
 *
 * Set TELEGRAM_BOT_TOKEN in the server env. Outgoing messages use
 * HTML parse mode — it's more forgiving for variable content than MarkdownV2
 * and we handle escaping centrally via `esc()`.
 */
import { HttpError } from './auth';

const BASE = 'https://api.telegram.org';

function botToken(): string {
  const t = process.env.TELEGRAM_BOT_TOKEN;
  if (!t) throw new HttpError(500, 'TELEGRAM_BOT_TOKEN not configured');
  return t;
}

export interface TelegramMessage {
  chatId: string;
  text: string;
  quiet?: boolean;
  replyMarkup?: unknown;
}

export async function sendMessage(msg: TelegramMessage): Promise<{ messageId: number }> {
  const res = await fetch(`${BASE}/bot${botToken()}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: msg.chatId,
      text: msg.text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      disable_notification: msg.quiet ?? false,
      reply_markup: msg.replyMarkup,
    }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new HttpError(res.status, `Telegram: ${detail.slice(0, 400)}`);
  }
  const json = (await res.json()) as { ok: boolean; result?: { message_id: number }; description?: string };
  if (!json.ok || !json.result) {
    throw new HttpError(502, `Telegram rejected: ${json.description ?? 'unknown'}`);
  }
  return { messageId: json.result.message_id };
}

export function esc(s: string | null | undefined): string {
  return (s ?? '').replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
}

/** Format a red alert into a compact, scannable HTML message. */
export function formatRedAlert(opts: {
  category: string;
  summary: string;
  evidence: string | null;
  confidence: number;
  windowStart: Date;
  childName: string | null;
  dashboardUrl: string;
}): string {
  const when = opts.windowStart.toLocaleString('ru-RU', { hour12: false });
  const child = opts.childName ? ` · ${esc(opts.childName)}` : '';
  const lines = [
    `🔴 <b>${esc(categoryLabel(opts.category))}</b>${child}`,
    `<i>${esc(when)} · уверенность ${Math.round(opts.confidence * 100)}%</i>`,
    ``,
    esc(opts.summary),
  ];
  if (opts.evidence) {
    lines.push('', `<blockquote>${esc(opts.evidence)}</blockquote>`);
  }
  lines.push('', `<a href="${esc(opts.dashboardUrl)}">Открыть в дашборде</a>`);
  return lines.join('\n');
}

/** Format the yellow daily digest — one message, grouped by category. */
export function formatDigest(opts: {
  when: Date;
  childName: string | null;
  entries: Array<{ category: string; summary: string; time: Date }>;
  dashboardUrl: string;
}): string {
  const header = `🟡 <b>Дневной отчёт</b>${opts.childName ? ` · ${esc(opts.childName)}` : ''}`;
  if (opts.entries.length === 0) {
    return [
      header,
      `<i>${esc(opts.when.toLocaleDateString('ru-RU'))}</i>`,
      '',
      'Ничего тревожного за день. Всё в пределах нормы.',
      ``,
      `<a href="${esc(opts.dashboardUrl)}">Открыть дашборд</a>`,
    ].join('\n');
  }
  const byCategory = new Map<string, Array<{ summary: string; time: Date }>>();
  for (const e of opts.entries) {
    const list = byCategory.get(e.category) ?? [];
    list.push({ summary: e.summary, time: e.time });
    byCategory.set(e.category, list);
  }
  const sections: string[] = [];
  for (const [cat, list] of byCategory) {
    sections.push(`<b>${esc(categoryLabel(cat))}</b> (${list.length})`);
    for (const item of list.slice(0, 3)) {
      const hh = item.time.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
      sections.push(`• <i>${esc(hh)}</i> — ${esc(item.summary)}`);
    }
    if (list.length > 3) sections.push(`• <i>и ещё ${list.length - 3}</i>`);
    sections.push('');
  }
  return [
    header,
    `<i>${esc(opts.when.toLocaleDateString('ru-RU'))}</i>`,
    '',
    ...sections,
    `<a href="${esc(opts.dashboardUrl)}">Открыть дашборд</a>`,
  ].join('\n');
}

export function categoryLabel(raw: string): string {
  const map: Record<string, string> = {
    aggression: 'Агрессия в общении',
    physical_violence: 'Физическое воздействие',
    threats: 'Угрозы',
    screaming: 'Крик',
    panic: 'Паника',
    weapons: 'Упоминание оружия',
    drugs: 'Упоминание веществ',
    sexual_content: 'Сексуальный контент',
    suicide_mention: 'Упоминание суицида',
    fall_or_pain: 'Падение или боль',
    isolation: 'Изоляция',
    sadness: 'Грусть',
    recurring_conflict: 'Повторяющийся конфликт',
    negative_peer_dynamic: 'Плохая динамика с ровесниками',
    bullying_signals: 'Признаки буллинга',
    normal: 'Норма',
  };
  return map[raw] ?? raw;
}
