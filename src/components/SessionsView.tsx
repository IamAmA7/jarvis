import { useMemo, useState } from 'react';
import { buildMarkdown, copyToClipboard, exportMarkdown, exportPdf } from '../lib/export';
import { deleteSession } from '../lib/storage';
import type { Session } from '../types';

interface SessionsViewProps {
  sessions: Session[];
  onChanged: () => void;
  onGoToRecord: () => void;
}

export function SessionsView({ sessions, onChanged, onGoToRecord }: SessionsViewProps) {
  const [openId, setOpenId] = useState<string | null>(sessions[0]?.id ?? null);

  const activeSession = useMemo(
    () => sessions.find((s) => s.id === openId) ?? sessions[0] ?? null,
    [sessions, openId],
  );

  if (sessions.length === 0) {
    return (
      <div className="mx-auto w-full max-w-2xl rounded-lg border border-ink-800 bg-ink-900/40 p-10 text-center">
        <h2 className="text-lg font-semibold">Пока нет сохранённых сессий</h2>
        <p className="mt-2 text-sm text-ink-400">
          Записи автоматически попадают сюда после каждой записи (если включена
          опция сохранения в настройках).
        </p>
        <button
          type="button"
          onClick={onGoToRecord}
          className="mt-4 rounded-md bg-accent-500 px-4 py-2 text-sm font-medium text-white hover:bg-accent-600"
        >
          Начать запись
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto grid w-full max-w-5xl grid-cols-1 gap-4 md:grid-cols-[260px,1fr]">
      <aside className="space-y-1.5">
        <h2 className="px-2 text-xs font-semibold uppercase tracking-wider text-ink-400">
          Последние {sessions.length}
        </h2>
        {sessions.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => setOpenId(s.id)}
            className={`flex w-full flex-col items-start rounded-md border px-3 py-2 text-left transition-colors ${
              activeSession?.id === s.id
                ? 'border-accent-500/60 bg-accent-500/10'
                : 'border-ink-800 bg-ink-900/40 hover:bg-ink-800/60'
            }`}
          >
            <span className="text-sm font-medium">
              {new Date(s.createdAt).toLocaleString()}
            </span>
            <span className="mt-0.5 line-clamp-2 text-xs text-ink-400">
              {s.context || s.insight?.summary?.[0] || '(без контекста)'}
            </span>
          </button>
        ))}
      </aside>

      {activeSession && (
        <SessionDetail
          session={activeSession}
          onDelete={() => {
            deleteSession(activeSession.id);
            onChanged();
            setOpenId(null);
          }}
        />
      )}
    </div>
  );
}

function SessionDetail({ session, onDelete }: { session: Session; onDelete: () => void }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await copyToClipboard(buildMarkdown(session));
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  const transcript = session.chunks
    .filter((c) => c.status === 'final')
    .map((c) => c.text.trim())
    .filter(Boolean)
    .join(' ');

  return (
    <section className="rounded-lg border border-ink-800 bg-ink-900/40 p-5">
      <header className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">
            {new Date(session.createdAt).toLocaleString()}
          </h2>
          {session.context && (
            <p className="mt-0.5 text-xs text-ink-400">{session.context}</p>
          )}
        </div>
        <div className="flex items-center gap-1.5 text-xs">
          <button
            type="button"
            onClick={handleCopy}
            className="rounded-md border border-ink-800 px-2.5 py-1 hover:bg-ink-800/60"
          >
            {copied ? 'Скопировано' : 'Copy MD'}
          </button>
          <button
            type="button"
            onClick={() => exportMarkdown(session)}
            className="rounded-md border border-ink-800 px-2.5 py-1 hover:bg-ink-800/60"
          >
            .md
          </button>
          <button
            type="button"
            onClick={() => exportPdf(session)}
            className="rounded-md border border-ink-800 px-2.5 py-1 hover:bg-ink-800/60"
          >
            .pdf
          </button>
          <button
            type="button"
            onClick={onDelete}
            className="rounded-md border border-red-900/60 bg-red-950/30 px-2.5 py-1 text-red-200 hover:bg-red-950/50"
          >
            Удалить
          </button>
        </div>
      </header>

      {session.insight && (
        <div className="mb-5 space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-400">
            Инсайты
          </h3>
          <ul className="space-y-1.5">
            {session.insight.summary.map((s, i) => (
              <li key={i} className="flex gap-2 text-sm">
                <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-accent-500" />
                <span>{s}</span>
              </li>
            ))}
          </ul>
          {session.insight.action_items.length > 0 && (
            <div>
              <h4 className="text-[11px] font-semibold uppercase tracking-wider text-ink-500">
                Action items
              </h4>
              <ul className="mt-1 space-y-1">
                {session.insight.action_items.map((a, i) => (
                  <li key={i} className="text-sm">
                    • {a.action}
                    {a.owner && <span className="text-ink-400"> — {a.owner}</span>}
                    {a.deadline && <span className="text-ink-500"> (к {a.deadline})</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-400">
        Транскрипт
      </h3>
      <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink-200">
        {transcript || '(пусто)'}
      </p>
    </section>
  );
}
