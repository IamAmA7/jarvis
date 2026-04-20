import type { ReactNode } from 'react';
import type { Insight } from '../types';

interface InsightsPanelProps {
  insight: Insight | null;
  loading: boolean;
  error: string | null;
  onRegenerate: () => void;
  canRegenerate: boolean;
}

export function InsightsPanel({
  insight,
  loading,
  error,
  onRegenerate,
  canRegenerate,
}: InsightsPanelProps) {
  return (
    <section className="flex min-h-0 flex-1 flex-col rounded-lg border border-ink-800 bg-ink-900/40">
      <div className="flex items-center justify-between border-b border-ink-800 px-4 py-3">
        <h2 className="text-sm font-semibold tracking-tight">Insights</h2>
        <div className="flex items-center gap-3 text-xs text-ink-400">
          {loading && (
            <span className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 animate-pulseDot rounded-full bg-accent-500" />
              Thinking…
            </span>
          )}
          <button
            type="button"
            onClick={onRegenerate}
            disabled={!canRegenerate || loading}
            className="rounded border border-ink-800 px-2 py-0.5 hover:bg-ink-800/60 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Regenerate
          </button>
        </div>
      </div>
      <div className="scrollbar-thin flex-1 overflow-y-auto px-4 py-4">
        {!insight && !loading && !error && (
          <p className="text-sm text-ink-500">
            Insights appear automatically once you have a couple of sentences of transcript.
          </p>
        )}
        {loading && !insight && <SkeletonInsight />}
        {error && (
          <div className="mb-4 rounded-md border border-red-900/60 bg-red-950/30 p-3 text-sm text-red-200">
            {error}
          </div>
        )}
        {insight && <InsightView insight={insight} stale={loading} />}
      </div>
    </section>
  );
}

function InsightView({ insight, stale }: { insight: Insight; stale: boolean }) {
  return (
    <div className={stale ? 'opacity-70 transition-opacity' : undefined}>
      <MetaRow insight={insight} />

      <Section title="Summary">
        <ul className="space-y-1.5">
          {insight.summary.map((s, i) => (
            <li key={i} className="flex gap-2 text-sm leading-relaxed">
              <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-accent-500" />
              <span>{s}</span>
            </li>
          ))}
        </ul>
      </Section>

      {insight.action_items.length > 0 && (
        <Section title="Action items">
          <ul className="space-y-2">
            {insight.action_items.map((a, i) => (
              <li key={i} className="rounded-md border border-ink-800 bg-ink-900/60 px-3 py-2 text-sm">
                <div className="text-ink-100">{a.action}</div>
                <div className="mt-1 flex gap-3 text-xs text-ink-400">
                  <span>Owner: {a.owner ?? '—'}</span>
                  <span>Due: {a.deadline ?? '—'}</span>
                </div>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {insight.key_topics.length > 0 && (
        <Section title="Key topics">
          <div className="flex flex-wrap gap-1.5">
            {insight.key_topics.map((t, i) => (
              <span
                key={i}
                className="rounded-full border border-ink-800 bg-ink-900/60 px-2 py-0.5 text-xs text-ink-300"
              >
                {t}
              </span>
            ))}
          </div>
        </Section>
      )}

      {insight.open_questions.length > 0 && (
        <Section title="Open questions">
          <ul className="space-y-1.5">
            {insight.open_questions.map((q, i) => (
              <li key={i} className="flex gap-2 text-sm leading-relaxed">
                <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" />
                <span>{q}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}

function MetaRow({ insight }: { insight: Insight }) {
  return (
    <div className="mb-5 flex flex-wrap items-center gap-2 text-xs text-ink-300">
      <SentimentBadge sentiment={insight.sentiment} />
      <EnergyBadge level={insight.energy_level} />
      <span className="rounded-full border border-ink-800 bg-ink-900/60 px-2 py-0.5">
        {insight.language_detected}
      </span>
    </div>
  );
}

function SentimentBadge({ sentiment }: { sentiment: Insight['sentiment'] }) {
  const map: Record<Insight['sentiment'], string> = {
    positive: 'bg-emerald-950/40 border-emerald-900/60 text-emerald-300',
    neutral: 'bg-ink-900/60 border-ink-800 text-ink-300',
    tense: 'bg-red-950/40 border-red-900/60 text-red-300',
  };
  return (
    <span className={`rounded-full border px-2 py-0.5 ${map[sentiment]}`}>
      {sentiment}
    </span>
  );
}

function EnergyBadge({ level }: { level: Insight['energy_level'] }) {
  return (
    <span className="flex items-center gap-1 rounded-full border border-ink-800 bg-ink-900/60 px-2 py-0.5">
      <span className="text-ink-400">energy</span>
      <span className="font-mono">{level}/5</span>
    </span>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mb-5">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-400">{title}</h3>
      {children}
    </div>
  );
}

function SkeletonInsight() {
  return (
    <div className="space-y-3">
      <div className="h-3 w-24 animate-pulse rounded bg-ink-800" />
      <div className="space-y-1.5">
        <div className="h-3 w-full animate-pulse rounded bg-ink-800" />
        <div className="h-3 w-4/5 animate-pulse rounded bg-ink-800" />
        <div className="h-3 w-3/5 animate-pulse rounded bg-ink-800" />
      </div>
    </div>
  );
}
