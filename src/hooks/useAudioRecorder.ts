/**
 * useAudioRecorder
 *
 * Captures browser mic audio and emits independently-decodable chunks on a
 * fixed interval. Each chunk is a complete WebM/Opus blob that can be POSTed
 * straight to Whisper.
 *
 * Implementation notes:
 *   - MediaRecorder's timeslice feature produces chunks that only decode when
 *     concatenated with the header. Instead we stop() and start() a fresh
 *     recorder on every interval. The gap is ~20-40 ms which is fine for VI.
 *   - An AnalyserNode runs in parallel to power both the waveform visualizer
 *     and energy-based VAD (see lib/vad.ts).
 *   - Permission errors surface through `error`. The caller shows a banner.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { EnergyVad, rmsFromTimeDomain } from '../lib/vad';
import type { RecorderState } from '../types';

export interface AudioChunk {
  blob: Blob;
  mimeType: string;
  /** Average RMS over the chunk window, 0..1. */
  averageRms: number;
  /** True if our VAD thinks this chunk contains speech. */
  hasSpeech: boolean;
  /** Wall-clock capture time (ms since epoch). */
  capturedAt: number;
  /** Duration of the chunk in ms (best-effort — wall clock, not decoded). */
  durationMs: number;
}

export interface UseAudioRecorderOptions {
  /** Chunk length in milliseconds. 3000-4000 is the sweet spot for Whisper. */
  chunkMs?: number;
  /** Called for each finalized chunk. */
  onChunk?: (chunk: AudioChunk) => void;
  /** Called whenever the recorder state transitions. */
  onStateChange?: (state: RecorderState) => void;
}

export interface UseAudioRecorderResult {
  state: RecorderState;
  /** 0..1, current mic level for UI visualizers. */
  level: number;
  /** Nullable error from the last permission / capture attempt. */
  error: string | null;
  /** Whether the browser supports MediaRecorder + getUserMedia. */
  supported: boolean;
  start: () => Promise<void>;
  pause: () => void;
  resume: () => void;
  stop: () => void;
}

const DEFAULT_CHUNK_MS = 3500;

