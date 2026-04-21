/**
 * Alert classifier — turns a transcript window into one of three severities
 * plus a category label. The model sees the parent's configured red/yellow
 * category list so tuning is per-user, not global.
 *
 * Severity contract:
 *   red    — needs an immediate Telegram push (minutes matter)
 *   yellow — worth a note but goes through the daily digest
 *   green  — archive only
 *
 * We also return `confidence` (0..1) so downstream can soften borderline
 * pushes (e.g. require confidence > 0.7 to fire a red alert, else bucket
 * into yellow).
 */
import { callClaude, pickModel, safeParseJson } from './claude';

export interface AlertClassification {
  severity: 'red' | 'yellow' | 'green';
  category: string;
  summary: string;
  evidence: string | null;
  confidence: number;
}

export interface ClassifierInput {
  text: string;
  windowStart: Date;
  windowEnd: Date;
  childName: string | null;
  childAge: number | null;
  redCategories: string[];
  yellowCategories: string[];
  languageHint?: string | null;
  model?: string | null;
}

export async function classifyTranscriptWindow(
  input: ClassifierInput,
): Promise<AlertClassification> {
  const system = buildSystemPrompt(input);
  const user = buildUserMessage(input);
  const model = pickModel(input.model ?? undefined, 'claude-sonnet-4-6');
  const raw = await callClaude({ model, system, user, maxTokens: 500, temperature: 0.1 });
  const parsed = safeParseJson<Record<string, unknown>>(raw);
  return normaliseClassification(parsed ?? {});
}

function buildSystemPrompt(input: ClassifierInput): string {
  const child = input.childName ?? 'the child';
  const age = input.childAge ? `${input.childAge} years old` : 'a young child';
  const redList = input.redCategories.join(', ');
  const yellowList = input.yellowCategories.join(', ');
  const lang = input.languageHint && input.languageHint !== 'auto'
    ? `Transcripts are primarily in ${input.languageHint}. `
    : 'Transcripts may mix Russian, Ukrainian, and English. ';

  return [
    `You are Jarvis Listener, a child-safety transcript triage system.`,
    `Context: ${child} is ${age}. The microphone is worn all day; transcripts are`,
    `noisy, may include background speech from peers, teachers, family.`,
    lang,
    ``,
    `Your job: classify ONE transcript window into a severity + a category label.`,
    ``,
    `Severity rules:`,
    `  "red"    — immediate concern. Fire ONLY for clear, high-confidence signals`,
    `             that a parent must know within minutes: ${redList}.`,
    `             Ambiguous or distant signals MUST NOT be red.`,
    `  "yellow" — worth the parent's review today but not urgent: ${yellowList},`,
    `             or any subtle sign that does not meet the red bar.`,
    `  "green"  — mundane, no concern.`,
    ``,
    `Confidence calibration:`,
    `  Only emit red with confidence >= 0.7. If you are less sure, use yellow.`,
    `  If nothing of note, emit green with a brief summary and confidence 0.9+.`,
    ``,
    `Output CONTRACT (single JSON object, no prose, no fences):`,
    `{`,
    `  "severity": "red" | "yellow" | "green",`,
    `  "category": string,        // one of the red/yellow categories, or "normal" for green`,
    `  "summary":  string,        // 1-2 sentences, what happened, in the parent's language`,
    `  "evidence": string|null,   // a SHORT direct quote (<= 180 chars) or null`,
    `  "confidence": number       // 0..1`,
    `}`,
    ``,
    `Never fabricate a quote. If you cannot find one, set evidence to null.`,
    `Never moralise. Report, do not advise.`,
  ].join('\n');
}

function buildUserMessage(input: ClassifierInput): string {
  return [
    `WINDOW: ${input.windowStart.toISOString()} — ${input.windowEnd.toISOString()}`,
    `TRANSCRIPT:`,
    input.text.slice(0, 12000), // Claude has plenty of context; hard cap anyway
  ].join('\n');
}

function normaliseClassification(raw: Record<string, unknown>): AlertClassification {
  const severity = (() => {
    const s = raw.severity;
    return s === 'red' || s === 'yellow' ? s : 'green';
  })();
  const confidence = (() => {
    const n = Number(raw.confidence);
    if (!Number.isFinite(n)) return severity === 'green' ? 0.9 : 0.5;
    return Math.max(0, Math.min(1, n));
  })();
  // Safety floor: low-confidence reds get demoted to yellow so we don't
  // page the parent at 3 AM for a mishearing.
  const effective: AlertClassification['severity'] =
    severity === 'red' && confidence < 0.7 ? 'yellow' : severity;
  return {
    severity: effective,
    category: typeof raw.category === 'string' && raw.category.trim() ? raw.category.trim() : 'normal',
    summary: typeof raw.summary === 'string' ? raw.summary.trim().slice(0, 600) : '',
    evidence:
      typeof raw.evidence === 'string' && raw.evidence.trim().length
        ? raw.evidence.trim().slice(0, 400)
        : null,
    confidence,
  };
}
