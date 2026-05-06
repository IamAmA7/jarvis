/**
 * SessionsView — combined cloud + local recording history.
 *
 * Shows two sections:
 *   1. Cloud recordings (from `gcs_synced_files`, populated by GitHub Actions
 *      cron in `scripts/gcs-sync` from the GCS bucket every 5 minutes)
 *   2. Local sessions (in-app recordings, from /api/sessions)
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

interface CloudRow {
  id: number;
  bucket: string;
  name: string;
  size_bytes: number | null;
  content_type: string | null;
  recorded_at: string | null;
  transcript_text: string | null;
  language: string | null;
  duration_sec: number | null;
  insights: any;
  status: 'done' | 'error';
  error_message: string | null;
  processed_at: string;
}

async function listCloud(getToken: GetToken): Promise<CloudRow[]> {
  const token = await getToken();
  if (!token) throw new Error('Not signed in');
  const res = await fetch('/api/cloud', { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    let detail = `${res.status}`;
    try { const b = await res.json() as { error?: string }; if (b.error) detail = b.error; } catch {}
    throw new Error(`Cloud: ${detail}`);
  }
  const body = await res.json() as { recordings: CloudRow[] };
  return body.recordings;
}

export function SessionsView({ getToken, onGoToRecord }: SessionsViewProps) {
  const [rows, setRows] = useState<SessionRow[] | null>(null);
  const [cloud, setCloud] = useState<CloudRow[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [openCloudId, setOpenCloudId] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [next, nextCloud] = await Promise.all([
        listSessions(getToken),
        listCloud(getToken).catch((err) => {
          // eslint-disable-next-line no-console
          console.warn('[SessionsView] cloud list failed', err);
          return [] as CloudRow[];
        }),
      ]);
      setRows(next);
      setCloud(nextCloud);
      setListError(null);
      if (nextCloud.length > 0 && openCloudId === null && openId === null) {
        setOpenCloudId(nextCloud[0].id);
      } else if (next.length > 0 && (openId === null || !next.some((r) => r.id === openId)) && openCloudId === null) {
        setOpenId(next[0].id);
      }
      if (next.length === 0) setOpenId(null);
    } catch (err) {
      setListError(err instanceof Error ? err.message : String(err));
    }
  }, [getToken, openId, openCloudId]);

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (rows === null || cloud === null) {
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

  if (rows.length === 0 && cloud.length === 0) {
    return (
      <div className="mx-auto w-full max-w-2xl rounded-lg border border-ink-800 bg-ink-900/40 p-10 text-center">
        <h2 className="text-lg font-semibold">Пока нет сохранённых записей</h2>
        <p className="mt-2 text-sm text-ink-400">
          Локальные записи появятся здесь по мере того, как вы их делаете.
          Облачные записи (из GCS bucket) подтягиваются автоматически каждые 5 минут.
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
    <div className="mx-auto grid w-full max-w-5xl grid-cols-1 gap-4 md:grid-cols-[280px,1fr]">
      <aside className="space-y-3">
        {cloud.length > 0 && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between px-2">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-accent-400">
                ☁ Облако · {cloud.length}
              </h2>
              <button
                type="button"
                onClick={() => void refresh()}
                className="text-[11px] text-ink-500 hover:text-ink-300"
              >
                обновить
              </button>
            </div>
            {cloud.map((c) => (
              <button
                key={`c-${c.id}`}
                type="button"
                onClick={() => { setOpenCloudId(c.id); setOpenId(null); }}
                className={`flex w-full flex-col items-start rounded-md border px-3 py-2 text-left transition-colors ${
                  openCloudId === c.id
                    ? 'border-accent-500/60 bg-accent-500/10'
                    : 'border-ink-800 bg-ink-900/40 hover:bg-ink-800/60'
                }`}
              >
                <span className="text-sm font-medium">{baseName(c.name)}</span>
                <span className="mt-0.5 flex flex-wrap gap-1.5 text-[11px] text-ink-400">
                  <span>{fmtTime(c.recorded_at)}</span>
                  {c.duration_sec != null && <span>· {Math.round(c.duration_sec)}s</span>}
                  {c.status === 'error' && <span className="text-red-300">· ошибка</span>}
                </span>
              </button>
            ))}
          </div>
        )}

        {rows.length > 0 && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between px-2">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-ink-400">
                Локальные · {rows.length}
              </h2>
            </div>
            {rows.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => { setOpenId(s.id); setOpenCloudId(null); }}
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
          </div>
        )}
      </aside>

      {openCloudId !== null && (() => {
        const c = cloud.find((x) => x.id === openCloudId);
        return c ? <CloudPane key={c.id} rec={c} /> : null;
      })()}

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

function CloudPane({ rec }: { rec: CloudRow }) {
  const [copied, setCopied] = useState(false);
  const ins = rec.insights as any;

  const handleCopy = async () => {
    let text = `# ${baseName(rec.name)}\n`;
    if (rec.recorded_at) text += `_${fmtTime(rec.recorded_at)}_\n\n`;
    if (ins?.summary?.length) {
      text += '## Summary\n';
      ins.summary.forEach((s: string) => { text += `- ${s}\n`; });
      text += '\n';
    }
    text += '## Transcript\n' + (rec.transcript_text || '(empty)');
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {}
  };

  if (rec.status === 'error') {
    return (
      <section className="rounded-lg border border-red-900/60 bg-red-950/30 p-5 text-sm text-red-200">
        <h2 className="text-base font-semibold">{baseName(rec.name)}</h2>
        <p className="mt-2 text-xs">{rec.error_message ?? 'Error'}</p>
      </section>
    );
  }

  return (
    <section className="rounded-lg border border-ink-800 bg-ink-900/40 p-5">
      <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{baseName(rec.name)}</h2>
          <p className="mt-0.5 flex flex-wrap gap-2 text-xs text-ink-400">
            <span className="rounded-full bg-accent-500/15 px-2 py-0.5 text-accent-300">☁ облако</span>
            <span>{fmtTime(rec.recorded_at)}</span>
            {rec.duration_sec != null && <span>· {(rec.duration_sec / 60).toFixed(1)} мин</span>}
            {rec.language && <span>· {rec.language}</span>}
            {rec.size_bytes != null && (
              <span>· {(rec.size_bytes / 1024 / 1024).toFixed(2)} MB</span>
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={handleCopy}
          className="rounded-md border border-ink-800 px-2.5 py-1 text-xs hover:bg-ink-800/60"
        >
          {copied ? 'Скопировано' : 'Copy'}
        </button>
      </header>

      {ins && (
        <div className="mb-5 space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-400">
            Инсайты
          </h3>
          {Array.isArray(ins.summary) && ins.summary.length > 0 && (
            <ul className="space-y-1.5">
              {ins.summary.map((s: string, i: number) => (
                <li key={i} className="flex gap-2 text-sm">
                  <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-accent-500" />
                  <span>{s}</span>
                </li>
              ))}
            </ul>
          )}
          {Array.isArray(ins.action_items) && ins.action_items.length > 0 && (
            <div>
              <h4 className="text-[11px] font-semibold uppercase tracking-wider text-ink-500">
                Action items
              </h4>
              <ul className="mt-1 space-y-1">
                {ins.action_items.map((a: any, i: number) => (
                  <li key={i} className="text-sm">
                    • {a.action}
                    {a.owner && <span className="text-ink-400"> — {a.owner}</span>}
                    {a.deadline && <span className="text-ink-500"> (к {a.deadline})</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {Array.isArray(ins.key_topics) && ins.key_topics.length > 0 && (
            <div>
              <h4 className="text-[11px] font-semibold uppercase tracking-wider text-ink-500">
                Key topics
              </h4>
              <p className="mt-1 flex flex-wrap gap-1.5 text-xs">
                {ins.key_topics.map((t: string) => (
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
          {Array.isArray(ins.open_questions) && ins.open_questions.length > 0 && (
            <div>
              <h4 className="text-[11px] font-semibold uppercase tracking-wider text-ink-500">
                Открытые вопросы
              </h4>
              <ul className="mt-1 space-y-0.5">
                {ins.open_questions.map((q: string, i: number) => (
                  <li key={i} className="text-sm">? {q}</li>
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
        {rec.transcript_text || '(пусто)'}
      </p>
    </section>
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
      .then((d) => { if (alive) setDetail(d); })
      .catch((err) => { if (alive) setError(err instanceof Error ? err.message : String(err)); });
    return () => { alive = false; };
  }, [getToken, sessionId]);

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
      insight: detail.insight ? {
        session_id: detail.session.id,
        timestamp: detail.session.ended_at ?? detail.session.started_at,
        summary: detail.insight.summary,
        action_items: detail.insight.action_items,
        key_topics: detail.insight.key_topics,
        open_questions: detail.insight.open_questions,
        sentiment: detail.insight.sentiment,
        energy_level: detail.insight.energy_level,
        language_detected: detail.insight.language_detected,
      } : null,
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
    return <section className="rounded-lg border border-red-900/60 bg-red-950/30 p-5 text-sm text-red-200">{error}</section>;
  }
  if (!session) {
    return <section className="rounded-lg border border-ink-800 bg-ink-900/40 p-5 text-sm text-ink-400">Загружаем…</section>;
  }

  const transcript = session.chunks.filter((c) => c.status === 'final').map((c) => c.text.trim()).filter(Boolean).join(' ');

  return (
    <section className="rounded-lg border border-ink-800 bg-ink-900/40 p-5">
      <header className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{new Date(session.createdAt).toLocaleString()}</h2>
          {session.context && <p className="mt-0.5 text-xs text-ink-400">{session.context}</p>}
        </div>
        <div className="flex items-center gap-1.5 text-xs">
          <button type="button" onClick={handleCopy} className="rounded-md border border-ink-800 px-2.5 py-1 hover:bg-ink-800/60">{copied ? 'Скопировано' : 'Copy MD'}</button>
          <button type="button" onClick={() => exportMarkdown(session)} className="rounded-md border border-ink-800 px-2.5 py-1 hover:bg-ink-800/60">.md</button>
          <button type="button" onClick={() => exportPdf(session)} className="rounded-md border border-ink-800 px-2.5 py-1 hover:bg-ink-800/60">.pdf</button>
          <button type="button" onClick={handleDelete} disabled={busy} className="rounded-md border border-red-900/60 bg-red-950/30 px-2.5 py-1 text-red-200 hover:bg-red-950/50 disabled:opacity-50">{busy ? 'Удаляю…' : 'Удалить'}</button>
        </div>
      </header>

      {session.insight && (
        <div className="mb-5 space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-400">Инсайты</h3>
          <ul className="space-y-1.5">
            {session.insight.summary.map((s, i) => (
              <li key={i} className="flex gap-2 text-sm"><span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-accent-500" /><span>{s}</span></li>
            ))}
          </ul>
          {session.insight.action_items.length > 0 && (
            <div>
              <h4 className="text-[11px] font-semibold uppercase tracking-wider text-ink-500">Action items</h4>
              <ul className="mt-1 space-y-1">
                {session.insight.action_items.map((a, i) => (
                  <li key={i} className="text-sm">• {a.action}{a.owner && <span className="text-ink-400"> — {a.owner}</span>}{a.deadline && <span className="text-ink-500"> (к {a.deadline})</span>}</li>
                ))}
              </ul>
            </div>
          )}
          {session.insight.key_topics.length > 0 && (
            <div>
              <h4 className="text-[11px] font-semibold uppercase tracking-wider text-ink-500">Key topics</h4>
              <p className="mt-1 flex flex-wrap gap-1.5 text-xs">
                {session.insight.key_topics.map((t) => (
                  <span key={t} className="rounded-full border border-ink-800 px-2 py-0.5 font-mono text-ink-300">{t}</span>
                ))}
              </p>
            </div>
          )}
        </div>
      )}

      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-400">Транскрипт</h3>
      <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink-200">{transcript || '(пусто)'}</p>
    </section>
  );
}

function baseName(p: string) { const i = p.lastIndexOf('/'); return i >= 0 ? p.slice(i + 1) : p; }
function fmtTime(s: string | null) { if (!s) return ''; const d = new Date(s); return Number.isNaN(d.getTime()) ? s : d.toLocaleString(); }
