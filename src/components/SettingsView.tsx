import { useState } from 'react';
import { testAnthropicKey, testOpenAIKey } from '../lib/api';
import {
  CLAUDE_MODELS,
  LANGUAGE_OPTIONS,
  clearSettings,
  validateKeyShape,
  type Settings,
} from '../lib/settings';

interface SettingsViewProps {
  settings: Settings;
  onChange: (next: Settings) => void;
  onResetEverything: () => void;
}

type TestStatus = 'idle' | 'pending' | 'ok' | 'error';

export function SettingsView({ settings, onChange, onResetEverything }: SettingsViewProps) {
  const [openaiStatus, setOpenaiStatus] = useState<TestStatus>('idle');
  const [anthropicStatus, setAnthropicStatus] = useState<TestStatus>('idle');
  const [openaiError, setOpenaiError] = useState<string | null>(null);
  const [anthropicError, setAnthropicError] = useState<string | null>(null);
  const [showOpenAI, setShowOpenAI] = useState(false);
  const [showAnthropic, setShowAnthropic] = useState(false);

  const update = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    onChange({ ...settings, [key]: value });
  };

  const testOpenAI = async () => {
    const validationError = validateKeyShape('openai', settings.openaiApiKey);
    if (validationError) {
      setOpenaiStatus('error');
      setOpenaiError(validationError);
      return;
    }
    setOpenaiStatus('pending');
    setOpenaiError(null);
    try {
      await testOpenAIKey(settings.openaiApiKey);
      setOpenaiStatus('ok');
    } catch (err) {
      setOpenaiStatus('error');
      setOpenaiError(err instanceof Error ? err.message : 'Не удалось проверить ключ');
    }
  };

  const testAnthropic = async () => {
    const validationError = validateKeyShape('anthropic', settings.anthropicApiKey);
    if (validationError) {
      setAnthropicStatus('error');
      setAnthropicError(validationError);
      return;
    }
    setAnthropicStatus('pending');
    setAnthropicError(null);
    try {
      await testAnthropicKey(settings.anthropicApiKey, settings.model);
      setAnthropicStatus('ok');
    } catch (err) {
      setAnthropicStatus('error');
      setAnthropicError(err instanceof Error ? err.message : 'Не удалось проверить ключ');
    }
  };

  return (
    <div className="mx-auto w-full max-w-2xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Настройки</h1>
        <p className="mt-1 text-sm text-ink-400">
          Ключи хранятся только в вашем браузере (localStorage). Запросы идут напрямую
          к OpenAI и Anthropic — ничего не проходит через наши серверы.
        </p>
      </header>

      <section className="space-y-4 rounded-lg border border-ink-800 bg-ink-900/40 p-5">
        <h2 className="text-sm font-semibold tracking-tight">API-ключи</h2>

        <KeyField
          label="OpenAI API key (Whisper)"
          helper="Получить можно здесь: platform.openai.com/api-keys"
          value={settings.openaiApiKey}
          onChange={(v) => {
            update('openaiApiKey', v);
            setOpenaiStatus('idle');
          }}
          reveal={showOpenAI}
          onToggleReveal={() => setShowOpenAI((s) => !s)}
          placeholder="sk-..."
          status={openaiStatus}
          error={openaiError}
          onTest={testOpenAI}
        />

        <KeyField
          label="Anthropic API key (Claude)"
          helper="Получить: console.anthropic.com/settings/keys"
          value={settings.anthropicApiKey}
          onChange={(v) => {
            update('anthropicApiKey', v);
            setAnthropicStatus('idle');
          }}
          reveal={showAnthropic}
          onToggleReveal={() => setShowAnthropic((s) => !s)}
          placeholder="sk-ant-..."
          status={anthropicStatus}
          error={anthropicError}
          onTest={testAnthropic}
        />
      </section>

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
            Сохранять историю сессий в браузере
            <span className="block text-[11px] text-ink-500">
              Хранится последние 5 сессий в localStorage. Отключите — и ничего не
              останется после перезагрузки.
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
            Удалить все ключи и сессии
          </button>
        </div>
      </section>
    </div>
  );
}

interface KeyFieldProps {
  label: string;
  helper: string;
  value: string;
  onChange: (v: string) => void;
  reveal: boolean;
  onToggleReveal: () => void;
  placeholder: string;
  status: TestStatus;
  error: string | null;
  onTest: () => void;
}

function KeyField({
  label,
  helper,
  value,
  onChange,
  reveal,
  onToggleReveal,
  placeholder,
  status,
  error,
  onTest,
}: KeyFieldProps) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium uppercase tracking-wider text-ink-400">
        {label}
      </span>
      <div className="flex gap-2">
        <input
          type={reveal ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
          className="flex-1 rounded-md border border-ink-800 bg-ink-900/60 px-3 py-2 font-mono text-sm focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500/40"
        />
        <button
          type="button"
          onClick={onToggleReveal}
          className="rounded-md border border-ink-800 px-3 py-2 text-xs text-ink-300 hover:bg-ink-800/60"
        >
          {reveal ? 'Скрыть' : 'Показать'}
        </button>
        <button
          type="button"
          onClick={onTest}
          disabled={status === 'pending' || !value}
          className="rounded-md bg-accent-500 px-3 py-2 text-xs font-medium text-white hover:bg-accent-600 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {status === 'pending' ? 'Проверяю…' : 'Проверить'}
        </button>
      </div>
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-ink-500">{helper}</span>
        <StatusLabel status={status} error={error} />
      </div>
    </label>
  );
}

function StatusLabel({ status, error }: { status: TestStatus; error: string | null }) {
  if (status === 'ok') return <span className="text-[11px] text-emerald-400">✓ Ключ работает</span>;
  if (status === 'error')
    return (
      <span className="max-w-[60%] truncate text-[11px] text-red-400" title={error ?? ''}>
        ✕ {error}
      </span>
    );
  return null;
}
