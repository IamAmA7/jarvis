import { SignedIn, SignedOut, SignIn } from '@clerk/clerk-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent as ReactDragEvent,
} from 'react';
import { BillingView } from './components/BillingView';
import { SharingPanel } from './components/SharingPanel';
import { ContextInput } from './components/ContextInput';
import { Controls } from './components/Controls';
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
import type { GetToken } from './lib/api';
import { makeId } from './lib/ids';
import {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  type Settings,
} from './lib/settings';
import { clearSessions } from './lib/storage';
import { identifyUser, track } from './lib/telemetry';
import type { AppView, Insight, Session } from './types';

interface UploadResult {
  transcript: string;
  language: string;
  durationSec: number;
  insight: Insight | null;
}

const VIEWS: AppView[] = ['record', 'sessions', 'settings', 'billing', 'access'];

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

  const transcription = useTranscription({ settings, getToken });
  const insights = useInsights({ settings, getToken, sessionId, context });

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

  useSessionSync({ getToken, session, enabled: userId !== null });

  const [uploadResult, setUploadResult] = useState<UploadResult | null>(null);  const handleClear = useCallback(() => {
    recorder.stop();
    transcription.clear();
    insights.reset();    setUploadResult(null);
    setSessionId(makeId('s_'));
    setSessionStart(Date.now());
  }, [recorder, transcription, insights]);

  const resetEverything = useCallback(() => {
    handleClear();
    clearSessions();
    persistSettings(DEFAULT_SETTINGS);
  }, [handleClear, persistSettings]);

  const hasAnyWork = session.chunks.length > 0 || session.insight !== null || uploadResult !== null;
  const lastError =
    recorder.error ?? transcription.lastError ?? insights.lastError ?? null;

  return (
    <div className="flex h-full flex-col">
      <Header
        view={view}
        onChangeView={changeView}
        recorderState={recorder.state}
        userName={name}
        userEmail={email}
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
            context={context}
            onContextChange={setContext}
            onOpenSettings={() => changeView('settings')}
            onOpenBilling={() => changeView('billing')}
            onClear={handleClear}
            hasAnyWork={hasAnyWork}
            lastError={lastError}
            quotaExceeded={usage.snapshot?.allowed === false}
            hidDeviceName={hid.deviceName}
            getToken={getToken}
            onUploaded={() => changeView('sessions')} uploadResult={uploadResult} setUploadResult={setUploadResult}
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
          <SessionsView
            getToken={getToken}
            onGoToRecord={() => changeView('record')}
          />
        )}
        {view === 'billing' && (
          <BillingView
            getToken={getToken}
            usage={usage.snapshot}
            onRefresh={usage.refresh}
          />
        )}
        {view === 'access' && (
          <SharingPanel getToken={getToken} />
        )}
      </main>
    </div>
  );
}

interface RecordViewProps {
  recorder: ReturnType<typeof useAudioRecorder>;
  transcription: ReturnType<typeof useTranscription>;
  insights: ReturnType<typeof useInsights>;
  context: string;
  onContextChange: (v: string) => void;
  onOpenSettings: () => void;
  onOpenBilling: () => void;
  onClear: () => void;
  hasAnyWork: boolean;
  lastError: string | null;
  quotaExceeded: boolean;
  hidDeviceName: string | null;
  getToken: GetToken;
  onUploaded: () => void; uploadResult: UploadResult | null; setUploadResult: (r: UploadResult | null) => void;
}

function RecordView({
  recorder,
  transcription,
  insights,
  context,
  onContextChange,
  onOpenSettings,
  onOpenBilling,
  onClear,
  hasAnyWork,
  lastError,
  quotaExceeded,
  hidDeviceName,
  getToken,
  onUploaded, uploadResult, setUploadResult,
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
      </div>

      <UploadCard getToken={getToken} onUploaded={onUploaded} onResult={setUploadResult} />

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-2">
        <TranscriptPanel
          chunks={uploadResult ? [{id:'upload', capturedAt: Date.now(), text: uploadResult.transcript, language: uploadResult.language, segments: [], status: 'final' as const}] : transcription.chunks}
          pendingCount={transcription.pendingCount}
          error={transcription.lastError}
        />
        <InsightsPanel
          insight={uploadResult ? uploadResult.insight : insights.insight}
          loading={insights.loading}
          error={insights.lastError}
          onRegenerate={() => insights.regenerate(transcription.chunks)}
          canRegenerate={transcription.chunks.some((c) => c.status === 'final')}
        />
      </div>
    </>
  );
}

