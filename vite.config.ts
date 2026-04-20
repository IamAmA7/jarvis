import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Standard multi-file Vite build. We ship a proper `dist/` with hashed asset
// filenames so Vercel can serve them with a year-long Cache-Control header.
// The single-file bundle mode was only useful back when Jarvis ran entirely
// in the browser with user-supplied keys — now there's a real backend, so
// splitting is a net win (cache hit rate, parallel fetch, smaller initial
// payload thanks to code-splitting of rare views).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
