/**
 * useDeepgram — live streaming transcription.
 *
 * Architecture:
 *   1. Ask the server to mint a 60-second-scoped Deepgram key (`/api/deepgram/token`).
 *   2. Open a WebSocket to `wss://api.deepgram.com/v1/listen` using that key
 *      in a `Sec-WebSocket-Protocol` auth scheme Deepgram accepts.
 *   3. Pipe MediaRecorder blobs straight onto the socket as binary frames.
 *   4. Receive interim (`is_final: false`) and final (`is_final: true`)
 *      transcripts; callers typically replace interim text and append final.
 *
 * The caller is responsible for calling `start(stream)` when recording
 * begins (we don't own the MediaStream) and `stop()` on pause/stop.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { mintDeepgramKey, type GetToken } from '../lib/api';
import { captureError, track } from '../lib/telemetry';

export interface LiveTranscriptEvent {
  text: string;
  isFinal: boolean;
  start: number;
  end: number;
  confidence: number | null;
}

interface Options {
  getToken: GetToken;
  language?: string;
  onTranscript: (ev: LiveTranscriptEvent) => void;
  onError?: (err: Error) => void;
}

export function useDeepgram({ getToken, language, onTranscript, onError }: Options) {
  const socketRef = useRef<WebSocket | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const [connected, setConnected] = useState(false);
  const tokenRef = useRef(getToken);
  const onTranscriptRef = useRef(onTranscript);
  const onErrorRef = useRef(onError);

  useEffect(() => {
    tokenRef.current = getToken;
  }, [getToken]);
  useEffect(() => {
    onTranscriptRef.current = onTranscript;
  }, [onTranscript]);
  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  const start = useCallback(
    async (stream: MediaStream) => {
      if (socketRef.current) return;
      try {
        const { key } = await mintDeepgramKey(tokenRef.current);
        const params = new URLSearchParams({
          model: 'nova-2-general',
          smart_format: 'true',
          punctuate: 'true',
          interim_results: 'true',
          encoding: 'opus',
          channels: '1',
          sample_rate: '48000',
        });
        if (language && language !== 'auto') params.set('language', language);
        const url = `wss://api.deepgram.com/v1/listen?${params.toString()}`;

        const ws = new WebSocket(url, ['token', key]);
        ws.binaryType = 'arraybuffer';
        socketRef.current = ws;

        ws.addEventListener('open', () => {
          setConnected(true);
          track('deepgram:connected');

          const mimeType = pickMimeType();
          const recorder = new MediaRecorder(stream, { mimeType });
          recorderRef.current = recorder;
          recorder.ondataavailable = (ev) => {
            if (ev.data.size > 0 && ws.readyState === WebSocket.OPEN) {
              ev.data.arrayBuffer().then((buf) => ws.send(buf)).catch(() => undefined);
            }
          };
          recorder.start(250);
        });

        ws.addEventListener('message', (ev) => {
          try {
            const msg = JSON.parse(String(ev.data)) as DeepgramPayload;
            if (msg.type !== 'Results') return;
            const alt = msg.channel?.alternatives?.[0];
            if (!alt?.transcript) return;
            onTranscriptRef.current({
              text: alt.transcript,
              isFinal: Boolean(msg.is_final),
              start: msg.start ?? 0,
              end: (msg.start ?? 0) + (msg.duration ?? 0),
              confidence: typeof alt.confidence === 'number' ? alt.confidence : null,
            });
          } catch (err) {
            captureError(err, { where: 'useDeepgram.message' });
          }
        });

        ws.addEventListener('error', () => {
          onErrorRef.current?.(new Error('Deepgram socket error'));
        });
        ws.addEventListener('close', () => {
          setConnected(false);
          socketRef.current = null;
          track('deepgram:closed');
        });
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        captureError(e, { where: 'useDeepgram.start' });
        onErrorRef.current?.(e);
      }
    },
    [language],
  );

  const stop = useCallback(() => {
    const rec = recorderRef.current;
    if (rec && rec.state !== 'inactive') {
      try {
        rec.stop();
      } catch {
        /* ignore */
      }
    }
    recorderRef.current = null;

    const ws = socketRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: 'CloseStream' }));
      } catch {
        /* ignore */
      }
      ws.close();
    }
    socketRef.current = null;
    setConnected(false);
  }, []);

  useEffect(() => () => stop(), [stop]);

  return { start, stop, connected };
}

interface DeepgramPayload {
  type: string;
  start?: number;
  duration?: number;
  is_final?: boolean;
  channel?: {
    alternatives?: Array<{ transcript?: string; confidence?: number }>;
  };
}

function pickMimeType(): string {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
  for (const c of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(c)) return c;
  }
  return '';
}
