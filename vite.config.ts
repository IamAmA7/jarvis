import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

// Produces a SINGLE self-contained index.html: React, CSS, and all JS inlined.
// Drop that file onto any static host (Netlify Drop, Cloudflare Pages, etc.)
// and it just works.
export default defineConfig({
  plugins: [react(), viteSingleFile()],
  server: {
    port: 5173,
  },
  build: {
    outDir: 'dist',
    // The single-file plugin sets these, but being explicit helps.
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
    sourcemap: false,
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
});
