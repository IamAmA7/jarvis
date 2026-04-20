/**
 * Billing — pricing table + current-plan state.
 *
 * Free plan: 60 minutes of transcription per UTC day.
 * Pro plan: unlimited transcription (subject to Stripe settling the invoice).
 *
 * Upgrading opens Stripe Checkout; managing a subscription opens the
 * Stripe-hosted billing portal.
 */
import { useEffect, useState } from 'react';
import {
  openBillingPortal,
  startCheckout,
  type GetToken,
  type UsageSnapshot,
} from '../lib/api';
import { track } from '../lib/telemetry';

interface Props {
  getToken: GetToken;
  usage: UsageSnapshot | null;
  onRefresh: () => void;
}

export function BillingView({ getToken, usage, onRefresh }: Props) {
  const [busy, setBusy] = useState<'checkout' | 'portal' | null>(null);
  const [error, setError] = useState<string | null>(null);

  // If the user just came back from Stripe Checkout, refresh usage so the
  // header + buttons reflect the new plan.
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.get('status') === 'success') {
      track('billing:checkout_success');
      onRefresh();
    } else if (params.get('status') === 'cancel') {
      track('billing:checkout_cancel');
    }
  }, [onRefresh]);

  const plan = usage?.plan ?? 'free';
  const usedMin = usage ? Math.round((usage.usedSec / 60) * 10) / 10 : 0;
  const limitMin = usage?.limitSec ? Math.round(usage.limitSec / 60) : null;

  async function handleCheckout() {
    setBusy('checkout');
    setError(null);
    try {
      const url = await startCheckout(getToken);
      track('billing:checkout_start');
      window.location.href = url;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Checkout failed');
    } finally {
      setBusy(null);
    }
  }

  async function handlePortal() {
    setBusy('portal');
    setError(null);
    try {
      const url = await openBillingPortal(getToken);
      window.location.href = url;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Portal failed');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6">
      <header>
        <h2 className="text-xl font-semibold text-ink-100">Тариф и биллинг</h2>
        <p className="mt-1 text-sm text-ink-400">
          Текущий план: <span className="font-medium text-ink-200">{plan === 'pro' ? 'Pro' : 'Free'}</span>
          {limitMin !== null && (
            <>
              {' '}· использовано сегодня {usedMin} / {limitMin} мин
            </>
          )}
          {limitMin === null && (
            <>
              {' '}· использовано сегодня {usedMin} мин (без лимита)
            </>
          )}
        </p>
      </header>

      {error && (
        <div className="rounded-md border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <PlanCard
          title="Free"
          price="$0"
          bullets={[
            '60 минут транскрипции в день',
            'Все модели Claude для инсайтов',
            'Локальная и облачная история сессий',
            'WebHID push-to-talk',
          ]}
          current={plan === 'free'}
        />
        <PlanCard
          title="Pro"
          price="$15 / мес"
          bullets={[
            'Неограниченная транскрипция',
            'Приоритетная очередь',
            'Streaming Deepgram',
            'Экспорт и облачное хранение',
          ]}
          highlighted
          current={plan === 'pro'}
          action={
            plan === 'pro' ? (
              <button
                className="mt-4 w-full rounded-md bg-ink-700 px-4 py-2 text-sm font-medium text-ink-100 hover:bg-ink-600 disabled:opacity-50"
                onClick={handlePortal}
                disabled={busy !== null}
              >
                {busy === 'portal' ? 'Открываем…' : 'Управлять подпиской'}
              </button>
            ) : (
              <button
                className="mt-4 w-full rounded-md bg-accent-500 px-4 py-2 text-sm font-medium text-ink-950 hover:bg-accent-400 disabled:opacity-50"
                onClick={handleCheckout}
                disabled={busy !== null}
              >
                {busy === 'checkout' ? 'Открываем…' : 'Оформить Pro'}
              </button>
            )
          }
        />
      </div>
    </div>
  );
}

interface PlanCardProps {
  title: string;
  price: string;
  bullets: string[];
  highlighted?: boolean;
  current?: boolean;
  action?: React.ReactNode;
}

function PlanCard({ title, price, bullets, highlighted, current, action }: PlanCardProps) {
  return (
    <div
      className={
        'rounded-xl border p-5 ' +
        (highlighted
          ? 'border-accent-500/40 bg-accent-500/5'
          : 'border-ink-800 bg-ink-900/40')
      }
    >
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold text-ink-100">{title}</h3>
        {current && (
          <span className="rounded-full border border-ink-700 px-2 py-0.5 text-xs text-ink-300">
            текущий
          </span>
        )}
      </div>
      <div className="mt-1 text-2xl font-semibold text-ink-100">{price}</div>
      <ul className="mt-4 space-y-2 text-sm text-ink-300">
        {bullets.map((b) => (
          <li key={b} className="flex gap-2">
            <span className="text-accent-400">•</span>
            <span>{b}</span>
          </li>
        ))}
      </ul>
      {action}
    </div>
  );
}
