import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ClerkProvider } from '@clerk/clerk-react';
import App from './App';
import './index.css';
import { initTelemetry } from './lib/telemetry';

initTelemetry();

const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;
if (!publishableKey) {
  // eslint-disable-next-line no-console
  console.warn(
    'VITE_CLERK_PUBLISHABLE_KEY is not set — auth will be disabled. ' +
      'Set it on Vercel → Environment Variables.',
  );
}

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Missing #root element in index.html');

const tree = publishableKey ? (
  <ClerkProvider publishableKey={publishableKey} afterSignOutUrl="/">
    <App />
  </ClerkProvider>
) : (
  <App />
);

createRoot(rootEl).render(<StrictMode>{tree}</StrictMode>);
