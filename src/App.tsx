import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ContextInput } from './components/ContextInput';
import { Controls } from './components/Controls';
import { ExportBar } from './components/ExportBar';
import { Header } from './components/Header';
import { InsightsPanel } from './components/InsightsPanel';
import { SessionsView } from './components/SessionsView';
import { SettingsView } from './components/SettingsView';
import { StatusBar } from './components/StatusBar';
import { TranscriptPanel } from './components/TranscriptPanel';
import { WaveformVisualizer } from './components/WaveformVisualizer';
import { useAudioRecorder, type AudioChunk } from './hooks/useAudioRecorder';
import { useInsights } from './hooks/useInsights';
import { useTranscription } from './hooks/useTranscription';
import { makeId } from './lib/ids';
import {
  DEFAULT_SETTINGS,
  isConfigured,
  loadSettings,
  saveSettings,
  type Settings,
} from './lib/settings';
import { clearSessions, loadSessions, saveSession } from './lib/storage';
import type { AppView, Session } from './types';

const VIEWS: AppView[] = ['record', 'sessions', 'settings'];

export default function App() {
  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const [view, setView] = useState<AppView>(() => viewFromHash());
  const [sessionId, setSessionId] = useState(() => makeId('s_'));
  const [sessionStart, setSessionStart] = useState(() => Date.now());
  const [context, setContext] = useState('');
  const [storedSessions, setStoredSessions] = useState<Session[]>(() => loadSessions());

  // Route changes via URL hash so back/forward works.
  useEffect(() => {
    const onHash = () => setView(viewFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const changeView = useCallback((next: AppView) => {
    if (location.hash !== `#${next}`) location.hash = next;
    setView(next);
  }, []);

  // Persist settings on change.
  const persistSettings = useCallback((next: Settings) => {
    setSettings(next);
    saveSettings(next);
  }, []);

  const configured = isConfigured(settings);

  // ————— Recording stack —————

  const transcription = useTranscription({ settings });
  const insights = useInsights({
    settings,
    sessionId,
    context,
  });

  useEffect(() => {
    insights.observe(transcription.chunks);
  }, [transcription.chunks, insights]);

  const handleChunk = useCallback(
    (chunk: AudioChunk) => {
      transcription.submit(chunk);
    },
    [transcription],
  );

  const recorder = useAudioRecorder({ onChunk: handleChunk });

  const session: Session = useMemo(
    () => ({
      id: sessionId,
      createdAt: sessionStart,
      context,
      chunks: transcription.chunks,
      insight: insights.insight,
    }),
    [sessionId, sessionStart, context, transcription.chunks, insights.insight],
  );

  // Debounced persistence of the live session.
  const saveTimerRef = useRef<number | null>(null);
  useEffect(() => {
    if (saveTimerRef.current != null) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      if (session.chunks.length === 0 && !session.insight) return;
      saveSession(session, settings.persistSessions);
      setStoredSessions(loadSessions());
    }, 1200);
    return () => {
      if (saveTimerRef.current != null) clearTimeout(saveTimerRef.current);
    };
  }, [session, settings.persistSessions]);

  // Wipe cached sessions whenever the user opts out.
  useEffect(() => {
    if (!settings.persistSessions) {
      clearSessions();
      setStoredSessions([]);
    }
  }, [settings.persistSessions]);

  const handleClear = useCallback(() => {
    recorder.stop();
    transcription.clear();
    insights.reset();
    setSessionId(makeId('s_'));
    setSessionStart(Date.now());
  }, [recorder, transcription, insights]);

  const resetEverything = useCallback(() => {
    handleClear();
    clearSessions();
    setStoredSessions([]);
    persistSettings(DEFAULT_SETTINGS);
  }, [handleClear, persistSettings]);

  const hasAnyWork = session.chunks.length > 0 || session.insight !== null;
  const lastError = recorder.error ?? transcription.lastError ?? insights.lastError;

  return (
    <div className="flex h-full flex-col">
      <Header
        view={view}
        onChangeView={changeView}
        recorderState={recorder.state}
        configured={configured}
        model={settings.model}
      />

      <main className="flex min-h-0 flex-1 flex-col gap-4 p-4 md:p-6">
        {view === 'record' && (
          <RecordView
            settings={settings}
            recorder={recorder}
            transcription={transcription}
            insights={insights}
            session={session}
            context={context}
            onContextChange={setContext}
            onOpenSettings={() => changeView('settings')}
            onClear={handleClear}
            hasAnyWork={hasAnyWork}
            lastError={lastError}
          />
        )}

        {view === 'settings' && (
          <SettingsView
            settings={settings}
            onChange={persistSettings}
            onResetEverything={resetEverything}
          />
        )}

        {view === 'sessions' && (
          <SessionsView
            sessions={storedSessions}
            onChanged={() => setStoredSessions(loadSessions())}
            onGoToRecord={() => changeView('record')}
          />
        )}
      </main>
    </div>
  );
}

// ————— Record view (pulled out so App stays scannable) —————

interface RecordViewProps {
  settings: Settings;
  recorder: ReturnType<typeof useAudioRecorder>;
  transcription: ReturnType<typeof useTranscription>;
  insights: ReturnType<typeof useInsights>;
  session: Session;
  context: string;
  onContextChange: (v: string) => void;
  onOpenSettings: () => void;
  onClear: () => void;
  hasAnyWork: boolean;
  lastError: string | null;
}

function RecordView({
  settings,
  recorder,
  transcription,
  insights,
  session,
  context,
  onContextChange,
  onOpenSettings,
  onClear,
  hasAnyWork,
  lastError,
}: RecordViewProps) {
  return (
    <>
      <StatusBar
        missingOpenAI={!settings.openaiApiKey}
        missingAnthropic={!settings.anthropicApiKey}
        lastError={lastError}
        onOpenSettings={onOpenSettings}
      />

      <div className="flex flex-col gap-3 rounded-lg border border-ink-800 bg-ink-900/40 p-4 md:flex-row md:items-end md:justify-between">
        <div className="flex flex-1 flex-col gap-4 md:flex-row md:items-end">
          <div className="flex-1">
            <ContextInput
              value={context}
              onChange={onContextChange}
              disabled={recorder.state === 'recording'}
            />
          </div>
          <div className="flex items-center gap-3">
            <WaveformVisualizer level={recorder.level} state={recorder.state} />
            <Controls
              state={recorder.state}
              onStart={() => {
                void recorder.start();
              }}
              onPause={recorder.pause}
              onResume={recorder.resume}
              onStop={recorder.stop}
              onClear={onClear}
              clearDisabled={!hasAnyWork && recorder.state === 'idle'}
            />
          </div>
        </div>
        <div className="md:ml-4">
          <ExportBar session={session} disabled={!hasAnyWork} />
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-2">
        <TranscriptPanel
          chunks={transcription.chunks}
          pendingCount={transcription.pendingCount}
          error={transcription.lastError}
        />
        <InsightsPanel
          insight={insights.insight}
          loading={insights.loading}
          error={insights.lastError}
          onRegenerate={() => insights.regenerate(transcription.chunks)}
          canRegenerate={transcription.chunks.some((c) => c.status === 'final')}
        />
      </div>
    </>
  );
}

function viewFromHash(): AppView {
  if (typeof location === 'undefined') return 'record';
  const raw = location.hash.replace('#', '') as AppView;
  return (VIEWS as string[]).includes(raw) ? raw : 'record';
}
