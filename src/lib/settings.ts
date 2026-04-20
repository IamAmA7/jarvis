/**
 * User settings — API keys, model choice, language preferences.
 *
 * Everything is stored in localStorage. No backend is involved. Keys never
 * leave the user's browser (except of course in the outbound HTTPS calls to
 * OpenAI and Anthropic).
 */

const KEY = 'jarvis.settings.v1';

export type ClaudeModel =
  | 'claude-sonnet-4-6'
  | 'claude-opus-4-6'
  | 'claude-haiku-4-5-20251001';

export const CLAUDE_MODELS: { value: ClaudeModel; label: string; hint: string }[] = [
  {
    value: 'claude-sonnet-4-6',
    label: 'Sonnet 4.6',
    hint: 'Рекомендуется. Быстрая, точная, дешёвая.',
  },
  {
    value: 'claude-opus-4-6',
    label: 'Opus 4.6',
    hint: 'Максимальное качество. Дороже и медленнее.',
  },
  {
    value: 'claude-haiku-4-5-20251001',
    label: 'Haiku 4.5',
    hint: 'Самая быстрая и дешёвая. Хороша для коротких встреч.',
  },
];

export const LANGUAGE_OPTIONS = [
  { value: '', label: 'Авто (определить сам)' },
  { value: 'ru', label: 'Русский' },
  { value: 'uk', label: 'Українська' },
  { value: 'en', label: 'English' },
] as const;

export interface Settings {
  openaiApiKey: string;
  anthropicApiKey: string;
  model: ClaudeModel;
  /** ISO-639-1. Пустая строка = автоопределение Whisper. */
  language: string;
  /** Сохранять сессии в localStorage (иначе только в памяти). */
  persistSessions: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  openaiApiKey: '',
  anthropicApiKey: '',
  model: 'claude-sonnet-4-6',
  language: '',
  persistSessions: true,
};

export function loadSettings(): Settings {
  if (typeof localStorage === 'undefined') return { ...DEFAULT_SETTINGS };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      // Narrow model to a known value in case an old build saved something stale.
      model: isKnownModel(parsed.model) ? parsed.model : DEFAULT_SETTINGS.model,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(next: Settings): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // quota or private mode — best effort
  }
}

export function clearSettings(): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.removeItem(KEY);
}

export function isConfigured(s: Settings): boolean {
  return s.openaiApiKey.trim().length > 0 && s.anthropicApiKey.trim().length > 0;
}

/** Safe heuristic check for obviously-malformed keys. */
export function validateKeyShape(
  provider: 'openai' | 'anthropic',
  key: string,
): string | null {
  const k = key.trim();
  if (!k) return 'Ключ не указан.';
  if (provider === 'openai' && !k.startsWith('sk-')) {
    return 'OpenAI ключ должен начинаться с "sk-".';
  }
  if (provider === 'anthropic' && !k.startsWith('sk-ant-')) {
    return 'Anthropic ключ должен начинаться с "sk-ant-".';
  }
  if (k.length < 20) return 'Ключ слишком короткий.';
  return null;
}

function isKnownModel(m: unknown): m is ClaudeModel {
  return (
    m === 'claude-sonnet-4-6' ||
    m === 'claude-opus-4-6' ||
    m === 'claude-haiku-4-5-20251001'
  );
}
