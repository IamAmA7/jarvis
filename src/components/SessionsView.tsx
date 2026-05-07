/**
 * SessionsView — cloud + local recording history (brutalist lime UI).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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

type SourceFilter = 'all' | 'cloud' | 'manual' | 'local';

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
  const text = await res.text();
  try {
    const body = JSON.parse(text) as { recordings: CloudRow[] };
    return body.recordings;
  } catch {
    throw new Error('API временно недоступен (возможно идёт деплой) — попробуйте обновить через минуту');
  }
}

const isManual = (r: CloudRow) => r.bucket === 'manual';

function dayKey(s: string | null | undefined): string | null {
  if (!s) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function SessionsView({ getToken, onGoToRecord }: SessionsViewProps) {
  const [rows, setRows] = useState<SessionRow[] | null>(null);
  const [cloud, setCloud] = useState<CloudRow[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [openCloudId, setOpenCloudId] = useState<number | null>(null);
  const [filter, setFilter] = useState<SourceFilter>('all');
  const [dateFilter, setDateFilter] = useState<string>('');
  const [cloudOpen, setCloudOpen] = useState(true);
  const [manualOpen, setManualOpen] = useState(true);
  const [localOpen, setLocalOpen] = useState(true);

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

  // Split cloud rows into Pi-recorded vs manually uploaded.
  const cloudPi = useMemo(() => (cloud ?? []).filter((r) => !isManual(r)), [cloud]);
  const cloudManual = useMemo(() => (cloud ?? []).filter((r) => isManual(r)), [cloud]);

  const cloudPiFiltered = useMemo(() => {
    if (!dateFilter) return cloudPi;
    return cloudPi.filter((c) => dayKey(c.recorded_at) === dateFilter);
  }, [cloudPi, dateFilter]);
  const cloudManualFiltered = useMemo(() => {
    if (!dateFilter) return cloudManual;
    return cloudManual.filter((c) => dayKey(c.recorded_at) === dateFilter);
  }, [cloudManual, dateFilter]);
  const rowsFiltered = useMemo(() => {
    if (!dateFilter) return rows ?? [];
    return (rows ?? []).filter((r) => dayKey(r.started_at) === dateFilter);
  }, [rows, dateFilter]);

  const availableDates = useMemo(() => {
    const set = new Set<string>();
    (cloud ?? []).forEach((c) => { const k = dayKey(c.recorded_at); if (k) set.add(k); });
    (rows ?? []).forEach((r) => { const k = dayKey(r.started_at); if (k) set.add(k); });
    return Array.from(set).sort().reverse();
  }, [cloud, rows]);

  const totalDurationSec = useMemo(() => {
    return [...cloudPiFiltered, ...cloudManualFiltered].reduce((s, r) => s + (r.duration_sec ?? 300), 0);
  }, [cloudPiFiltered, cloudManualFiltered]);
  const totalActionItems = useMemo(() => {
    return [...cloudPiFiltered, ...cloudManualFiltered].reduce(
      (s, r) => s + (Array.isArray(r.insights?.action_items) ? r.insights.action_items.length : 0),
      0,
    );
  }, [cloudPiFiltered, cloudManualFiltered]);

  if (rows === null || cloud === null) {
    return (
      <div className="mx-auto w-full max-w-2xl rounded-lg border border-ink-800 bg-ink-900/40 p-10 text-center text-sm text-ink-400">
        {listError ? <span className="text-red-300">{listError}</span> : 'Загружаем историю…'}
      </div>
    );
  }

  if (rows.length === 0 && cloud.length === 0) {
    return (
      <div className="mx-auto w-full max-w-2xl rounded-lg border border-ink-800 bg-ink-900/40 p-10 text-center">
        <h2 className="text-lg font-semibold">Пока нет сохранённых записей</h2>
        <p className="mt-2 text-sm text-ink-400">
          Локальные записи появятся здесь по мере того, как вы их делаете. Облачные записи (из GCS bucket) подтягиваются автоматически каждые 5 минут.
        </p>
        <button type="button" onClick={onGoToRecord} className="mt-4 rounded-full bg-accent-500 px-5 py-2 text-sm font-semibold text-black shadow-glow-accent hover:opacity-90">
          Начать запись
        </button>
      </div>
    );
  }

  const totalCount = cloudPiFiltered.length + cloudManualFiltered.length + rowsFiltered.length;
  const totalCountAll = cloudPi.length + cloudManual.length + rows.length;
  const totalHours = (totalDurationSec / 3600).toFixed(1);
  const showCloud = filter === 'all' || filter === 'cloud';
  const showManual = filter === 'all' || filter === 'manual';
  const showLocal = filter === 'all' || filter === 'local';

  return (
    <div className="mx-auto w-full max-w-6xl">
      <section className="mb-6 border-b border-ink-800 pb-6">
        <div className="kicker mb-3 text-[11px] text-ink-400">
          [ ИСТОРИЯ · {totalCount} {totalCount === 1 ? 'ЗАПИСЬ' : 'ЗАПИСЕЙ'}{dateFilter ? ` · ${dateFilter}` : ' · ОБЛАКО + ЗАГРУЗКИ + ЛОКАЛЬНЫЕ'} ]
        </div>
        <div className="flex flex-wrap items-end justify-between gap-6">
          <h1 className="text-5xl font-bold uppercase leading-[0.95] tracking-tight md:text-6xl lg:text-7xl">
            Архив <br /> <span className="text-accent-500 text-glow">голоса</span>.
          </h1>
          <div className="grid grid-cols-3 gap-4 sm:gap-6">
            <Stat num={totalCount.toString()} label="Записей" />
            <Stat num={`${totalHours} ч`} label="Транскриб." />
            <Stat num={totalActionItems.toString()} label="Action items" />
          </div>
        </div>
      </section>

      <div className="mb-5 flex flex-wrap items-center gap-2">
        <FilterChip active={filter === 'all'} onClick={() => setFilter('all')} label="Все" count={dateFilter ? totalCount : totalCountAll} />
        <FilterChip active={filter === 'cloud'} onClick={() => setFilter('cloud')} label="Облако" count={cloudPiFiltered.length} icon="☁" />
        <FilterChip active={filter === 'manual'} onClick={() => setFilter('manual')} label="Загрузки" count={cloudManualFiltered.length} icon="↑" />
        <FilterChip active={filter === 'local'} onClick={() => setFilter('local')} label="Локальные" count={rowsFiltered.length} icon="●" />
        <DateFilter value={dateFilter} onChange={setDateFilter} available={availableDates} />
      </div>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-[320px,1fr]">
        <aside className="space-y-5">
          {showCloud && cloudPi.length > 0 && (
            <div className="space-y-1.5">
              <div className="mb-2 flex items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={() => setCloudOpen((v) => !v)}
                  className="flex flex-1 items-center gap-2 text-left text-[11px] font-semibold uppercase tracking-[0.18em] text-ink-300 hover:text-accent-500"
                >
                  <span className={`text-ink-500 transition-transform ${cloudOpen ? 'rotate-90' : ''}`} aria-hidden>›</span>
                  <span className="dot-accent" /> Облако · <span className="text-accent-500">{cloudPiFiltered.length}</span>
                </button>
                <button type="button" onClick={() => void refresh()} className="text-[11px] text-ink-500 hover:text-accent-500">
                  обновить ↻
                </button>
              </div>
              {cloudOpen && cloudPiFiltered.map((c) => (
                <RecCard
                  key={`c-${c.id}`}
                  active={openCloudId === c.id}
                  onClick={() => { setOpenCloudId(c.id); setOpenId(null); }}
                  title={baseName(c.name)}
                  meta={[fmtTime(c.recorded_at), c.duration_sec != null ? `${Math.round(c.duration_sec)}s` : '', c.status === 'error' ? 'ошибка' : ''].filter(Boolean)}
                  tag="CLOUD"
                  tagError={c.status === 'error'}
                />
              ))}
            </div>
          )}

          {showManual && cloudManual.length > 0 && (
            <div className="space-y-1.5">
              <div className="mb-2 flex items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={() => setManualOpen((v) => !v)}
                  className="flex flex-1 items-center gap-2 text-left text-[11px] font-semibold uppercase tracking-[0.18em] text-ink-300 hover:text-accent-500"
                >
                  <span className={`text-ink-500 transition-transform ${manualOpen ? 'rotate-90' : ''}`} aria-hidden>›</span>
                  <span className="text-accent-500">↑</span> Загрузки · <span className="text-accent-500">{cloudManualFiltered.length}</span>
                </button>
              </div>
              {manualOpen && cloudManualFiltered.map((c) => (
                <RecCard
                  key={`m-${c.id}`}
                  active={openCloudId === c.id}
                  onClick={() => { setOpenCloudId(c.id); setOpenId(null); }}
                  title={baseName(c.name).replace(/^upload_[A-Za-z0-9]+_\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}_/, '')}
                  meta={[fmtTime(c.recorded_at), c.duration_sec != null ? `${Math.round(c.duration_sec)}s` : '', c.status === 'error' ? 'ошибка' : ''].filter(Boolean)}
                  tag="UPLOAD"
                  tagError={c.status === 'error'}
                />
              ))}
            </div>
          )}

          {showLocal && rows.length > 0 && (
            <div className="space-y-1.5">
              <div className="mb-2 flex items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={() => setLocalOpen((v) => !v)}
                  className="flex flex-1 items-center gap-2 text-left text-[11px] font-semibold uppercase tracking-[0.18em] text-ink-400 hover:text-accent-500"
                >
                  <span className={`text-ink-500 transition-transform ${localOpen ? 'rotate-90' : ''}`} aria-hidden>›</span>
                  Локальные · <span className="text-ink-200">{rowsFiltered.length}</span>
                </button>
              </div>
              {localOpen && rowsFiltered.map((s) => (
                <RecCard
                  key={s.id}
                  active={openId === s.id}
                  onClick={() => { setOpenId(s.id); setOpenCloudId(null); }}
                  title={new Date(s.started_at).toLocaleString()}
                  meta={[(s.context || s.title || '(без контекста)').slice(0, 60)]}
                  tag="LOCAL"
                />
              ))}
            </div>
          )}
        </aside>

        {openCloudId !== null && (() => {
          const c = cloud.find((x) => x.id === openCloudId);
          return c ? <CloudPane key={c.id} rec={c} getToken={getToken} /> : null;
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
    </div>
  );
}

function Stat({ num, label }: { num: string; label: string }) {
  return (
    <div className="border-l-2 border-ink-800 pl-3">
      <div className="text-2xl font-bold tracking-tight">{num}</div>
      <div className="kicker mt-0.5 text-[10px] text-ink-400">{label}</div>
    </div>
  );
}

function FilterChip({
  active, onClick, label, count, icon,
}: {
  active: boolean; onClick: () => void; label: string; count: number; icon?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-2 rounded-full px-4 py-1.5 text-sm font-medium transition-all ${
        active ? 'bg-accent-500 text-black shadow-glow-accent' : 'border border-ink-800 bg-ink-900 text-ink-300 hover:border-ink-700 hover:bg-ink-800'
      }`}
    >
      {icon && <span className="text-xs">{icon}</span>}
      {label}
      <span className={`rounded-full px-1.5 text-[10px] font-mono ${active ? 'bg-black/20' : 'bg-ink-800 text-ink-400'}`}>
        {count}
      </span>
    </button>
  );
}

function DateFilter({
  value, onChange, available,
}: {
  value: string; onChange: (v: string) => void; available: string[];
}) {
  const [picking, setPicking] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!picking) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setPicking(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [picking]);

  return (
    <div className="relative ml-auto flex items-center gap-2" ref={ref}>
      <button
        type="button"
        onClick={() => setPicking((v) => !v)}
        className={`flex items-center gap-2 rounded-full border px-4 py-1.5 text-sm font-medium transition-all ${
          value
            ? 'border-accent-500/60 bg-accent-500/10 text-accent-500'
            : 'border-ink-800 bg-ink-900 text-ink-300 hover:border-ink-700 hover:bg-ink-800'
        }`}
      >
        <span className="text-xs">📅</span>
        {value || 'Любая дата'}
      </button>
      {value && (
        <button
          type="button"
          onClick={() => onChange('')}
          className="rounded-full border border-ink-800 bg-ink-900 px-2.5 py-1.5 text-[11px] text-ink-400 hover:border-accent-500 hover:text-accent-500"
          title="Сброс"
        >
          ✕
        </button>
      )}
      {picking && (
        <div className="absolute right-0 top-full z-20 mt-2 w-[220px] overflow-hidden rounded-xl border border-ink-700 bg-ink-950 shadow-glow-accent">
          <div className="border-b border-ink-800 p-2">
            <input
              type="date"
              value={value}
              onChange={(e) => { onChange(e.target.value); setPicking(false); }}
              className="w-full rounded-md border border-ink-800 bg-ink-900 px-2 py-1.5 text-xs text-ink-200 [color-scheme:dark]"
            />
          </div>
          {available.length > 0 && (
            <div className="max-h-[220px] overflow-y-auto">
              <div className="px-3 py-1.5 font-mono text-[9px] uppercase tracking-[0.15em] text-ink-500">
                Записи есть в эти дни
              </div>
              {available.map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => { onChange(d); setPicking(false); }}
                  className={`flex w-full items-center justify-between px-3 py-1.5 text-left text-xs transition-colors ${
                    d === value ? 'bg-accent-500/10 text-accent-500' : 'text-ink-200 hover:bg-accent-500/10 hover:text-accent-500'
                  }`}
                >
                  <span>{d}</span>
                  {d === value && <span className="text-[10px]">✓</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function RecCard({
  active, onClick, title, meta, tag, tagError,
}: {
  active: boolean; onClick: () => void; title: string; meta: string[]; tag?: string; tagError?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative flex w-full flex-col items-start rounded-xl border px-3.5 py-3 text-left transition-all ${
        active ? 'border-accent-500/60 bg-accent-500/5 shadow-glow-accent' : 'border-ink-800 bg-ink-900/40 hover:bg-ink-800/60'
      }`}
    >
      {active && (
        <span className="absolute -left-px top-3 bottom-3 w-[3px] rounded-full bg-accent-500 shadow-glow-accent" aria-hidden />
      )}
      {tag && (
        <span className={`mb-1 inline-block rounded border px-1.5 py-px font-mono text-[9px] font-bold tracking-[0.1em] ${
          tagError ? 'border-red-500/50 text-red-300' : 'border-accent-500/60 text-accent-500'
        }`}>
          {tag}
        </span>
      )}
      <span className="text-sm font-semibold text-ink-100">{title}</span>
      {meta.length > 0 && (
        <span className="mt-1 flex flex-wrap gap-x-1.5 gap-y-0.5 text-[11px] text-ink-400">
          {meta.map((m, i) => (
            <span key={i} className={i > 0 ? 'before:mr-1.5 before:text-ink-600 before:content-[\"·\"]' : ''}>{m}</span>
          ))}
        </span>
      )}
    </button>
  );
}

/** Brutalist accordion section with numbered chevron. */
function Accordion({
  num, label, defaultOpen = true, children, accent = false,
}: {
  num: string; label: string; defaultOpen?: boolean; children: React.ReactNode; accent?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`overflow-hidden rounded-xl border ${open ? 'border-ink-700' : 'border-ink-800'} bg-ink-900/40`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2.5 px-4 py-3 text-left transition-colors hover:bg-ink-800/40"
      >
        <span className={`inline-grid h-5 w-5 place-items-center rounded-full border font-mono text-[10px] ${
          accent ? 'border-accent-500 text-accent-500' : 'border-ink-700 text-accent-500'
        }`}>
          {num}
        </span>
        <span className="flex-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-ink-300">
          {label}
        </span>
        <span className={`text-ink-500 transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden>
          ›
        </span>
      </button>
      {open && (
        <div className="border-t border-ink-800/80 px-4 pb-4 pt-3">{children}</div>
      )}
    </div>
  );
}

function AudioPlayer({ recId, getToken }: { recId: number; getToken: GetToken }) {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { setUrl(null); setError(null); }, [recId]);
  useEffect(() => {
    return () => { if (url) URL.revokeObjectURL(url); };
  }, [url]);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const token = await getToken();
      if (!token) throw new Error('Not signed in');
      const res = await fetch(`/api/cloud/audio?id=${recId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        let detail = `${res.status}`;
        try { const b = await res.json() as { error?: string }; if (b.error) detail = b.error; } catch {}
        throw new Error(detail);
      }
      const blob = await res.blob();
      const u = URL.createObjectURL(blob);
      setUrl(u);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  if (url) {
    return (
      <audio controls src={url} className="w-full" preload="auto">
        Your browser does not support audio playback.
      </audio>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        type="button"
        onClick={load}
        disabled={loading}
        className="inline-flex items-center gap-2 rounded-full bg-accent-500 px-5 py-2 text-sm font-semibold text-black shadow-glow-accent hover:opacity-90 disabled:opacity-60"
      >
        {loading ? (
          <>
            <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-black/30 border-t-black" />
            Загружаем…
          </>
        ) : (
          <>▶ Прослушать</>
        )}
      </button>
      {error && <span className="text-xs text-red-300">Ошибка: {error}</span>}
    </div>
  );
}

function splitBySpeakers(text: string): { speaker: number; text: string }[] {
  const cleaned = text.trim();
  if (!cleaned) return [];
  let parts = cleaned.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) {
    const sentences = cleaned.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g) ?? [cleaned];
    parts = [];
    for (let i = 0; i < sentences.length; i += 2) {
      parts.push(sentences.slice(i, i + 2).join(' ').trim());
    }
  }
  return parts.filter(Boolean).map((t, i) => ({ speaker: (i % 2) + 1, text: t }));
}

function TranscriptView({ text }: { text: string }) {
  const [bySpeaker, setBySpeaker] = useState(false);
  const turns = useMemo(() => (bySpeaker ? splitBySpeakers(text) : []), [bySpeaker, text]);
  if (!text) return <p className="text-sm text-ink-500">(пусто)</p>;
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setBySpeaker((v) => !v)}
          className={`rounded-full px-3 py-1 font-mono text-[10px] uppercase tracking-[0.15em] transition-colors ${
            bySpeaker ? 'bg-accent-500 text-black' : 'border border-ink-700 bg-ink-900 text-ink-300 hover:border-accent-500/50'
          }`}
        >
          {bySpeaker ? '✓ По спикерам' : '○ По спикерам'}
        </button>
        {bySpeaker && (
          <span className="text-[10px] text-ink-500">
            * эвристика по паузам · точная диаризация требует Deepgram
          </span>
        )}
      </div>
      {bySpeaker ? (
        <div className="space-y-2">
          {turns.map((t, i) => (
            <div key={i} className="flex gap-3 rounded-lg border border-ink-800 bg-ink-900/50 p-3">
              <span className={`shrink-0 rounded border px-2 py-0.5 font-mono text-[10px] font-bold tracking-[0.1em] ${
                t.speaker === 1 ? 'border-accent-500/60 text-accent-500' : 'border-ink-600 text-ink-300'
              }`}>
                S{t.speaker}
              </span>
              <p className="text-[15px] leading-[1.65] text-ink-100">{t.text}</p>
            </div>
          ))}
        </div>
      ) : (
        <p className="whitespace-pre-wrap text-[15px] leading-[1.7] text-ink-100">{text}</p>
      )}
    </div>
  );
}

