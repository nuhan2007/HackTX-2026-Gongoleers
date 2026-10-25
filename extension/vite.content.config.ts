// The content script as ONE self-contained classic script (dist/content.js), built after the main build.
//
// The main build (CRXJS) turns a content script into a tiny loader that does `import(chrome.runtime.getURL('assets/…'))` in every
// frame. Chrome refuses that import in some frames (sandboxed iframes, about:blank and srcdoc frames, which YouTube is full of), and
// logs "Unsafe attempt to load URL chrome-extension://… from frame with URL …" as an extension error on every one. A classic content
// script is injected by Chrome itself, needs nothing web-accessible, and works in any frame. `scripts/finalize-manifest.mjs` then points
// the manifest at it.
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    lib: { entry: 'src/content/index.tsx', formats: ['iife'], name: 'myTAContent', fileName: () => 'content.js' },
  },
});
