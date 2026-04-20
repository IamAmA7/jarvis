import { useEffect, useRef } from 'react';
import type { TranscriptChunk } from '../types';

interface TranscriptPanelProps {
  chunks: TranscriptChunk[];
  pendingCount: number;
  error: string | null;
}

export function TranscriptPanel({ chunks, pendingCount, error }: TranscriptPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to the latest chunk as new transcripts arrive.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [chunks.length]);

  return (
    <section className="flex min-h-0 flex-1 flex-col rounded-lg border border-ink-800 bg-ink-900/40">
      <div className="flex items-center justify-between border-b border-ink-800 px-4 py-3">
        <h2 className="text-sm font-semibold tracking-tight">Transcript</h2>
        <div className="flex items-center gap-3 text-xs text-ink-400">
          {pendingCount > 0 && (
            <span className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 animate-pulseDot rounded-full bg-accent-500" />
              Transcribing {pendingCount}
            </span>
          )}
          <span>
            {chunks.filter((c) => c.status === 'final').length} chunk
            {chunks.length === 1 ? '' : 's'}
          </span>
        </div>
      </div>
      <div
        ref={scrollRef}
        className="scrollbar-thin flex-1 overflow-y-auto px-4 py-3 text-[15px] leading-relaxed"
      >
        {chunks.length === 0 && !error && (
          <p className="text-sm text-ink-500">
            Press <span className="rounded bg-ink-800 px-1.5 py-0.5 font-mono text-xs">Record</span>{' '}
            and start speaking. Chunks appear here as they are transcribed.
          </p>
        )}
        {chunks.map((c) => (
          <ChunkView key={c.id} chunk={c} />
        ))}
        {error && (
          <div className="mt-3 rounded-md border border-red-900/60 bg-red-950/30 p-3 text-sm text-red-200">
            {error}
          </div>
        )}
      </div>
    </section>
  );
}

function ChunkView({ chunk }: { chunk: TranscriptChunk }) {
  if (chunk.status === 'pending') {
    return (
      <p className="mb-2 text-ink-500">
        <span className="inline-block h-3 w-24 animate-pulse rounded bg-ink-800" />
      </p>
    );
  }
  if (chunk.status === 'error') {
    return (
      <p className="mb-2 text-sm text-red-300">
        (transcription failed: {chunk.error})
      </p>
    );
  }
  if (!chunk.text) return null;
  return (
    <p className="mb-2 text-ink-100">
      <span className="mr-2 select-none text-[11px] text-ink-500">
        {new Date(chunk.capturedAt).toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        })}
      </span>
      {chunk.text}
    </p>
  );
}