function CloudDownloadMenu({
  rec, getToken,
}: { rec: CloudRow; getToken: GetToken }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  const safeName = baseName(rec.name).replace(/\.[^.]+$/, '');

  const buildSummary = () => {
    const ins = rec.insights as any;
    const lines: string[] = [];
    lines.push(`# ${baseName(rec.name)}`);
    if (rec.recorded_at) lines.push(`_${fmtTime(rec.recorded_at)}_`);
    lines.push('');
    if (Array.isArray(ins?.summary) && ins.summary.length) {
      lines.push('## Инсайты');
      ins.summary.forEach((s: string) => lines.push(`- ${s}`));
      lines.push('');
    }
    if (Array.isArray(ins?.key_topics) && ins.key_topics.length) {
      lines.push('## Key topics');
      lines.push(ins.key_topics.map((t: string) => `\`${t}\``).join(' '));
      lines.push('');
    }
    if (Array.isArray(ins?.action_items) && ins.action_items.length) {
      lines.push('## Action items');
      ins.action_items.forEach((a: any) => {
        lines.push(`- ${a.action}${a.owner ? ` (@${a.owner})` : ''}${a.deadline ? ` — ${a.deadline}` : ''}`);
      });
      lines.push('');
    }
    if (Array.isArray(ins?.open_questions) && ins.open_questions.length) {
      lines.push('## Открытые вопросы');
      ins.open_questions.forEach((q: string) => lines.push(`- ${q}`));
      lines.push('');
    }
    lines.push('## Транскрипт');
    lines.push(rec.transcript_text || '(пусто)');
    return lines.join('\n');
  };

  const downloadBlob = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const onMd = () => {
    downloadBlob(new Blob([buildSummary()], { type: 'text/markdown;charset=utf-8' }), `${safeName}.md`);
    setOpen(false);
  };
  const onTxt = () => {
    const txt = (rec.transcript_text || '').trim() || '(пусто)';
    downloadBlob(new Blob([txt], { type: 'text/plain;charset=utf-8' }), `${safeName}.txt`);
    setOpen(false);
  };
  const onJson = () => {
    const payload = {
      id: rec.id,
      name: baseName(rec.name),
      recorded_at: rec.recorded_at,
      duration_sec: rec.duration_sec,
      size_bytes: rec.size_bytes,
      language: rec.language,
      insights: rec.insights ?? null,
      transcript: rec.transcript_text ?? null,
    };
    downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }), `${safeName}.json`);
    setOpen(false);
  };
  const onAudio = async () => {
    setBusy('audio');
    try {
      const token = await getToken();
      if (!token) throw new Error('Not signed in');
      const res = await fetch(`/api/cloud/audio?id=${rec.id}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`${res.status}`);
      const blob = await res.blob();
      const ext = (rec.content_type?.includes('mpeg') ? 'mp3' : (baseName(rec.name).match(/\.(\w+)$/)?.[1] ?? 'wav'));
      downloadBlob(blob, `${safeName}.${ext}`);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('audio download failed', err);
    } finally {
      setBusy(null);
      setOpen(false);
    }
  };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="rounded-full border border-ink-700 bg-ink-900 px-4 py-1.5 text-xs font-medium text-ink-200 hover:border-accent-500 hover:text-accent-500"
      >
        ↓ Скачать
      </button>
      {open && (
        <div className="absolute right-0 z-20 mt-2 min-w-[180px] overflow-hidden rounded-xl border border-ink-700 bg-ink-950 shadow-glow-accent">
          <MenuItem onClick={onMd} hint=".md">Саммари (Markdown)</MenuItem>
          <MenuItem onClick={onTxt} hint=".txt">Транскрипт (Text)</MenuItem>
          <MenuItem onClick={onJson} hint=".json">Полный JSON</MenuItem>
          <div className="border-t border-ink-800" />
          <MenuItem onClick={onAudio} hint={busy === 'audio' ? '…' : 'audio'} disabled={!!busy}>
            Аудио файл
          </MenuItem>
        </div>
      )}
    </div>
  );
}

function MenuItem({ onClick, children, hint, disabled }: { onClick: () => void | Promise<void>; children: React.ReactNode; hint?: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={() => void onClick()}
      disabled={disabled}
      className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left text-xs text-ink-200 hover:bg-accent-500/10 hover:text-accent-500 disabled:opacity-50"
    >
      <span>{children}</span>
      {hint && <span className="font-mono text-[10px] text-ink-500">{hint}</span>}
    </button>
  );
}

function CloudPane({ rec, getToken }: { rec: CloudRow; getToken: GetToken }) {
  const [copied, setCopied] = useState(false);
  const ins = rec.insights as any;
  const manual = isManual(rec);

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
      <section className="rounded-xl border border-red-900/60 bg-red-950/30 p-5 text-sm text-red-200">
        <h2 className="text-base font-semibold">{baseName(rec.name)}</h2>
        <p className="mt-2 text-xs">{rec.error_message ?? 'Error'}</p>
      </section>
    );
  }

  const sections: { num: string; key: string }[] = [];
  sections.push({ num: '00', key: 'audio' });
  if (Array.isArray(ins?.summary) && ins.summary.length > 0) sections.push({ num: pad(sections.length), key: 'summary' });
  if (Array.isArray(ins?.key_topics) && ins.key_topics.length > 0) sections.push({ num: pad(sections.length), key: 'topics' });
  if (Array.isArray(ins?.open_questions) && ins.open_questions.length > 0) sections.push({ num: pad(sections.length), key: 'questions' });
  if (Array.isArray(ins?.action_items) && ins.action_items.length > 0) sections.push({ num: pad(sections.length), key: 'actions' });
  sections.push({ num: pad(sections.length), key: 'transcript' });
  const numFor = (key: string) => sections.find((s) => s.key === key)?.num ?? '00';

  // Strip the upload_<userId>_<ts>_ prefix for manual uploads to show the user
  // a friendlier title.
  const displayName = manual
    ? baseName(rec.name).replace(/^upload_[A-Za-z0-9]+_\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}_/, '')
    : baseName(rec.name);

  return (
    <section className="rounded-xl border border-ink-800 bg-ink-900/40 p-6">
      <header className="mb-5 flex flex-wrap items-start justify-between gap-3 border-b border-ink-800 pb-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">{displayName}</h2>
          <p className="mt-1.5 flex flex-wrap gap-1.5 text-[11px]">
            <span className="rounded-full border border-accent-500/40 bg-accent-500/10 px-2.5 py-0.5 text-accent-500">
              {manual ? '↑ загрузка' : '☁ облако'}
            </span>
            <span className="rounded-full border border-ink-800 bg-ink-900 px-2.5 py-0.5 text-ink-300">{fmtTime(rec.recorded_at)}</span>
            {rec.duration_sec != null && (
              <span className="rounded-full border border-ink-800 bg-ink-900 px-2.5 py-0.5 text-ink-300">{(rec.duration_sec / 60).toFixed(1)} мин</span>
            )}
            {rec.size_bytes != null && (
              <span className="rounded-full border border-ink-800 bg-ink-900 px-2.5 py-0.5 text-ink-300">{(rec.size_bytes / 1024 / 1024).toFixed(2)} MB</span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={handleCopy} className="rounded-full border border-ink-700 bg-ink-900 px-4 py-1.5 text-xs font-medium text-ink-200 hover:border-accent-500 hover:text-accent-500">
            {copied ? 'Скопировано' : 'Copy'}
          </button>
          <CloudDownloadMenu rec={rec} getToken={getToken} />
        </div>
      </header>

      <div className="space-y-3">
        <Accordion num={numFor('audio')} label="Аудио" defaultOpen accent>
          <AudioPlayer recId={rec.id} getToken={getToken} />
        </Accordion>

        {ins && Array.isArray(ins.summary) && ins.summary.length > 0 && (
          <Accordion num={numFor('summary')} label="Инсайты" defaultOpen>
            <ul className="space-y-2">
              {ins.summary.map((s: string, i: number) => (
                <li key={i} className="flex gap-3 rounded-lg border border-ink-800 bg-ink-900/50 px-4 py-3 text-sm leading-relaxed">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent-500 shadow-glow-accent" />
                  <span>{s}</span>
                </li>
              ))}
            </ul>
          </Accordion>
        )}

        {ins && Array.isArray(ins.key_topics) && ins.key_topics.length > 0 && (
          <Accordion num={numFor('topics')} label="Key topics" defaultOpen={false}>
            <p className="flex flex-wrap gap-1.5">
              {ins.key_topics.map((t: string) => (
                <span key={t} className="rounded-full border border-accent-500/30 bg-accent-500/5 px-2.5 py-1 font-mono text-[11px] text-accent-500">
                  {t}
                </span>
              ))}
            </p>
          </Accordion>
        )}

        {ins && Array.isArray(ins.open_questions) && ins.open_questions.length > 0 && (
          <Accordion num={numFor('questions')} label="Открытые вопросы" defaultOpen={false}>
            <ul className="space-y-1.5">
              {ins.open_questions.map((q: string, i: number) => (
                <li key={i} className="rounded-r-lg border-l-2 border-accent-500 bg-ink-900/50 px-3 py-2 text-sm text-ink-200">
                  <span className="text-accent-500">?</span> {q}
                </li>
              ))}
            </ul>
          </Accordion>
        )}

        {ins && Array.isArray(ins.action_items) && ins.action_items.length > 0 && (
          <Accordion num={numFor('actions')} label="Action items" defaultOpen>
            <ul className="space-y-1.5">
              {ins.action_items.map((a: any, i: number) => (
                <li key={i} className="grid grid-cols-[auto,1fr,auto] items-center gap-3 rounded-lg border border-ink-800 bg-ink-900/50 px-3 py-2.5">
                  <span className="h-4 w-4 rounded border border-ink-700" />
                  <span className="text-sm">{a.action}</span>
                  <span className="font-mono text-[10px] text-accent-500">
                    {a.owner ? `@${a.owner}` : ''}{a.deadline ? ` · ${a.deadline}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          </Accordion>
        )}

        <Accordion num={numFor('transcript')} label="Транскрипт" defaultOpen={false}>
          <TranscriptView text={rec.transcript_text || ''} />
        </Accordion>
      </div>
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

  if (error) return <section className="rounded-xl border border-red-900/60 bg-red-950/30 p-5 text-sm text-red-200">{error}</section>;
  if (!session) return <section className="rounded-xl border border-ink-800 bg-ink-900/40 p-5 text-sm text-ink-400">Загружаем…</section>;

  const transcript = session.chunks.filter((c) => c.status === 'final').map((c) => c.text.trim()).filter(Boolean).join(' ');

  return (
    <section className="rounded-xl border border-ink-800 bg-ink-900/40 p-6">
      <header className="mb-5 flex items-start justify-between gap-3 border-b border-ink-800 pb-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">{new Date(session.createdAt).toLocaleString()}</h2>
          {session.context && <p className="mt-1 text-xs text-ink-400">{session.context}</p>}
        </div>
        <div className="flex items-center gap-1.5 text-xs">
          <button type="button" onClick={handleCopy} className="rounded-full border border-ink-700 bg-ink-900 px-3 py-1.5 hover:border-accent-500 hover:text-accent-500">{copied ? 'Скопировано' : 'Copy MD'}</button>
          <button type="button" onClick={() => exportMarkdown(session)} className="rounded-full border border-ink-700 bg-ink-900 px-3 py-1.5 hover:border-accent-500 hover:text-accent-500">.md</button>
          <button type="button" onClick={() => exportPdf(session)} className="rounded-full border border-ink-700 bg-ink-900 px-3 py-1.5 hover:border-accent-500 hover:text-accent-500">.pdf</button>
          <button type="button" onClick={handleDelete} disabled={busy} className="rounded-full border border-red-900/60 bg-red-950/30 px-3 py-1.5 text-red-200 hover:bg-red-950/50 disabled:opacity-50">{busy ? 'Удаляю…' : 'Удалить'}</button>
        </div>
      </header>

      <div className="space-y-3">
        {session.insight && (
          <>
            <Accordion num="01" label="Инсайты" defaultOpen accent>
              <ul className="space-y-2">
                {session.insight.summary.map((s, i) => (
                  <li key={i} className="flex gap-3 rounded-lg border border-ink-800 bg-ink-900/50 px-4 py-3 text-sm leading-relaxed">
                    <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent-500 shadow-glow-accent" />
                    <span>{s}</span>
                  </li>
                ))}
              </ul>
            </Accordion>
            {session.insight.action_items.length > 0 && (
              <Accordion num="02" label="Action items" defaultOpen>
                <ul className="space-y-1.5">
                  {session.insight.action_items.map((a, i) => (
                    <li key={i} className="grid grid-cols-[auto,1fr,auto] items-center gap-3 rounded-lg border border-ink-800 bg-ink-900/50 px-3 py-2.5">
                      <span className="h-4 w-4 rounded border border-ink-700" />
                      <span className="text-sm">{a.action}</span>
                      <span className="font-mono text-[10px] text-accent-500">{a.owner ? `@${a.owner}` : ''}{a.deadline ? ` · ${a.deadline}` : ''}</span>
                    </li>
                  ))}
                </ul>
              </Accordion>
            )}
            {session.insight.key_topics.length > 0 && (
              <Accordion num="03" label="Key topics" defaultOpen={false}>
                <p className="flex flex-wrap gap-1.5">
                  {session.insight.key_topics.map((t) => (
                    <span key={t} className="rounded-full border border-accent-500/30 bg-accent-500/5 px-2.5 py-1 font-mono text-[11px] text-accent-500">{t}</span>
                  ))}
                </p>
              </Accordion>
            )}
          </>
        )}
        <Accordion num={session.insight ? '04' : '01'} label="Транскрипт" defaultOpen={false}>
          <TranscriptView text={transcript} />
        </Accordion>
      </div>
    </section>
  );
}

function pad(n: number) {
  return n.toString().padStart(2, '0');
}

function baseName(p: string) {
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(i + 1) : p;
}

function fmtTime(s: string | null) {
  if (!s) return '';
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleString();
}
