import type { ReactNode } from 'react';

interface StatusBarProps {
  missingOpenAI: boolean;
  missingAnthropic: boolean;
  lastError?: string | null;
  onOpenSettings: () => void;
}

export function StatusBar({
  missingOpenAI,
  missingAnthropic,
  lastError,
  onOpenSettings,
}: StatusBarProps) {
  if (missingOpenAI || missingAnthropic) {
    const missing: string[] = [];
    if (missingOpenAI) missing.push('OpenAI');
    if (missingAnthropic) missing.push('Anthropic');
    return (
      <Banner tone="warn">
        Нужны ключи: {missing.join(' и ')}.{' '}
        <button
          type="button"
          onClick={onOpenSettings}
          className="font-medium underline underline-offset-2 hover:text-amber-100"
        >
          Открыть настройки
        </button>
      </Banner>
    );
  }
  if (lastError) {
    return <Banner tone="error">{lastError}</Banner>;
  }
  return null;
}

function Banner({ tone, children }: { tone: 'error' | 'warn'; children: ReactNode }) {
  const cls =
    tone === 'error'
      ? 'border-red-900/60 bg-red-950/40 text-red-200'
      : 'border-amber-900/60 bg-amber-950/30 text-amber-200';
  return <div className={`rounded-md border px-3 py-2 text-sm ${cls}`}>{children}</div>;
}
