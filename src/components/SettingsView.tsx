import type { WebHIDState } from '../hooks/useWebHID';
import {
  CLAUDE_MODELS,
  LANGUAGE_OPTIONS,
  clearSettings,
  type Settings,
} from '../lib/settings';

interface SettingsViewProps {
  settings: Settings;
  onChange: (next: Settings) => void;
  onResetEverything: () => void;
  hid: WebHIDState;
}

export function SettingsView({ settings, onChange, onResetEverything, hid }: SettingsViewProps) {
  const update = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    onChange({ ...settings, [key]: value });
  };

  return (
    <div className="mx-auto w-full max-w-2xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Настройки</h1>
        <p className="mt-1 text-sm text-ink-400">
          API-ключи хранятся на сервере как переменные окружения Vercel — в
          браузер ничего чувствительного не попадает. Здесь только ваши
          личные предпочтения.
        </p>
      </header>

      <section className="space-y-4 rounded-lg border border-ink-800 bg-ink-900/40 p-5">
        <h2 className="text-sm font-semibold tracking-tight">Модель и язык</h2>

        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium uppercase tracking-wider text-ink-400">
            Модель Claude
          </span>
          <select
            value={settings.model}
            onChange={(e) => update('model', e.target.value as Settings['model'])}
            className="rounded-md border border-ink-800 bg-ink-900/60 px-3 py-2 text-sm focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500/40"
          >
            {CLAUDE_MODELS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label} — {m.hint}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium uppercase tracking-wider text-ink-400">
            Язык транскрипции
          </span>
          <select
            value={settings.language}
            onChange={(e) => update('language', e.target.value)}
            className="rounded-md border border-ink-800 bg-ink-900/60 px-3 py-2 text-sm focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500/40"
          >
            {LANGUAGE_OPTIONS.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
          </select>
          <span className="text-[11px] text-ink-500">
            Whisper сам разберёт смешанную речь, но явное указание языка иногда даёт
            заметный прирост точности.
          </span>
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium uppercase tracking-wider text-ink-400">
            Движок транскрипции
          </span>
          <select
            value={settings.transcriptionEngine}
            onChange={(e) =>
              update('transcriptionEngine', e.target.value as Settings['transcriptionEngine'])
            }
            className="rounded-md border border-ink-800 bg-ink-900/60 px-3 py-2 text-sm focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500/40"
          >
            <option value="whisper">Whisper (пакетный, после chunk-а)</option>
            <option value="deepgram">Deepgram (streaming, сразу в эфир)</option>
          </select>
          <span className="text-[11px] text-ink-500">
            Deepgram показывает транскрипт на лету, но доступен только на Pro.
          </span>
        </label>
      </section>

      <section className="space-y-4 rounded-lg border border-ink-800 bg-ink-900/40 p-5">
        <h2 className="text-sm font-semibold tracking-tight">Железо</h2>

        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            checked={settings.pushToTalkEnabled}
            onChange={(e) => update('pushToTalkEnabled', e.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-ink-700 bg-ink-900 text-accent-500 focus:ring-accent-500/40"
          />
          <span className="text-sm">
            Включить push-to-talk через USB-устройство
            <span className="block text-[11px] text-ink-500">
              Подключите педаль или программируемую кнопку — нажатие будет
              стартовать/останавливать запись. Требует поддержки WebHID (Chrome,
              Edge, Opera).
            </span>
          </span>
        </label>

        {settings.pushToTalkEnabled && (
          <div className="rounded-md border border-ink-800 bg-ink-950/40 p-3 text-xs">
            {!hid.supported && (
              <p className="text-amber-200">
                Браузер не поддерживает WebHID. Попробуйте Chrome или Edge.
              </p>
            )}
            {hid.supported && hid.deviceName && (
              <div className="flex items-center justify-between gap-2">
                <span>
                  Подключено: <span className="font-medium text-ink-100">{hid.deviceName}</span>
                </span>
                <button
                  type="button"
                  onClick={() => void hid.disconnect()}
                  className="rounded-md border border-ink-800 px-2 py-1 text-ink-300 hover:bg-ink-800"
                >
                  Отключить
                </button>
              </div>
            )}
            {hid.supported && !hid.deviceName && (
              <button
                type="button"
                onClick={() => void hid.connect()}
                className="rounded-md bg-accent-500 px-3 py-1.5 font-medium text-white hover:bg-accent-600"
              >
                Подключить устройство
              </button>
            )}
            {hid.error && <p className="mt-2 text-red-300">{hid.error}</p>}
          </div>
        )}
      </section>

      <section className="space-y-4 rounded-lg border border-ink-800 bg-ink-900/40 p-5">
        <h2 className="text-sm font-semibold tracking-tight">Приватность</h2>

        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            checked={settings.persistSessions}
            onChange={(e) => update('persistSessions', e.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-ink-700 bg-ink-900 text-accent-500 focus:ring-accent-500/40"
          />
          <span className="text-sm">
            Кэшировать последние сессии в браузере
            <span className="block text-[11px] text-ink-500">
              История сессий всегда хранится в облаке (Supabase). Кэш даёт
              мгновенный доступ офлайн и помещается в localStorage.
            </span>
          </span>
        </label>

        <div className="flex gap-2 pt-2">
          <button
            type="button"
            onClick={() => {
              clearSettings();
              onResetEverything();
            }}
            className="rounded-md border border-red-900/60 bg-red-950/30 px-3 py-1.5 text-sm text-red-200 hover:bg-red-950/50"
          >
            Сбросить настройки
          </button>
        </div>
      </section>
    </div>
  );
}
