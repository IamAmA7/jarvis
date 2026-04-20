import { describe, expect, it } from 'vitest';
import { buildMarkdown } from './export';
import type { Session } from '../types';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 's_abc',
    createdAt: new Date('2026-04-20T10:00:00Z').getTime(),
    context: 'Sprint planning',
    chunks: [
      {
        id: 'c1',
        capturedAt: 0,
        text: 'Hello there.',
        language: 'en',
        segments: [],
        status: 'final',
      },
      {
        id: 'c2',
        capturedAt: 0,
        text: 'General Kenobi.',
        language: 'en',
        segments: [],
        status: 'final',
      },
      {
        id: 'c3',
        capturedAt: 0,
        text: 'still going',
        language: 'en',
        segments: [],
        status: 'pending',
      },
    ],
    insight: {
      session_id: 's_abc',
      timestamp: '2026-04-20T10:05:00Z',
      summary: ['Team aligned on Q3 scope'],
      action_items: [
        { action: 'Draft RFC', owner: 'Alex', deadline: '2026-04-25' },
        { action: 'Unblock Supabase migration', owner: null, deadline: null },
      ],
      key_topics: ['auth', 'migrations'],
      open_questions: ['Do we need a feature flag?'],
      sentiment: 'positive',
      energy_level: 4,
      language_detected: 'en',
    },
    ...overrides,
  };
}

describe('buildMarkdown', () => {
  it('produces the expected top-level structure', () => {
    const md = buildMarkdown(makeSession());
    expect(md).toContain('# Jarvis session');
    expect(md).toContain('**Context:** Sprint planning');
    expect(md).toContain('## Summary');
    expect(md).toContain('- Team aligned on Q3 scope');
    expect(md).toContain('## Action items');
    expect(md).toContain('Draft RFC');
    expect(md).toContain('— _Alex_');
    expect(md).toContain('(by 2026-04-25)');
    expect(md).toContain('## Key topics');
    expect(md).toContain('`auth`');
    expect(md).toContain('## Open questions');
    expect(md).toContain('**Sentiment:** positive');
    expect(md).toContain('## Transcript');
  });

  it('only includes final chunks in the transcript', () => {
    const md = buildMarkdown(makeSession());
    expect(md).toContain('Hello there. General Kenobi.');
    expect(md).not.toContain('still going');
  });

  it('skips the context section when empty', () => {
    const md = buildMarkdown(makeSession({ context: '' }));
    expect(md).not.toContain('**Context:**');
  });

  it('handles sessions without insights', () => {
    const md = buildMarkdown(makeSession({ insight: null }));
    expect(md).not.toContain('## Summary');
    expect(md).toContain('## Transcript');
  });

  it('shows a placeholder when there is no final transcript', () => {
    const empty = makeSession({
      chunks: [
        {
          id: 'c1',
          capturedAt: 0,
          text: 'pending',
          language: null,
          segments: [],
          status: 'pending',
        },
      ],
      insight: null,
    });
    const md = buildMarkdown(empty);
    expect(md).toContain('_(no transcript)_');
  });
});
