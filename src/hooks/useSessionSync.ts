/**
 * useSessionSync
 *
 * Mirrors the live session into Supabase as transcript chunks arrive. The
 * remote row is created lazily on the first non-empty diff so we don't
 * allocate a row for sessions the user abandons before saying anything.
 *
 * Sync is debounced (2s) and idempotent (we keyed segments by `idx` on the
 * server). The final `insight` snapshot is pushed whenever it changes.
 */
import { useEffect, useRef } from 'react';
import {
  createSession,
  patchSession,
  type GetToken,
  type SessionRow,
} from '../lib/api';
import { captureError } from '../lib/telemetry';
import type { Session, TranscriptChunk } from '../types';

interface Options {
  getToken: GetToken;
  session: Session;
  enabled: boolean;
  debounceMs?: number;
}

export function useSessionSync({ getToken, session, enabled, debounceMs = 2000 }: Options) {
  const remoteIdRef = useRef<string | null>(null);
  const lastSyncedIdxRef = useRef<number>(-1);
  const lastInsightRef = useRef<string>('');
  const timerRef = useRef<number | null>(null);
  const tokenRef = useRef(getToken);
  useEffect(() => {
    tokenRef.current = getToken;
  }, [getToken]);

  // Reset remote id when a new local session starts.
  useEffect(() => {
    remoteIdRef.current = null;
    lastSyncedIdxRef.current = -1;
    lastInsightRef.current = '';
  }, [session.id]);

  useEffect(() => {
    if (!enabled) return undefined;

    const hasWork = session.chunks.some((c) => c.status === 'final') || session.insight !== null;
    if (!hasWork) return undefined;

    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      void sync();
    }, debounceMs);

    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };

    async function sync() {
      try {
        let remote: SessionRow | null = null;
        if (!remoteIdRef.current) {
          const createdRow = await createSession(tokenRef.current, {
            title: buildTitle(session.chunks),
            context: session.context,
          });
          remoteIdRef.current = createdRow.id;
          remote = createdRow;
        }
        const id = remoteIdRef.current!;

        const newSegments = toSegments(session.chunks).filter(
          (s) => s.idx > lastSyncedIdxRef.current,
        );
        const insightJson = session.insight ? JSON.stringify(session.insight) : '';
        const insightChanged = insightJson !== lastInsightRef.current;

        if (newSegments.length === 0 && !insightChanged && remote) return;

        await patchSession(tokenRef.current, id, {
          title: buildTitle(session.chunks),
          context: session.context,
          segments: newSegments,
          duration_sec: estimateDuration(session.chunks),
          ...(insightChanged && session.insight ? { insight: session.insight } : {}),
        });

        if (newSegments.length > 0) {
          lastSyncedIdxRef.current = newSegments[newSegments.length - 1].idx;
        }
        if (insightChanged) lastInsightRef.current = insightJson;
      } catch (err) {
        captureError(err, { where: 'useSessionSync.sync', sessionId: session.id });
      }
    }
  }, [enabled, session, debounceMs]);
}

function buildTitle(chunks: TranscriptChunk[]): string {
  const first = chunks.find((c) => c.status === 'final')?.text ?? '';
  const trimmed = first.trim().slice(0, 80);
  return trimmed || 'Untitled session';
}

function estimateDuration(chunks: TranscriptChunk[]): number {
  const last = chunks.at(-1);
  if (!last) return 0;
  const segEnd = last.segments.at(-1)?.end ?? 0;
  return Math.round(segEnd);
}

function toSegments(chunks: TranscriptChunk[]) {
  const out: { idx: number; start: number; end: number; text: string }[] = [];
  let i = 0;
  for (const c of chunks) {
    if (c.status !== 'final') continue;
    const segs = c.segments.length > 0 ? c.segments : [{ start: 0, end: 0, text: c.text }];
    for (const s of segs) {
      out.push({ idx: i++, start: s.start, end: s.end, text: s.text });
    }
  }
  return out;
}
