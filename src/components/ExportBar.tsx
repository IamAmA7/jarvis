import { useState } from 'react';
import { buildMarkdown, copyToClipboard, exportMarkdown, exportPdf } from '../lib/export';
import type { Session } from '../types';

interface ExportBarProps {
  session: Session;
  disabled?: boolean;
}

export function ExportBar({ session, disabled }: ExportBarProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await copyToClipboard(buildMarkdown(session));
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  return (
    <div className="flex items-center gap-2 text-xs">
      <button
        type="button"
        onClick={handleCopy}
        disabled={disabled}
        className="rounded-md border border-ink-800 px-3 py-1.5 text-ink-200 hover:bg-ink-800/60 disabled:opacity-40"
      >
        {copied ? 'Copied!' : 'Copy MD'}
      </button>
      <button
        type="button"
        onClick={() => exportMarkdown(session)}
        disabled={disabled}
        className="rounded-md border border-ink-800 px-3 py-1.5 text-ink-200 hover:bg-ink-800/60 disabled:opacity-40"
      >
        Download .md
      </button>
      <button
        type="button"
        onClick={() => exportPdf(session)}
        disabled={disabled}
        className="rounded-md border border-ink-800 px-3 py-1.5 text-ink-200 hover:bg-ink-800/60 disabled:opacity-40"
      >
        Download .pdf
      </button>
    </div>
  );
}
