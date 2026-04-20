import { SignedIn, SignedOut, SignIn } from '@clerk/clerk-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { BillingView } from './components/BillingView';
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
import { useSessionSync } from './hooks/useSessionSync';
import { useTranscription } from './hooks/useTranscription';
import { useUsage } from './hooks/useUsage';
import { useWebHID } from './hooks/useWebHID';
import { useJarvisAuth } from './lib/auth';
import { makeId } from './lib/ids';
import {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  type Settings,
} from './lib/settings';
import { clearSessions } from './lib/storage';
import { identifyUser, track } from './lib/telemetry';
import type { AppView, Session } from './types';

const VIEWS: AppView[] = ['record', 'sessions', 'settings', 'billing'];

export default function App() {
  return (
    <>
      <SignedIn>
        <SignedInApp />
      </SignedIn>
      <SignedOut>
        <SignInGate />
      </SignedOut>
    </>
  );
}

function SignInGate() {
  return (
    <div className="flex h-full items-center justify-center bg-ink-950 p-6">
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <h1 className="text-3xl font-semibold text-ink-100">Jarvis</h1>
          <p className="mt-2 text-sm text-ink-400">
            AI-микрофон: транскрипция + структурные инсайты в реальном времени.
          </p>
        </div>
        <SignIn routing="hash" />
      </div>
    </div>
  );
}

function SignedInApp() {
  const { userId, email, name, getToken, signOut } = useJarvisAuth();
  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const [view, setView] = useState<AppView>(() => viewFromHash());
  const [sessionId, setSessionId] = useState(() => makeId('s_'));
  const [sessionStart, setSessionStart] = useState(() => Date.now());
  const [context, setContext] = useState('');
  const usage = useUsage({ getToken, enabled: Boolean(userId) });

  useEffect(() => {
    identifyUser(userId, { email: email ?? undefined, name: name ?? undefined });
  }, [userId, email, name]);

  useEffect(() => {
    const onHash = () => setView(viewFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const changeView = useCallback((next: AppView) => {
    if (location.hash !== `#${next}`) location.hash = next;
    setView(next);
    track('view:change', { view: next });
  }, []);

  const persistSettings = useCallback((next: Settings) => {
    setSettings(next);
    saveSettings(next);
  }, []);

  // ————— Recording stack —————

  const transcription = useTranscription({ settings, getToken });
  const insights = useInsights({
    settings,
    getToken,
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

  // Optional push-to-talk via connected HID device (foot pedal, jog dial…)
  const hid = useWebHID({
    enabled: settings.pushToTalkEnabled,
    onButtonPress: () => {
      if (recorder.state === 'idle' || recorder.state === 'paused') {
        void recorder.start();
      } else {
        recorder.stop();
      }
    },
  });

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

  // Push the live session to Supabase as it grows.
  useSessionSync({ getToken, session, enabled: userId !== null });

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
    persistSettings(DEFAULT_SETTINGS);
  }, [handleClear, persistSettings]);

  const hasAnyWork = session.chunks.length > 0 || session.insight !== null;
  const lastError =
    recorder.error ?? transcription.lastError ?? insights.lastError ?? null;

  return (
    <div className="flex h-full flex-col">
      <Header
        view={view}
        onChangeView={changeView}
        recorderState={recorder.state}
        model={settings.model}
        userName={name}
        userEmail={email}
        usage={usage.snapshot}
        onSignOut={() => {
          track('auth:sign_out');
          void signOut();
        }}
      />

      <main className="flex min-h-0 flex-1 flex-col gap-4 p-4 md:p-6">
        {view === 'record' && (
          <RecordView
            recorder={recorder}
            transcription={transcription}
            insights={insights}
            session={session}
            context={context}
            onContextChange={setContext}
            onOpenSettings={() => changeView('settings')}
            onOpenBilling={() => changeView('billing')}
            onClear={handleClear}
            hasAnyWork={hasAnyWork}
            lastError={lastError}
            quotaExceeded={usage.snapshot?.allowed === false}
            hidDeviceName={hid.deviceName}
          />
        )}

        {view === 'settings' && (
          <SettingsView
            settings={settings}
            onChange={persistSettings}
            onResetEverything={resetEverything}
            hid={hid}
          />
        )}

        {view === 'sessions' && (
          <SessionsView getToken={getToken} onGoToRecord={() => changeView('record')} />
        )}

        {view === 'billing' && (
          <BillingView getToken={getToken} usage={usage.snapshot} onRefresh={usage.refresh} />
        )}
      </main>
    </div>
  );
}

// ————— Record view —————

interface RecordViewProps {
  recorder: ReturnType<typeof useAudioRecorder>;
  transcription: ReturnType<typeof useTranscription>;
  insights: ReturnType<typeof useInsights>;
  session: Session;
  context: string;
  onContextChange: (v: string) => void;
  onOpenSettings: () => void;
  onOpenBilling: () => void;
  onClear: () => void;
  hasAnyWork: boolean;
  lastError: string | null;
  quotaExceeded: boolean;
  hidDeviceName: string | null;
}

function RecordView({
  recorder,
  transcription,
  insights,
  session,
  context,
  onContextChange,
  onOpenSettings,
  onOpenBilling,
  onClear,
  hasAnyWork,
  lastError,
  quotaExceeded,
  hidDeviceName,
}: RecordViewProps) {
  return (
    <>
      <StatusBar
        lastError={lastError}
        quotaExceeded={quotaExceeded}
        hidDeviceName={hidDeviceName}
        onOpenSettings={onOpenSettings}
        onOpenBilling={onOpenBilling}
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
              disabled={quotaExceeded}
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
