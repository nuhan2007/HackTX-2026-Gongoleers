import { defineManifest } from '@crxjs/vite-plugin';
import pkg from './package.json';

export default defineManifest({
  manifest_version: 3,
  name: 'myTA.tech',
  description: 'Your pixel study buddy: notices when you\'re stuck, flags mistakes the moment you make them, and never gives you the answer.',
  version: pkg.version,
  icons: { 16: 'icons/icon16.png', 32: 'icons/icon32.png', 48: 'icons/icon48.png', 128: 'icons/icon128.png' },
  action: { default_title: 'Open myTA' },
  background: { service_worker: 'src/background/index.ts', type: 'module' },
  side_panel: { default_path: 'src/sidepanel/index.html' },
  options_page: 'src/options/index.html',
  permissions: ['storage', 'unlimitedStorage', 'offscreen', 'tabs', 'activeTab', 'scripting', 'sidePanel'],
  host_permissions: [
    '<all_urls>',
    'https://generativelanguage.googleapis.com/*',
    'https://serpapi.com/*',
    'https://i.ytimg.com/*',
  ],
  content_scripts: [
    { matches: ['<all_urls>'], js: ['src/content/index.tsx'], all_frames: true, run_at: 'document_idle' },
  ],
  commands: {
    'label-stuck': {
      suggested_key: { default: 'Alt+Shift+S' },
      description: 'Label mode: mark "I feel stuck right now"',
    },
  },
  content_security_policy: {
    extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
  },
});
