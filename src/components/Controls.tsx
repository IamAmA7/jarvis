import type { RecorderState } from '../types';

interface ControlsProps {
  state: RecorderState;
  disabled?: boolean;
  onStart: () => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onClear: () => void;
  clearDisabled: boolean;
}

export function Controls({
  state,
  disabled,
  onStart,
  onPause,
  onResume,
  onStop,
  onClear,
  clearDisabled,
}: ControlsProps) {
  const recording = state === 'recording';
  const paused = state === 'paused';
  const idle = state === 'idle';

  return (
    <div className="flex items-center gap-2">
      {idle && (
        <button
          type="button"
          onClick={onStart}
          disabled={disabled}
          className="flex items-center gap-2 rounded-md bg-accent-500 px-4 py-2 text-sm font-medium text-white hover:bg-accent-600 focus:outline-none focus:ring-2 focus:ring-accent-500/70 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <MicIcon className="h-4 w-4" />
          Record
        </button>
      )}
      {recording && (
        <button
          type="button"
          onClick={onPause}
          className="flex items-center gap-2 rounded-md border border-ink-700 bg-ink-800/60 px-4 py-2 text-sm font-medium hover:bg-ink-800"
        >
          <PauseIcon className="h-4 w-4" />
          Pause
        </button>
      )}
      {paused && (
        <button
          type="button"
          onClick={onResume}
          className="flex items-center gap-2 rounded-md bg-accent-500 px-4 py-2 text-sm font-medium text-white hover:bg-accent-600"
        >
          <MicIcon className="h-4 w-4" />
          Resume
        </button>
      )}
      {!idle && (
        <button
          type="button"
          onClick={onStop}
          className="flex items-center gap-2 rounded-md border border-ink-700 bg-ink-800/60 px-4 py-2 text-sm font-medium hover:bg-ink-800"
        >
          <StopIcon className="h-4 w-4" />
          Stop
        </button>
      )}
      <button
        type="button"
        onClick={onClear}
        disabled={clearDisabled}
        className="flex items-center gap-2 rounded-md border border-ink-800 px-4 py-2 text-sm font-medium text-ink-300 hover:bg-ink-800/60 disabled:cursor-not-allowed disabled:opacity-40"
      >
        Clear
      </button>
    </div>
  );
}

function MicIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path
        d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function PauseIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <rect x="6" y="5" width="4" height="14" rx="1" />
      <rect x="14" y="5" width="4" height="14" rx="1" />
    </svg>
  );
}

function StopIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <rect x="6" y="6" width="12" height="12" rx="1.5" />
    </svg>
  );
}
