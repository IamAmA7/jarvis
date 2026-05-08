import type { AppView, RecorderState } from '../types';

interface HeaderProps {
  view: AppView;
  onChangeView: (v: AppView) => void;
  recorderState: RecorderState;
  userName: string | null;
  userEmail: string | null;
  onSignOut: () => void;
}

const TABS: { id: AppView; label: string }[] = [
  { id: 'record', label: 'Запись' },
  { id: 'sessions', label: 'История' },
  { id: 'billing', label: 'Тариф' },
  { id: 'access', label: 'Доступы' },
];

export function Header({
  view,
  onChangeView,
  recorderState,
  userName,
  userEmail,
  onSignOut,
}: HeaderProps) {
  return (
    <header className="sticky top-0 z-20 flex flex-wrap items-center justify-between gap-2 border-b border-ink-800 bg-black/85 px-3 py-3 backdrop-blur-md sm:gap-3 sm:px-6 sm:py-4">
      <button
        type="button"
        onClick={() => onChangeView('record')}
        className="flex items-center gap-3 rounded-lg p-1 -m-1 hover:bg-ink-900/40 transition-colors focus:outline-none focus:ring-2 focus:ring-accent-500/50"
        aria-label="На главную"
      >
        <Logo />
        <div className="text-left">
          <div className="text-base font-bold tracking-tight">Jarvis</div>
          <div className="kicker text-[10px] text-ink-400">Voice Intelligence</div>
        </div>
      </button>

      <nav className="order-3 flex w-full gap-1 md:order-2 md:w-auto">
        {TABS.map((t) => {
          const active = view === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => onChangeView(t.id)}
              className={`flex-1 rounded-full px-2.5 py-2 text-xs font-medium transition-all sm:px-4 sm:text-sm md:flex-none ${
                active
                  ? 'bg-accent-500 text-black shadow-glow-accent'
                  : 'text-ink-400 hover:bg-ink-800 hover:text-ink-100'
              }`}
            >
              {t.label}
            </button>
          );
        })}
      </nav>

      <div className="order-2 flex items-center gap-2 text-xs md:order-3">
        <StatusPill state={recorderState} />
        <UserMenu name={userName} email={userEmail} onSignOut={onSignOut} onOpenSettings={() => onChangeView('settings')} />
      </div>
    </header>
  );
}

function Logo() {
  return (
    <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent-500 text-black shadow-glow-accent">
      <span className="text-base font-extrabold leading-none">J</span>
    </div>
  );
}

function StatusPill({ state }: { state: RecorderState }) {
  const { label, dotClass, ready } = (() => {
    switch (state) {
      case 'recording':
        return { label: 'Запись', dotClass: 'bg-red-500 animate-pulseDot', ready: false };
      case 'paused':
        return { label: 'Пауза', dotClass: 'bg-amber-400', ready: false };
      case 'stopping':
        return { label: 'Останавливаю…', dotClass: 'bg-ink-400', ready: false };
      default:
        return { label: 'Готов', dotClass: '', ready: true };
    }
  })();
  return (
    <span className="flex items-center gap-2 rounded-full border border-ink-800 bg-ink-900 px-3 py-1.5 text-ink-200">
      {ready ? (
        <span className="dot-accent" />
      ) : (
        <span className={`h-1.5 w-1.5 rounded-full ${dotClass}`} />
      )}
      {label}
    </span>
  );
}


function UserMenu({
  name,
  email,
  onSignOut,
  onOpenSettings,
}: {
  name: string | null;
  email: string | null;
  onSignOut: () => void;
  onOpenSettings: () => void;
}) {
  const label = name ?? email ?? 'Аккаунт';
  const initials = (label.match(/\b[\p{L}\p{N}]/gu) ?? ['?']).slice(0, 2).join('').toUpperCase();
  return (
    <div className="group relative">
      <button
        type="button"
        className="flex h-9 w-9 items-center justify-center rounded-full bg-accent-500 text-xs font-bold text-black shadow-glow-accent hover:opacity-90"
        aria-haspopup="menu"
        title={truncate(label, 32)}
      >
        {initials}
      </button>
      <div className="invisible absolute right-0 top-full z-20 mt-2 w-56 rounded-xl border border-ink-800 bg-ink-900 py-1 opacity-0 shadow-2xl transition-opacity group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100">
        <div className="border-b border-ink-800 px-3 py-2.5">
          <div className="text-sm font-medium text-ink-100">{truncate(label, 28)}</div>
          {email && email !== label && (
            <div className="text-[11px] text-ink-400" title={email}>
              {truncate(email, 30)}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={onOpenSettings}
          className="block w-full px-3 py-2 text-left text-xs text-ink-300 hover:bg-ink-800 hover:text-ink-100"
        >
          Настройки
        </button>
        <button
          type="button"
          onClick={onSignOut}
          className="block w-full border-t border-ink-800 px-3 py-2 text-left text-xs text-ink-300 hover:bg-ink-800 hover:text-ink-100"
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
