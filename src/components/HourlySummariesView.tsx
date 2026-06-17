import { useCallback, useEffect, useState } from 'react';
import type { GetToken } from '../lib/api';

interface Summary {
  hour_start: string;
  summary_text: string | null;
  record_count: number;
  status: 'ok' | 'empty' | 'error';
  error_message: string | null;
}

function formatHour(iso: string): string {
  const d = new Date(iso);
  const end = new Date(d.getTime() + 60 * 60 * 1000);
  const fmt = new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
  const hourFmt = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });
  return `${fmt.format(d)} – ${hourFmt.format(end)}`;
}

export function HourlySummariesView({ getToken }: { getToken: GetToken }) {
  const [items, setItems] = useState<Summary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const token = await getToken();
      if (!token) throw new Error('Не авторизованы');
      const r = await fetch('/api/cloud/hourly-summaries?limit=72', {
        headers: { Authorization: 'Bearer ' + token },
      });
      if (!r.ok) {
        const d = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(d.error ?? 'HTTP ' + r.status);
      }
      const data = (await r.json()) as { summaries: Summary[] };
      setItems(data.summaries ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [getToken]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-ink-100">Сводки</h2>
          <p className="text-sm text-ink-400">
            Анализ каждого часа: что происходило, настроение, ключевые моменты. Обновляется автоматически в начале каждого часа.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="rounded-full border border-ink-800 bg-ink-900 px-3 py-1.5 text-xs text-ink-300 hover:bg-ink-800 disabled:opacity-50"
        >
          {loading ? 'Загрузка…' : 'Обновить'}
        </button>
      </header>

      {error && (
        <div className="rounded-lg border border-red-900/60 bg-red-950/30 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      )}

      {!loading && !error && items.length === 0 && (
        <div className="rounded-lg border border-ink-800 bg-ink-900/40 px-4 py-6 text-center text-sm text-ink-400">
          Пока нет ни одной часовой сводки. Они появятся после первого полного часа с записями.
        </div>
      )}

      <ul className="flex flex-col gap-3">
        {items.map((it) => (
          <li
            key={it.hour_start}
            className="rounded-lg border border-ink-800 bg-ink-900/40 p-4"
          >
            <div className="flex items-baseline justify-between gap-3">
              <div className="text-sm font-medium text-ink-100">{formatHour(it.hour_start)}</div>
              <div className="text-xs text-ink-400">
                {it.record_count} {it.record_count === 1 ? 'запись' : it.record_count >= 2 && it.record_count <= 4 ? 'записи' : 'записей'}
              </div>
            </div>
            {it.status === 'ok' && it.summary_text && (
              <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-ink-200">{it.summary_text}</p>
            )}
            {it.status === 'empty' && (
              <p className="mt-2 text-sm italic text-ink-400">
                Час прошёл тихо, значимой активности не зафиксировано.
              </p>
            )}
            {it.status === 'error' && (
              <p className="mt-2 text-sm text-red-300">
                Не удалось собрать сводку: {it.error_message ?? 'неизвестная ошибка'}
              </p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