export function useAudioRecorder(opts: UseAudioRecorderOptions = {}): UseAudioRecorderResult {
  const { chunkMs = DEFAULT_CHUNK_MS, onChunk, onStateChange } = opts;

  const [state, setState] = useState<RecorderState>('idle');
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const supported =
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getUserMedia === 'function' &&
    typeof window !== 'undefined' &&
    typeof window.MediaRecorder !== 'undefined';

  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const cycleTimerRef = useRef<number | null>(null);
  const vadRef = useRef<EnergyVad>(new EnergyVad());
  const rmsSamplesRef = useRef<number[]>([]);
  const chunkStartRef = useRef<number>(0);
  const stateRef = useRef<RecorderState>('idle');

  // Keep stateRef in sync so async callbacks read the latest value.
  useEffect(() => {
    stateRef.current = state;
    onStateChange?.(state);
  }, [state, onStateChange]);

  const setActiveState = useCallback((next: RecorderState) => {
    setState(next);
  }, []);

  const tickLevel = useCallback(() => {
    const analyser = analyserRef.current;
    if (!analyser) return;
    const buf = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(buf);
    const rms = rmsFromTimeDomain(buf);
    vadRef.current.observe(rms);
    rmsSamplesRef.current.push(rms);
    // Surface a slightly smoothed level for UI — raw is too jittery.
    setLevel((prev) => prev * 0.7 + rms * 0.3);
    rafRef.current = requestAnimationFrame(tickLevel);
  }, []);

  const pickMimeType = useCallback((): string => {
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/mp4',
    ];
    for (const c of candidates) {
      if (window.MediaRecorder?.isTypeSupported?.(c)) return c;
    }
    return '';
  }, []);

  const startRecorderCycle = useCallback(() => {
    const stream = streamRef.current;
    if (!stream) return;
    if (stateRef.current !== 'recording') return;

    const mimeType = pickMimeType();
    const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    recorderRef.current = recorder;
    chunkStartRef.current = performance.now();
    rmsSamplesRef.current = [];

    const blobs: Blob[] = [];
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) blobs.push(e.data);
    };
    recorder.onstop = () => {
      const durationMs = performance.now() - chunkStartRef.current;
      const samples = rmsSamplesRef.current;
      const avgRms = samples.length
        ? samples.reduce((a, b) => a + b, 0) / samples.length
        : 0;
      const hasSpeech = vadRef.current.isSpeech(avgRms);
      const finalMime = recorder.mimeType || mimeType || 'audio/webm';
      const blob = new Blob(blobs, { type: finalMime });
      if (blob.size > 0) {
        onChunk?.({
          blob,
          mimeType: finalMime,
          averageRms: avgRms,
          hasSpeech,
          capturedAt: Date.now(),
          durationMs,
        });
      }
      // Spin up the next cycle if we're still recording.
      if (stateRef.current === 'recording') {
        startRecorderCycle();
      }
    };
    recorder.start();

    cycleTimerRef.current = window.setTimeout(() => {
      try {
        if (recorder.state !== 'inactive') recorder.stop();
      } catch {
        // recorder already stopped
      }
    }, chunkMs);
  }, [chunkMs, onChunk, pickMimeType]);

  const teardown = useCallback(() => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (cycleTimerRef.current != null) {
      clearTimeout(cycleTimerRef.current);
      cycleTimerRef.current = null;
    }
    try {
      recorderRef.current?.stop();
    } catch {
      /* ignore */
    }
    recorderRef.current = null;
    sourceRef.current?.disconnect();
    sourceRef.current = null;
    analyserRef.current?.disconnect();
    analyserRef.current = null;
    void audioCtxRef.current?.close();
    audioCtxRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setLevel(0);
  }, []);

  const start = useCallback(async () => {
    if (!supported) {
      setError('This browser does not support audio capture.');
      return;
    }
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });
      streamRef.current = stream;

      const AudioCtx =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) throw new Error('Web Audio API unavailable.');
      const ctx = new AudioCtx();
      audioCtxRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.2;
      source.connect(analyser);
      sourceRef.current = source;
      analyserRef.current = analyser;

      setActiveState('recording');
      rafRef.current = requestAnimationFrame(tickLevel);
      startRecorderCycle();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start microphone.');
      setActiveState('idle');
      teardown();
    }
  }, [setActiveState, startRecorderCycle, supported, teardown, tickLevel]);

  const pause = useCallback(() => {
    if (stateRef.current !== 'recording') return;
    setActiveState('paused');
    try {
      recorderRef.current?.pause();
    } catch {
      /* ignore */
    }
  }, [setActiveState]);

  const resume = useCallback(() => {
    if (stateRef.current !== 'paused') return;
    setActiveState('recording');
    try {
      if (recorderRef.current?.state === 'paused') recorderRef.current.resume();
      else startRecorderCycle();
    } catch {
      /* ignore */
    }
  }, [setActiveState, startRecorderCycle]);

  const stop = useCallback(() => {
    if (stateRef.current === 'idle') return;
    setActiveState('stopping');
    // Flush the final chunk, then tear down.
    try {
      if (recorderRef.current && recorderRef.current.state !== 'inactive') {
        // Override onstop so we don't immediately restart.
        recorderRef.current.onstop = null;
        recorderRef.current.ondataavailable = () => {
          /* drop */
        };
        recorderRef.current.stop();
      }
    } catch {
      /* ignore */
    }
    teardown();
    setActiveState('idle');
  }, [setActiveState, teardown]);

  useEffect(
    () => () => {
      teardown();
    },
    [teardown],
  );

  return { state, level, error, supported, start, pause, resume, stop };
}
