/**
 * Sentry + PostHog bootstrap.
 *
 * Both are opt-in: if DSN / key are missing, we wire up a no-op. That keeps
 * local dev free of analytics noise and makes the build work for anyone who
 * forks the repo without credentials.
 */
import * as Sentry from '@sentry/react';
import posthog from 'posthog-js';

let started = false;

export function initTelemetry() {
  if (started) return;
  started = true;

  const sentryDsn = import.meta.env.VITE_SENTRY_DSN as string | undefined;
  if (sentryDsn) {
    Sentry.init({
      dsn: sentryDsn,
      environment: import.meta.env.MODE,
      tracesSampleRate: 0.1,
      replaysSessionSampleRate: 0,
      replaysOnErrorSampleRate: 1.0,
      integrations: [Sentry.browserTracingIntegration(), Sentry.replayIntegration({ maskAllText: true })],
    });
  }

  const phKey = import.meta.env.VITE_POSTHOG_KEY as string | undefined;
  const phHost = (import.meta.env.VITE_POSTHOG_HOST as string | undefined) ?? 'https://us.i.posthog.com';
  if (phKey) {
    posthog.init(phKey, {
      api_host: phHost,
      capture_pageview: true,
      autocapture: false,
      persistence: 'localStorage+cookie',
    });
  }
}

export function identifyUser(userId: string | null, traits?: Record<string, unknown>) {
  if (!userId) return;
  try {
    Sentry.setUser({ id: userId });
    posthog.identify(userId, traits);
  } catch {
    /* telemetry must never throw */
  }
}

export function track(event: string, props?: Record<string, unknown>) {
  try {
    posthog.capture(event, props);
  } catch {
    /* swallow */
  }
}

export function captureError(err: unknown, context?: Record<string, unknown>) {
  try {
    Sentry.captureException(err, { extra: context });
  } catch {
    /* swallow */
  }
}

export { Sentry };
