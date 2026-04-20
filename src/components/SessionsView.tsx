/**
 * SessionsView — cloud-backed history browser.
 *
 * List is fetched from /api/sessions (Supabase). When the user picks a session
 * we lazy-load its full payload (segments + insight) from /api/sessions/:id and
 * reconstruct the in-memory `Session` shape the export helpers expect.
 *
 * Previously this read from `localStorage` via `loadSessions()`; that's now a
 * cache-only path inside useSessionSync. Supabase is the source of truth.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  deleteSession as apiDeleteSession,
  getSession,
  listSessions,
  type GetToken,
  type SessionDetail,
  type SessionRow,
} from '../lib/api';
import { buildMarkdown, copyToClipboard, exportMarkdown, exportPdf } from '../lib/export';
import { track } from '../lib/telemetry';
import type { Session, TranscriptChunk } from '../types';

interface SessionsViewProps {
  getToken: GetToken;
  onGoToRecord: () => void;
}

export function SessionsView({ getToken, onGoToRecord }: SessionsViewProps) {
  const [rows, setRows] = useState<SessionRow[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await listSessions(getToken);
      setRows(next);
      setListError(null);
      if (next.length > 0 && (openId === null || !next.some((r) => r.id === openId))) {
        setOpenId(next[0].id);
      }
      if (next.length === 0) setOpenId(null);
    } catch (err) {
      setListError(err instanceof Error ? err.message : String(err));
    }
  }, [getToken, openId]);

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (rows === null) {
    return (
      <div className="mx-auto w-full max-w-2xl rounded-lg border border-ink-800 bg-ink-900/40 p-10 text-center text-sm text-ink-400">
        {listError ? (
          <span className="text-red-300">{listError}</span>
        ) : (
          'Загружаем историю…'
        )}
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="mx-auto w-full max-w-2xl rounded-lg border border-ink-800 bg-ink-900/40 p-10 text-center">
        <h2 className="text-lg font-semibold">Пока нет сохранённых сессий</h2>
        <p className="mt-2 text-sm text-ink-400">
          Записи автоматически синхронизируются сюда по мере того, как вы их
          делаете. Начните новую запись — и она появится здесь.
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
        <div className="flex items-center justify-between px-2">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-ink-400">
            Последние {rows.length}
          </h2>
          <button
            type="button"
            onClick={() => void refresh()}
            className="text-[11px] text-ink-500 hover:text-ink-300"
          >
            обновить
          </button>
        </div>
        {rows.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => setOpenId(s.id)}
            className={`flex w-full flex-col items-start rounded-md border px-3 py-2 text-left transition-colors ${
              openId === s.id
                ? 'border-accent-500/60 bg-accent-500/10'
                : 'border-ink-800 bg-ink-900/40 hover:bg-ink-800/60'
            }`}
          >
            <span className="text-sm font-medium">
              {new Date(s.started_at).toLocaleString()}
            </span>
            <span className="mt-0.5 line-clamp-2 text-xs text-ink-400">
              {s.context || s.title || '(без контекста)'}
            </span>
          </button>
        ))}
      </aside>

      {openId && (
        <SessionDetailPane
          key={openId}
          getToken={getToken}
          sessionId={openId}
          onDeleted={async () => {
            track('session:delete', { id: openId });
            setOpenId(null);
            await refresh();
          }}
        />
      )}
    </div>
  );
}

interface DetailPaneProps {
  getToken: GetToken;
  sessionId: string;
  onDeleted: () => void | Promise<void>;
}

function SessionDetailPane({ getToken, sessionId, onDeleted }: DetailPaneProps) {
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    setDetail(null);
    setError(null);
    getSession(getToken, sessionId)
      .then((d) => {
        if (alive) setDetail(d);
      })
      .catch((err) => {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      alive = false;
    };
  }, [getToken, sessionId]);

  // Adapt the API shape to the `Session` shape the export helpers consume.
  const session: Session | null = useMemo(() => {
    if (!detail) return null;
    const chunks: TranscriptChunk[] = detail.segments.map((seg) => ({
      id: `seg_${seg.idx}`,
      capturedAt: new Date(detail.session.started_at).getTime() + Math.round(seg.start_sec * 1000),
      text: seg.text,
      language: detail.session.language,
      segments: [{ start: seg.start_sec, end: seg.end_sec, text: seg.text }],
      status: 'final',
    }));
    return {
      id: detail.session.id,
      createdAt: new Date(detail.session.started_at).getTime(),
      context: detail.session.context ?? '',
      chunks,
      insight: detail.insight
        ? {
            session_id: detail.session.id,
            timestamp: detail.session.ended_at ?? detail.session.started_at,
            summary: detail.insight.summary,
            action_items: detail.insight.action_items,
            key_topics: detail.insight.key_topics,
            open_questions: detail.insight.open_questions,
            sentiment: detail.insight.sentiment,
            energy_level: detail.insight.energy_level,
            language_detected: detail.insight.language_detected,
          }
        : null,
    };
  }, [detail]);

  const handleCopy = async () => {
    if (!session) return;
    await copyToClipboard(buildMarkdown(session));
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  const handleDelete = async () => {
    if (!confirm('Удалить эту сессию? Это действие необратимо.')) return;
    setBusy(true);
    try {
      await apiDeleteSession(getToken, sessionId);
      await onDeleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  if (error) {
    return (
      <section className="rounded-lg border border-red-900/60 bg-red-950/30 p-5 text-sm text-red-200">
        {error}
      </section>
    );
  }

  if (!session) {
    return (
      <section className="rounded-lg border border-ink-800 bg-ink-900/40 p-5 text-sm text-ink-400">
        Загружаем…
      </section>
    );
  }

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
            onClick={handleDelete}
            disabled={busy}
            className="rounded-md border border-red-900/60 bg-red-950/30 px-2.5 py-1 text-red-200 hover:bg-red-950/50 disabled:opacity-50"
          >
            {busy ? 'Удаляю…' : 'Удалить'}
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
          {session.insight.key_topics.length > 0 && (
            <div>
              <h4 className="text-[11px] font-semibold uppercase tracking-wider text-ink-500">
                Key topics
              </h4>
              <p className="mt-1 flex flex-wrap gap-1.5 text-xs">
                {session.insight.key_topics.map((t) => (
                  <span
                    key={t}
                    className="rounded-full border border-ink-800 px-2 py-0.5 font-mono text-ink-300"
                  >
                    {t}
                  </span>
                ))}
              </p>
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
