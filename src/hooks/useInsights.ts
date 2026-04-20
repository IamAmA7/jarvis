/**
 * useInsights
 *
 * Calls Claude directly from the browser using the user's own Anthropic key.
 * Requests are debounced (we don't want one call per transcript chunk) and
 * serialized (only one in-flight at a time).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { requestInsights } from '../lib/api';
import type { Settings } from '../lib/settings';
import type { Insight, InsightType, TranscriptChunk } from '../types';

export interface UseInsightsOptions {
  settings: Settings;
  sessionId: string;
  context: string;
  insightTypes?: InsightType[];
  debounceMs?: number;
  minChars?: number;
  growthThreshold?: number;
}

export interface UseInsightsResult {
  insight: Insight | null;
  loading: boolean;
  lastError: string | null;
  observe: (chunks: TranscriptChunk[]) => void;
  regenerate: (chunks: TranscriptChunk[]) => void;
  reset: () => void;
}

export function useInsights(opts: UseInsightsOptions): UseInsightsResult {
  const {
    settings,
    sessionId,
    context,
    insightTypes,
    debounceMs = 4000,
    minChars = 120,
    growthThreshold = 200,
  } = opts;

  const [insight, setInsight] = useState<Insight | null>(null);
  const [loading, setLoading] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);

  const lastRunAtCharsRef = useRef(0);
  const debounceTimerRef = useRef<number | null>(null);
  const inflightRef = useRef<AbortController | null>(null);
  const settingsRef = useRef(settings);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  const run = useCallback(
    async (chunks: TranscriptChunk[]) => {
      const transcript = chunks
        .filter((c) => c.status === 'final')
        .map((c) => c.text)
        .filter(Boolean)
        .join(' ')
        .trim();
      if (transcript.length < minChars) return;

      inflightRef.current?.abort();
      const ac = new AbortController();
      inflightRef.current = ac;
      setLoading(true);
      setLastError(null);
      try {
        const result = await requestInsights(
          {
            transcript,
            context: context || undefined,
            insightTypes,
            sessionId,
            signal: ac.signal,
          },
          settingsRef.current,
        );
        setInsight(result);
        lastRunAtCharsRef.current = transcript.length;
      } catch (err) {
        if ((err as { name?: string })?.name === 'AbortError') return;
        setLastError(err instanceof Error ? err.message : 'Insight generation failed');
      } finally {
        if (inflightRef.current === ac) {
          inflightRef.current = null;
          setLoading(false);
        }
      }
    },
    [context, insightTypes, minChars, sessionId],
  );

  const observe = useCallback(
    (chunks: TranscriptChunk[]) => {
      const transcript = chunks
        .filter((c) => c.status === 'final')
        .map((c) => c.text)
        .filter(Boolean)
        .join(' ');
      const grown = transcript.length - lastRunAtCharsRef.current;
      if (transcript.length < minChars) return;
      if (grown < growthThreshold && insight !== null) return;

      if (debounceTimerRef.current != null) clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = window.setTimeout(() => {
        void run(chunks);
      }, debounceMs);
    },
    [debounceMs, growthThreshold, insight, minChars, run],
  );

  const regenerate = useCallback(
    (chunks: TranscriptChunk[]) => {
      if (debounceTimerRef.current != null) clearTimeout(debounceTimerRef.current);
      void run(chunks);
    },
    [run],
  );

  const reset = useCallback(() => {
    inflightRef.current?.abort();
    inflightRef.current = null;
    if (debounceTimerRef.current != null) clearTimeout(debounceTimerRef.current);
    setInsight(null);
    setLoading(false);
    setLastError(null);
    lastRunAtCharsRef.current = 0;
  }, []);

  useEffect(
    () => () => {
      inflightRef.current?.abort();
      if (debounceTimerRef.current != null) clearTimeout(debounceTimerRef.current);
    },
    [],
  );

  return { insight, loading, lastError, observe, regenerate, reset };
}
