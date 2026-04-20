import type { UsageSnapshot } from '../lib/api';
import type { AppView, RecorderState } from '../types';

interface HeaderProps {
  view: AppView;
  onChangeView: (v: AppView) => void;
  recorderState: RecorderState;
  model: string;
  userName: string | null;
  userEmail: string | null;
  usage: UsageSnapshot | null;
  onSignOut: () => void;
}

const TABS: { id: AppView; label: string }[] = [
  { id: 'record', label: 'Запись' },
  { id: 'sessions', label: 'История' },
  { id: 'billing', label: 'Тариф' },
  { id: 'settings', label: 'Настройки' },
];

export function Header({
  view,
  onChangeView,
  recorderState,
  model,
  userName,
  userEmail,
  usage,
  onSignOut,
}: HeaderProps) {
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
        <UsagePill usage={usage} onClick={() => onChangeView('billing')} />
        <ModelPill model={model} />
        <UserMenu name={userName} email={userEmail} onSignOut={onSignOut} />
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

function UsagePill({ usage, onClick }: { usage: UsageSnapshot | null; onClick: () => void }) {
  if (!usage) return null;
  if (usage.plan === 'pro') {
    return (
      <button
        type="button"
        onClick={onClick}
        className="rounded-full border border-accent-500/30 bg-accent-500/10 px-2.5 py-1 text-accent-300 hover:bg-accent-500/20"
      >
        Pro
      </button>
    );
  }
  const used = Math.round((usage.usedSec / 60) * 10) / 10;
  const limit = usage.limitSec ? Math.round(usage.limitSec / 60) : '∞';
  const warn = !usage.allowed;
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'rounded-full border px-2.5 py-1 font-mono text-[11px] ' +
        (warn
          ? 'border-red-900/60 bg-red-950/30 text-red-200 hover:bg-red-950/50'
          : 'border-ink-800 hover:bg-ink-900')
      }
    >
      {used}/{limit} мин
    </button>
  );
}

function ModelPill({ model }: { model: string }) {
  return (
    <span className="hidden rounded-full border border-ink-800 px-2.5 py-1 font-mono text-[11px] md:inline-block">
      {model}
    </span>
  );
}

function UserMenu({
  name,
  email,
  onSignOut,
}: {
  name: string | null;
  email: string | null;
  onSignOut: () => void;
}) {
  const label = name ?? email ?? 'Аккаунт';
  return (
    <div className="group relative">
      <button
        type="button"
        className="rounded-full border border-ink-800 bg-ink-900 px-3 py-1 text-ink-200 hover:bg-ink-800"
        aria-haspopup="menu"
      >
        {truncate(label, 18)}
      </button>
      <div className="invisible absolute right-0 top-full z-20 mt-1 w-48 rounded-md border border-ink-800 bg-ink-950 py-1 opacity-0 shadow-lg transition-opacity group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100">
        {email && (
          <div className="border-b border-ink-800 px-3 py-2 text-[11px] text-ink-400" title={email}>
            {truncate(email, 28)}
          </div>
        )}
        <button
          type="button"
          onClick={onSignOut}
          className="block w-full px-3 py-1.5 text-left text-xs text-ink-300 hover:bg-ink-900 hover:text-ink-100"
        >
          Выйти
        </button>
      </div>
    </div>
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
