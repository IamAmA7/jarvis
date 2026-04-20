/**
 * Export helpers — Markdown / clipboard / print-to-PDF.
 *
 * We use the browser's native print dialog for PDF instead of jsPDF — that
 * keeps the bundle tiny (and the single-file build small), works in every
 * browser, and lets the user pick margins, paper size, headers, etc.
 */
import type { Session } from '../types';

export function buildMarkdown(session: Session): string {
  const { context, chunks, insight, createdAt } = session;
  const lines: string[] = [];
  lines.push(`# Jarvis session — ${new Date(createdAt).toLocaleString()}`);
  lines.push('');
  if (context) {
    lines.push(`**Context:** ${context}`);
    lines.push('');
  }

  if (insight) {
    lines.push('## Summary');
    insight.summary.forEach((s) => lines.push(`- ${s}`));
    lines.push('');

    if (insight.action_items.length) {
      lines.push('## Action items');
      insight.action_items.forEach((a) => {
        const owner = a.owner ? ` — _${a.owner}_` : '';
        const deadline = a.deadline ? ` (by ${a.deadline})` : '';
        lines.push(`- ${a.action}${owner}${deadline}`);
      });
      lines.push('');
    }

    if (insight.key_topics.length) {
      lines.push('## Key topics');
      lines.push(insight.key_topics.map((t) => `\`${t}\``).join(' · '));
      lines.push('');
    }

    if (insight.open_questions.length) {
      lines.push('## Open questions');
      insight.open_questions.forEach((q) => lines.push(`- ${q}`));
      lines.push('');
    }

    lines.push(
      `**Sentiment:** ${insight.sentiment} · **Energy:** ${insight.energy_level}/5 · **Language:** ${insight.language_detected}`,
    );
    lines.push('');
  }

  lines.push('## Transcript');
  lines.push('');
  const transcriptText = chunks
    .filter((c) => c.status === 'final')
    .map((c) => c.text.trim())
    .filter(Boolean)
    .join(' ');
  lines.push(transcriptText || '_(no transcript)_');
  lines.push('');

  return lines.join('\n');
}

export async function copyToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  document.body.removeChild(ta);
}

export function downloadFile(name: string, mime: string, content: string | Blob): void {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function exportMarkdown(session: Session): void {
  const md = buildMarkdown(session);
  downloadFile(`jarvis-${session.id.slice(0, 8)}.md`, 'text/markdown', md);
}

/**
 * Opens a clean, print-ready window with the session rendered and triggers
 * the browser's "Save as PDF" flow. Works everywhere without a PDF library.
 */
export function exportPdf(session: Session): void {
  const html = buildPrintableHtml(session);
  const w = window.open('', '_blank', 'width=780,height=900');
  if (!w) {
    alert(
      'Не удалось открыть окно печати. Разрешите pop-ups для этого сайта и попробуйте снова.',
    );
    return;
  }
  w.document.open();
  w.document.write(html);
  w.document.close();
  // Give the browser a beat to render before we pop the print dialog.
  const tryPrint = () => {
    try {
      w.focus();
      w.print();
    } catch {
      /* ignore */
    }
  };
  if (w.document.readyState === 'complete') {
    setTimeout(tryPrint, 150);
  } else {
    w.addEventListener('load', () => setTimeout(tryPrint, 150));
  }
}

function buildPrintableHtml(session: Session): string {
  const { context, chunks, insight, createdAt } = session;
  const esc = (s: string) =>
    s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  const summary = insight
    ? `<section><h2>Summary</h2><ul>${insight.summary
        .map((s) => `<li>${esc(s)}</li>`)
        .join('')}</ul></section>`
    : '';

  const actions =
    insight && insight.action_items.length
      ? `<section><h2>Action items</h2><ul>${insight.action_items
          .map((a) => {
            const owner = a.owner ? ` — <em>${esc(a.owner)}</em>` : '';
            const deadline = a.deadline ? ` <span class="meta">(by ${esc(a.deadline)})</span>` : '';
            return `<li>${esc(a.action)}${owner}${deadline}</li>`;
          })
          .join('')}</ul></section>`
      : '';

  const topics =
    insight && insight.key_topics.length
      ? `<section><h2>Key topics</h2><p>${insight.key_topics
          .map((t) => `<code>${esc(t)}</code>`)
          .join(' · ')}</p></section>`
      : '';

  const questions =
    insight && insight.open_questions.length
      ? `<section><h2>Open questions</h2><ul>${insight.open_questions
          .map((q) => `<li>${esc(q)}</li>`)
          .join('')}</ul></section>`
      : '';

  const meta = insight
    ? `<p class="meta">Sentiment: <strong>${insight.sentiment}</strong> · Energy: <strong>${insight.energy_level}/5</strong> · Language: <strong>${insight.language_detected}</strong></p>`
    : '';

  const transcript =
    chunks
      .filter((c) => c.status === 'final')
      .map((c) => c.text.trim())
      .filter(Boolean)
      .join(' ') || '(no transcript)';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Jarvis session — ${esc(new Date(createdAt).toLocaleString())}</title>
<style>
  @page { margin: 24mm; }
  body { font: 14px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #1a1a1a; max-width: 720px; margin: 0 auto; padding: 24px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 15px; margin: 22px 0 8px; text-transform: uppercase; letter-spacing: .06em; color: #555; }
  ul { margin: 0; padding-left: 22px; }
  li { margin-bottom: 4px; }
  code { font: 12px ui-monospace, monospace; background: #f1f1f3; padding: 1px 6px; border-radius: 4px; margin-right: 4px; }
  .meta { color: #666; font-size: 12px; }
  hr { border: none; border-top: 1px solid #e5e5e8; margin: 22px 0; }
  p { margin: 0 0 8px; }
  @media print { body { padding: 0; } }
</style>
</head>
<body>
  <h1>Jarvis session</h1>
  <p class="meta">${esc(new Date(createdAt).toLocaleString())}</p>
  ${context ? `<p><strong>Context:</strong> ${esc(context)}</p>` : ''}
  ${meta}
  ${summary}
  ${actions}
  ${topics}
  ${questions}
  <hr>
  <section><h2>Transcript</h2><p>${esc(transcript)}</p></section>
</body>
</html>`;
}
