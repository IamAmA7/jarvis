// Shared types. Keep this file dependency-free so it can be consumed anywhere.

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export interface TranscriptChunk {
  id: string;
  capturedAt: number;
  text: string;
  language: string | null;
  segments: TranscriptSegment[];
  status: 'pending' | 'final' | 'error';
  error?: string;
}

export interface ActionItem {
  action: string;
  owner: string | null;
  deadline: string | null;
}

export type Sentiment = 'positive' | 'neutral' | 'tense';
export type DetectedLanguage = 'ru' | 'en' | 'uk' | 'mixed';

export interface Insight {
  session_id: string;
  timestamp: string;
  summary: string[];
  action_items: ActionItem[];
  key_topics: string[];
  open_questions: string[];
  sentiment: Sentiment;
  energy_level: 1 | 2 | 3 | 4 | 5;
  language_detected: DetectedLanguage;
}

export type InsightType =
  | 'summary'
  | 'action_items'
  | 'key_topics'
  | 'open_questions'
  | 'sentiment';

export interface Session {
  id: string;
  createdAt: number;
  context: string;
  chunks: TranscriptChunk[];
  insight: Insight | null;
}

export type RecorderState = 'idle' | 'recording' | 'paused' | 'stopping';

export type AppView = 'record' | 'sessions' | 'settings';
