/**
 * useUsage
 *
 * Polls `/api/usage` every 30s while the tab is visible so the header can
 * render the current burn-down and gate the start-recording button when the
 * free-tier quota is exhausted. Also exposes a `refresh()` for manual bumps
 * (e.g. after a successful checkout).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchUsage, type GetToken, type UsageSnapshot } from '../lib/api';

interface Options {
  getToken: GetToken;
  enabled: boolean;
  intervalMs?: number;
}

export function useUsage({ getToken, enabled, intervalMs = 30_000 }: Options) {
  const [snapshot, setSnapshot] = useState<UsageSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tokenRef = useRef(getToken);
  useEffect(() => {
    tokenRef.current = getToken;
  }, [getToken]);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    try {
      const snap = await fetchUsage(tokenRef.current);
      setSnapshot(snap);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Usage unavailable');
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return undefined;
    void refresh();
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, intervalMs);
    return () => window.clearInterval(id);
  }, [enabled, intervalMs, refresh]);

  return { snapshot, error, refresh };
}