// ————— Upload card —————
//
// Manual upload pipeline (independent of GCS cloud sync):
//   1. POST /api/upload/init        → Supabase Storage signed upload URL
//   2. PUT signedUrl                → browser uploads file directly to Supabase
//   3. POST /api/upload/finalize    → server downloads, transcribes (Whisper),
//                                     extracts insights (Claude), inserts row
//                                     into gcs_synced_files with bucket='manual'
// The GCS bucket and the cron that watches it are NOT touched.

type UploadStatus =
  | { kind: 'idle' }
  | { kind: 'preparing' }
  | { kind: 'uploading'; pct: number }
  | { kind: 'processing' }
  | { kind: 'success'; objectName: string }
  | { kind: 'error'; message: string };

const MAX_FILE_BYTES = 500 * 1024 * 1024; // Whisper API single-call limit

function UploadCard({ getToken, onUploaded, onResult }: { getToken: GetToken; onUploaded: () => void; onResult: (r: { transcript: string; language: string; durationSec: number; insight: Insight | null }) => void }) {
  const [status, setStatus] = useState<UploadStatus>({ kind: 'idle' });
  const [drag, setDrag] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const upload = useCallback(
    async (file: File) => {
      if (file.size > MAX_FILE_BYTES) {
        setStatus({
          kind: 'error',
          message: `Файл ${(file.size / 1024 / 1024).toFixed(1)} MB больше лимита ${MAX_FILE_BYTES / 1024 / 1024} MB. Сожмите аудио (например, в mp3 64–128 kbps) или используйте облачную синхронизацию.`,
        });
        return;
      }
      setStatus({ kind: 'preparing' });
      try {
        const token = await getToken();
        if (!token) throw new Error('Не авторизованы');

        // 1. Get a Supabase Storage signed upload URL.
        const initRes = await fetch('/api/upload/init', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            filename: file.name,
            contentType: file.type || 'application/octet-stream',
            size: file.size,
          }),
        });
        if (!initRes.ok) {
          let detail = `${initRes.status}`;
          try {
            const b = (await initRes.json()) as { error?: string };
            if (b.error) detail = b.error;
          } catch {}
          throw new Error(`Init failed: ${detail}`);
        }
        const init = (await initRes.json()) as {
          signedUrl: string;
          path: string;
          contentType: string;
        };

        // 2. PUT the file straight to Supabase Storage. Supabase configures
        //    CORS for its storage subdomain, so this works from the browser.
        setStatus({ kind: 'uploading', pct: 0 });
        await new Promise<void>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open('PUT', init.signedUrl);
          xhr.setRequestHeader('Content-Type', init.contentType);
          xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) {
              setStatus({ kind: 'uploading', pct: Math.round((e.loaded / e.total) * 100) });
            }
          };
          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) resolve();
            else reject(new Error(`Загрузка не удалась: ${xhr.status} ${xhr.responseText.slice(0, 120)}`));
          };
          xhr.onerror = () => reject(new Error('Сетевая ошибка при загрузке'));
          xhr.send(file);
        });

        // 3. Trigger transcription + insights + DB insert.
        setStatus({ kind: 'processing' });
        const finalizeRes = await fetch('/api/upload/finalize', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            path: init.path,
            filename: file.name,
            contentType: file.type || 'application/octet-stream',
            size: file.size,
          }),
        });
        if (!finalizeRes.ok) {
          let detail = `${finalizeRes.status}`;
          try {
            const b = (await finalizeRes.json()) as { error?: string };
            if (b.error) detail = b.error;
          } catch {}
          throw new Error(`Обработка не удалась: ${detail}`);
        }

        const finalizeData = (await finalizeRes.json()) as { id: string; transcript: string; language: string; duration: number; insights: Insight | null }; onResult({ transcript: finalizeData.transcript, language: finalizeData.language, durationSec: finalizeData.duration, insight: finalizeData.insights }); track('upload:success', { size: file.size, type: file.type });
        setStatus({ kind: 'success', objectName: init.path });
      } catch (err) {
        track('upload:error', {
          message: err instanceof Error ? err.message : String(err),
        });
        setStatus({
          kind: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [getToken, onResult],
  );

  const onPick = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) void upload(f);
  };
  const onDrop = (e: ReactDragEvent) => {
    e.preventDefault();
    setDrag(false);
    const f = e.dataTransfer.files?.[0];
    if (f) void upload(f);
  };

  const busy =
    status.kind === 'preparing' ||
    status.kind === 'uploading' ||
    status.kind === 'processing';

  return (
    <div
      onDragEnter={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragOver={(e) => {
        e.preventDefault();
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={onDrop}
      className={`rounded-lg border bg-ink-900/40 p-4 transition-colors ${
        drag ? 'border-accent-500 bg-accent-500/5' : 'border-ink-800'
      }`}
    >
      <div className="flex flex-col items-start justify-between gap-3 md:flex-row md:items-center">
        <div className="flex flex-1 items-center gap-3">
          <span
            className="grid h-10 w-10 shrink-0 place-items-center rounded-full border border-accent-500/40 bg-accent-500/10 text-accent-500"
            aria-hidden
          >
            ↑
          </span>
          <div>
            <h3 className="text-sm font-semibold text-ink-100">Загрузить готовый файл</h3>
            <p className="mt-0.5 text-xs text-ink-400">
              Загрузите файл, ваш транскрипт и саммери будет готов в течении 5 минут
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <input
            ref={inputRef}
            type="file"
            accept="audio/*,video/*"
            onChange={onPick}
            disabled={busy}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={busy}
            className="inline-flex items-center gap-2 rounded-full bg-accent-500 px-5 py-2 text-sm font-semibold text-black shadow-glow-accent hover:opacity-90 disabled:opacity-60"
          >
            {status.kind === 'preparing' && (
              <>
                <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-black/30 border-t-black" />
                Подготовка…
              </>
            )}
            {status.kind === 'uploading' && (
              <>
                <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-black/30 border-t-black" />
                Загрузка {status.pct}%
              </>
            )}
            {status.kind === 'processing' && (
              <>
                <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-black/30 border-t-black" />
                Транскрибация…
              </>
            )}
            {status.kind !== 'preparing' &&
              status.kind !== 'uploading' &&
              status.kind !== 'processing' && <>📂 Выбрать файл</>}
          </button>
        </div>
      </div>

      {status.kind === 'uploading' && (
        <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-ink-800">
          <div
            className="h-full bg-accent-500 shadow-glow-accent transition-all"
            style={{ width: `${status.pct}%` }}
          />
        </div>
      )}

      {status.kind === 'processing' && (
        <div className="mt-3 rounded-md border border-accent-500/40 bg-accent-500/5 px-3 py-2 text-xs text-ink-300">
          Файл загружен. Whisper транскрибирует, Claude генерит инсайты — это занимает 20–40 сек, не закрывайте вкладку.
        </div>
      )}

      {status.kind === 'success' && (
        <div className="mt-3 flex flex-wrap items-center gap-3 rounded-md border border-accent-500/40 bg-accent-500/10 px-3 py-2 text-xs text-accent-500">
          <span>✓ Готово. Транскрипция и инсайты сохранены.</span>
          <button
            type="button"
            onClick={onUploaded}
            className="rounded-full border border-accent-500/60 px-2.5 py-0.5 hover:bg-accent-500/10"
          >
            Открыть Историю →
          </button>
        </div>
      )}

      {status.kind === 'error' && (
        <div className="mt-3 rounded-md border border-red-900/60 bg-red-950/30 px-3 py-2 text-xs text-red-200">
          {status.message}
        </div>
      )}
    </div>
  );
}

function viewFromHash(): AppView {
  if (typeof location === 'undefined') return 'record';
  const raw = location.hash.replace('#', '') as AppView;
  return (VIEWS as string[]).includes(raw) ? raw : 'record';
}
