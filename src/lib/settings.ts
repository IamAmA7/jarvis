/**
 * User settings — model choice, language, UX preferences.
 *
 * API keys are no longer stored client-side: they live on the server as
 * Vercel env vars and are proxied through `/api/*`. What remains is purely
 * user-facing preference: which model to use for insights, which UI
 * language to assume for transcription, whether to cache sessions locally.
 */

const KEY = 'jarvis.settings.v2';

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
  { value: 'auto', label: 'Авто (определить сам)' },
  { value: 'ru', label: 'Русский' },
  { value: 'uk', label: 'Українська' },
  { value: 'en', label: 'English' },
] as const;

export type TranscriptionEngine = 'whisper' | 'deepgram';

export interface Settings {
  model: ClaudeModel;
  /** ISO-639-1 или 'auto'. */
  language: string;
  /** Streaming via Deepgram vs batched Whisper chunks. */
  transcriptionEngine: TranscriptionEngine;
  /** Hold-to-talk via connected WebHID device. */
  pushToTalkEnabled: boolean;
  /** Cache session metadata locally — cloud is always the source of truth. */
  persistSessions: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  model: 'claude-sonnet-4-6',
  language: 'auto',
  transcriptionEngine: 'whisper',
  pushToTalkEnabled: false,
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
      model: isKnownModel(parsed.model) ? parsed.model : DEFAULT_SETTINGS.model,
      transcriptionEngine:
        parsed.transcriptionEngine === 'deepgram' ? 'deepgram' : 'whisper',
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
    /* quota or private mode */
  }
}

export function clearSettings(): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.removeItem(KEY);
}

function isKnownModel(m: unknown): m is ClaudeModel {
  return (
    m === 'claude-sonnet-4-6' ||
    m === 'claude-opus-4-6' ||
    m === 'claude-haiku-4-5-20251001'
  );
}
