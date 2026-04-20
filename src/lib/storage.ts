/**
 * Local session storage — persists the last N sessions in localStorage.
 *
 * Respects the user's `persistSessions` setting: when disabled, we no-op and
 * clear anything already on disk.
 */
import type { Session } from '../types';

const KEY = 'jarvis.sessions.v1';
const MAX_SESSIONS = 5;

export function loadSessions(): Session[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Session[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveSession(session: Session, enabled = true): void {
  if (typeof localStorage === 'undefined') return;
  if (!enabled) {
    clearSessions();
    return;
  }
  try {
    const existing = loadSessions().filter((s) => s.id !== session.id);
    const next = [session, ...existing].slice(0, MAX_SESSIONS);
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* quota / private mode — best effort */
  }
}

export function deleteSession(id: string): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const next = loadSessions().filter((s) => s.id !== id);
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
}

export function clearSessions(): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.removeItem(KEY);
}
