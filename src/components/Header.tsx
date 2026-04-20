import type { AppView, RecorderState } from '../types';

interface HeaderProps {
  view: AppView;
  onChangeView: (v: AppView) => void;
  recorderState: RecorderState;
  configured: boolean;
  model: string;
}

const TABS: { id: AppView; label: string }[] = [
  { id: 'record', label: 'Запись' },
  { id: 'sessions', label: 'История' },
  { id: 'settings', label: 'Настройки' },
];

export function Header({ view, onChangeView, recorderState, configured, model }: HeaderProps) {
  return (
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-ink-800 bg-ink-950/60 px-5 py-3 backdrop-blur">
      <div className="flex items-center gap-3">
        <Logo />
        <div>
          <div className="text-sm font-semibold tracking-tight">Jarvis</div>
          <div className="text-[11px] text-ink-400">Voice intelligence</div>
        </div>
      </div>

      <nav className="order-3 flex w-full gap-1 md:order-2 md:w-auto">
        {TABS.map((t) => {
          const active = view === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => onChangeView(t.id)}
              className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors md:flex-none ${
                active
                  ? 'bg-ink-800 text-ink-100'
                  : 'text-ink-400 hover:bg-ink-900 hover:text-ink-200'
              }`}
            >
              {t.label}
            </button>
          );
        })}
      </nav>

      <div className="order-2 flex items-center gap-2 text-xs text-ink-400 md:order-3">
        <StatusPill state={recorderState} />
        <ConfigPill configured={configured} model={model} onOpenSettings={() => onChangeView('settings')} />
      </div>
    </header>
  );
}

function Logo() {
  return (
    <div className="flex h-8 w-8 items-center justify-center rounded-md bg-accent-500/20 text-accent-500">
      <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden="true">
        <path
          d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
        <path
          d="M5 11a7 7 0 0 0 14 0M12 18v3"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      </svg>
    </div>
  );
}

function StatusPill({ state }: { state: RecorderState }) {
  const { label, dot } = (() => {
    switch (state) {
      case 'recording':
        return { label: 'Запись', dot: 'bg-red-500 animate-pulseDot' };
      case 'paused':
        return { label: 'Пауза', dot: 'bg-amber-400' };
      case 'stopping':
        return { label: 'Останавливаю…', dot: 'bg-ink-400' };
      default:
        return { label: 'Готов', dot: 'bg-ink-500' };
    }
  })();
  return (
    <span className="flex items-center gap-2 rounded-full border border-ink-800 px-2.5 py-1">
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
      {label}
    </span>
  );
}

function ConfigPill({
  configured,
  model,
  onOpenSettings,
}: {
  configured: boolean;
  model: string;
  onOpenSettings: () => void;
}) {
  if (!configured) {
    return (
      <button
        type="button"
        onClick={onOpenSettings}
        className="rounded-full border border-amber-900/60 bg-amber-950/30 px-2.5 py-1 text-amber-200 hover:bg-amber-950/50"
      >
        Нужны ключи
      </button>
    );
  }
  return (
    <span className="rounded-full border border-ink-800 px-2.5 py-1 font-mono text-[11px]">
      {model}
    </span>
  );
}
