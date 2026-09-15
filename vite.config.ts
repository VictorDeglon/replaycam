import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// GitHub Pages project sites are served from /<repo-name>/, so CI passes
// that as PAGES_BASE. Local dev/build defaults to root. The manifest's own
// start_url/scope/icon paths aren't auto-rewritten by Vite's base handling
// (only index.html's own asset references are), so it's built explicitly
// from the same base below.
const base = process.env.PAGES_BASE ?? '/';

export default defineConfig({
  base,
  server: {
    host: true
    // Camera access requires a secure context. On LAN, use --host and open
    // the HTTPS-capable address, or the deployed HTTPS URL. See README.
  },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg', 'apple-touch-icon.png', 'favicon-32.png', 'favicon-16.png'],
      manifest: {
        name: 'ReplayCam — Instant Replay Recorder',
        short_name: 'ReplayCam',
        description: 'Always-buffering camera. Tap once to save the moments before and after.',
        theme_color: '#0b0c10',
        background_color: '#0b0c10',
        display: 'fullscreen',
        orientation: 'portrait',
        start_url: base,
        scope: base,
        icons: [
          { src: `${base}icons/icon-192.png`, sizes: '192x192', type: 'image/png' },
          { src: `${base}icons/icon-512.png`, sizes: '512x512', type: 'image/png' },
          { src: `${base}icons/icon-512-maskable.png`, sizes: '512x512', type: 'image/png', purpose: 'maskable' }
        ]
      },
      workbox: {
        // The ffmpeg.wasm core is large and lazy-loaded on first export only —
        // don't force it into the precache.
        globIgnores: ['ffmpeg/**', '**/ffmpeg/**'],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024
      }
    })
  ]
});
