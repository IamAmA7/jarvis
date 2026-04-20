/**
 * useTranscription
 *
 * Feeds audio chunks into Whisper directly from the browser using the user's
 * own API key from settings. Concurrency is bounded so slow responses don't
 * reorder transcripts on the page.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { transcribeChunk } from '../lib/api';
import { makeId } from '../lib/ids';
import type { Settings } from '../lib/settings';
import type { TranscriptChunk } from '../types';
import type { AudioChunk } from './useAudioRecorder';

export interface UseTranscriptionOptions {
  settings: Settings;
}

export interface UseTranscriptionResult {
  chunks: TranscriptChunk[];
  pendingCount: number;
  lastError: string | null;
  submit: (audio: AudioChunk) => void;
  clear: () => void;
  abortAll: () => void;
}

export function useTranscription(opts: UseTranscriptionOptions): UseTranscriptionResult {
  const { settings } = opts;
  const [chunks, setChunks] = useState<TranscriptChunk[]>([]);
  const [lastError, setLastError] = useState<string | null>(null);
  const [pendingCount, setPendingCount] = useState(0);

  const inflightRef = useRef<Map<string, AbortController>>(new Map());
  const chunksRef = useRef<TranscriptChunk[]>([]);
  const settingsRef = useRef(settings);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  const setChunksSynced = useCallback(
    (updater: (prev: TranscriptChunk[]) => TranscriptChunk[]) => {
      setChunks((prev) => {
        const next = updater(prev);
        chunksRef.current = next;
        return next;
      });
    },
    [],
  );

  const submit = useCallback(
    (audio: AudioChunk) => {
      if (!audio.hasSpeech) return;

      const id = makeId('t_');
      const ac = new AbortController();
      inflightRef.current.set(id, ac);
      setPendingCount(inflightRef.current.size);

      const placeholder: TranscriptChunk = {
        id,
        capturedAt: audio.capturedAt,
        text: '',
        language: null,
        segments: [],
        status: 'pending',
      };
      setChunksSynced((prev) => [...prev, placeholder]);

      const priorText = chunksRef.current
        .filter((c) => c.status === 'final')
        .map((c) => c.text)
        .join(' ');
      const prompt = priorText.slice(-600) || undefined;

      transcribeChunk(audio.blob, settingsRef.current, { prompt, signal: ac.signal })
        .then((result) => {
          setChunksSynced((prev) =>
            prev.map((c) =>
              c.id === id
                ? {
                    ...c,
                    text: result.text.trim(),
                    language: result.language,
                    segments: result.segments,
                    status: 'final',
                  }
                : c,
            ),
          );
        })
        .catch((err: unknown) => {
          if ((err as { name?: string })?.name === 'AbortError') {
            setChunksSynced((prev) => prev.filter((c) => c.id !== id));
            return;
          }
          const message = err instanceof Error ? err.message : 'Transcription failed';
          setLastError(message);
          setChunksSynced((prev) =>
            prev.map((c) =>
              c.id === id ? { ...c, status: 'error', error: message } : c,
            ),
          );
        })
        .finally(() => {
          inflightRef.current.delete(id);
          setPendingCount(inflightRef.current.size);
        });
    },
    [setChunksSynced],
  );

  const clear = useCallback(() => {
    inflightRef.current.forEach((ac) => ac.abort());
    inflightRef.current.clear();
    setPendingCount(0);
    setChunksSynced(() => []);
    setLastError(null);
  }, [setChunksSynced]);

  const abortAll = useCallback(() => {
    inflightRef.current.forEach((ac) => ac.abort());
    inflightRef.current.clear();
    setPendingCount(0);
  }, []);

  return { chunks, pendingCount, lastError, submit, clear, abortAll };
}
