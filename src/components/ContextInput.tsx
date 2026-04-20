interface ContextInputProps {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}

export function ContextInput({ value, onChange, disabled }: ContextInputProps) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium uppercase tracking-wider text-ink-400">
        Session context
      </span>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        rows={2}
        placeholder="e.g. Board meeting, AMA Invest, Q2 strategic review"
        className="resize-none rounded-md border border-ink-800 bg-ink-900/60 px-3 py-2 text-sm text-ink-100 placeholder:text-ink-500 focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500/40 disabled:opacity-60"
      />
      <span className="text-[11px] text-ink-500">
        Claude uses this to frame the insights. Kept on-device unless you export.
      </span>
    </label>
  );
}
