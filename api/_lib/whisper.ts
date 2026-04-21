/**
 * Whisper client — shared between /api/transcribe (browser path) and the
 * listener pipeline (/api/ingest → classify). Kept deliberately small so
 * both call sites hit the same retry / size-guard logic.
 */
import { HttpError } from './auth';

const OPENAI_URL = 'https://api.openai.com/v1/audio/transcriptions';
export const WHISPER_MAX_BYTES = 25 * 1024 * 1024;

export interface WhisperSegment {
  start: number;
  end: number;
  text: string;
}

export interface WhisperWord {
  word: string;
  start: number;
  end: number;
}

export interface WhisperResult {
  text: string;
  language: string | null;
  duration: number | null;
  segments: WhisperSegment[];
  words: WhisperWord[];
}

export async function transcribe(
  file: Blob,
  opts: { filename?: string; language?: string; prompt?: string } = {},
): Promise<WhisperResult> {
  if (!file || file.size === 0) throw new HttpError(400, 'Empty audio payload');
  if (file.size > WHISPER_MAX_BYTES) {
    throw new HttpError(413, `Audio chunk too large (${file.size} B). Max ${WHISPER_MAX_BYTES} B.`);
  }
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new HttpError(500, 'OPENAI_API_KEY not configured');

  const form = new FormData();
  form.append('file', file, opts.filename ?? 'chunk.webm');
  form.append('model', 'whisper-1');
  form.append('response_format', 'verbose_json');
  form.append('temperature', '0');
  form.append('timestamp_granularities[]', 'word');
  if (opts.language) form.append('language', opts.language);
  if (opts.prompt) form.append('prompt', opts.prompt.slice(-900));

  const res = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new HttpError(res.status, `Whisper: ${detail.slice(0, 400)}`);
  }
  const data = (await res.json()) as {
    text?: string;
    language?: string;
    duration?: number;
    segments?: Array<{ start: number; end: number; text: string }>;
    words?: Array<{ word: string; start: number; end: number }>;
  };
  return {
    text: (data.text ?? '').trim(),
    language: data.language ?? null,
    duration: typeof data.duration === 'number' ? data.duration : null,
    segments: (data.segments ?? []).map((s) => ({ start: s.start, end: s.end, text: s.text })),
    words: (data.words ?? []).map((w) => ({ word: w.word, start: w.start, end: w.end })),
  };
}
