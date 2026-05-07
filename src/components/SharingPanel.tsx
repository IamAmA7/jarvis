import { useCallback, useEffect, useState } from 'react';
import type { GetToken } from '../lib/api';

interface Grant {
  id: number;
  shared_with_email: string;
  created_at: string;
  revoked_at: string | null;
}

export function SharingPanel({ getToken }: { getToken: GetToken }) {
  const [grants, setGrants] = useState<Grant[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  const fetchGrants = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const token = await getToken();
      if (!token) throw new Error('Не авторизованы');
      const r = await fetch('/api/cloud/access', {
        headers: { Authorization: 'Bearer ' + token },
      });
      if (!r.ok) {
        const d = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(d.error ?? ('HTTP ' + r.status));
      }
      const data = (await r.json()) as { grants: Grant[] };
      setGrants(data.grants ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [getToken]);

  useEffect(() => {
    void fetchGrants();
  }, [fetchGrants]);

  const addGrant = async (ev: React.FormEvent) => {
    ev.preventDefault();
    if (!email.trim()) return;
    setBusy(true);
    setError(null);
    setFlash(null);
    try {
      const token = await getToken();
      if (!token) throw new Error('Не авторизованы');
      const r = await fetch('/api/cloud/access', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + token,
        },
        body: JSON.stringify({ email: email.trim() }),
      });
      const d = (await r.json().catch(() => ({}))) as { error?: string; status?: string };
      if (!r.ok) throw new Error(d.error ?? ('HTTP ' + r.status));
      setEmail('');
      const msg = d.status === 'already_active' ? 'Доступ уже был открыт' : d.status === 'reactivated' ? 'Доступ восстановлен' : 'Доступ открыт';
      setFlash(msg);
      void fetchGrants();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id: number) => {
    if (!confirm('Отозвать доступ? Юзер перестанет видеть твои облачные записи.')) return;
    try {
      const token = await getToken();
      if (!token) return;
      const r = await fetch('/api/cloud/access?id=' + id, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer ' + token },
      });
      if (!r.ok) {
        const d = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(d.error ?? ('HTTP ' + r.status));
      }
      setFlash('Доступ отозван');
      void fetchGrants();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="mx-auto w-full max-w-3xl">
      <h1 className="mb-2 text-2xl font-semibold text-ink-100">Доступы</h1>
      <p className="mb-6 text-sm text-ink-400">
        Открой доступ к своим облачным записям другим пользователям по email. Они увидят все
        текущие и будущие записи в разделе «Облако» (загрузки в «Облако» — не шарятся).
      </p>

      <form onSubmit={addGrant} className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex-1">
          <label htmlFor="share-email" className="mb-1 block text-xs uppercase tracking-wider text-ink-400">
            Email пользователя
          </label>
          <input
            id="share-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="name@example.com"
            required
            disabled={busy}
            className="w-full rounded-lg border border-ink-800 bg-ink-900/40 px-3 py-2 text-sm text-ink-100 placeholder:text-ink-500 focus:border-accent-500 focus:outline-none"
          />
        </div>
        <button
          type="submit"
          disabled={busy || !email.trim()}
          className="rounded-full bg-accent-500 px-5 py-2 text-sm font-semibold text-black shadow-glow-accent hover:opacity-90 disabled:opacity-50"
        >
          {busy ? 'Сохраняю…' : '+ Открыть доступ'}
        </button>
      </form>

      {flash && (
        <div className="mb-3 rounded-md border border-accent-500/40 bg-accent-500/10 px-3 py-2 text-xs text-accent-500">
          ✓ {flash}
        </div>
      )}
      {error && (
        <div className="mb-3 rounded-md border border-red-900/60 bg-red-950/30 px-3 py-2 text-xs text-red-200">
          {error}
        </div>
      )}

      <div className="rounded-lg border border-ink-800 bg-ink-900/40">
        <div className="border-b border-ink-800 px-4 py-3 text-xs font-medium uppercase tracking-wider text-ink-400">
          Кому открыт доступ
        </div>
        {loading ? (
          <div className="px-4 py-6 text-sm text-ink-400">Загружаю…</div>
        ) : grants.length === 0 ? (
          <div className="px-4 py-6 text-sm text-ink-400">
            Никому. Введите email выше, чтобы поделиться.
          </div>
        ) : (
          <ul className="divide-y divide-ink-800">
            {grants.map((g) => (
              <li key={g.id} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <div className="truncate text-sm text-ink-100">{g.shared_with_email}</div>
                  <div className="text-[11px] text-ink-500">
                    доступ с {new Date(g.created_at).toLocaleDateString('ru-RU')}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void revoke(g.id)}
                  className="shrink-0 rounded-full border border-ink-800 px-3 py-1 text-xs text-ink-300 hover:border-red-900/60 hover:bg-red-950/30 hover:text-red-200"
                >
                  Отозвать
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}