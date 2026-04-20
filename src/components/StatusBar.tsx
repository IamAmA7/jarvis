import type { ReactNode } from 'react';

interface StatusBarProps {
  lastError?: string | null;
  quotaExceeded: boolean;
  hidDeviceName: string | null;
  onOpenSettings: () => void;
  onOpenBilling: () => void;
}

export function StatusBar({
  lastError,
  quotaExceeded,
  hidDeviceName,
  onOpenSettings,
  onOpenBilling,
}: StatusBarProps) {
  if (quotaExceeded) {
    return (
      <Banner tone="warn">
        Дневной лимит Free-тарифа исчерпан.{' '}
        <button
          type="button"
          onClick={onOpenBilling}
          className="font-medium underline underline-offset-2 hover:text-amber-100"
        >
          Оформить Pro
        </button>
      </Banner>
    );
  }
  if (lastError) {
    return <Banner tone="error">{lastError}</Banner>;
  }
  if (hidDeviceName) {
    return (
      <Banner tone="info">
        HID подключён: <span className="font-medium">{hidDeviceName}</span>.{' '}
        <button
          type="button"
          onClick={onOpenSettings}
          className="underline underline-offset-2 hover:text-ink-50"
        >
          настроить
        </button>
      </Banner>
    );
  }
  return null;
}

function Banner({ tone, children }: { tone: 'error' | 'warn' | 'info'; children: ReactNode }) {
  const cls =
    tone === 'error'
      ? 'border-red-900/60 bg-red-950/40 text-red-200'
      : tone === 'warn'
        ? 'border-amber-900/60 bg-amber-950/30 text-amber-200'
        : 'border-ink-800 bg-ink-900/60 text-ink-200';
  return <div className={`rounded-md border px-3 py-2 text-sm ${cls}`}>{children}</div>;
}
