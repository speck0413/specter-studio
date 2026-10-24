import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// In a browser (development, UI tests) the device layer is the bridge (`npm run bridge`): the page talks to it
// through these proxies. Inside the desktop app it is the Tauri shell instead.
const bridge = process.env.BRIDGE_PORT || '18790';
// The bridge's WebSocket needs its token (core/src/bin/bridge.rs): SPECTER_BRIDGE_TOKEN, else the file the bridge
// writes at start. The proxy adds it, so the page never holds it; read on every connection (the bridge may start
// after the dev server).
const bridgeToken = () => {
  if (process.env.SPECTER_BRIDGE_TOKEN) return process.env.SPECTER_BRIDGE_TOKEN;
  try { return fs.readFileSync(path.join(os.tmpdir(), `specter-bridge-${bridge}.token`), 'utf8').trim(); } catch { return ''; }
};
const toBridge = { target: `ws://127.0.0.1:${bridge}`, ws: true, rewrite: () => `/?token=${bridgeToken()}` };

// `vite preview` serves the built app under the desktop window's Content Security Policy (from tauri.conf.json),
// with the bridge and same-origin frames in place of Tauri's IPC and plugin scheme: the UI tests check that
// nothing the app needs is blocked by it.
const csp = Object.entries(JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8')).app.security.csp as Record<string, string>)
  .map(([k, v]) => `${k} ${k === 'connect-src' ? "'self' ws:" : k === 'frame-src' || k === 'media-src' ? "'self'" : v}`).join('; ');
// Blockly's sounds and icons, served by the app itself instead of Blockly's web server
function blocklyMedia() {
  const dir = 'node_modules/blockly/media';
  return {
    name: 'blockly-media',
    configureServer(server: any) {
      server.middlewares.use('/blockly-media', (req: any, res: any, next: any) => {
        const f = `${dir}/${decodeURIComponent((req.url || '').split('?')[0]).replace(/^\/+/, '').replace(/\.\./g, '')}`;
        if (!fs.existsSync(f) || !fs.statSync(f).isFile()) return next();
        if (f.endsWith('.svg')) res.setHeader('Content-Type', 'image/svg+xml');
        res.end(fs.readFileSync(f));
      });
    },
    generateBundle(this: any) {
      for (const f of fs.readdirSync(dir)) this.emitFile({ type: 'asset', fileName: `blockly-media/${f}`, source: fs.readFileSync(`${dir}/${f}`) });
    },
  };
}

export default defineConfig({
  // the firmware's shared plain ES modules (firmware/web/take.js) are no React code: no JSX transform, and no
  // lookup of the firmware repository's own tsconfig.json (it extends a submodule Studio does not check out)
  plugins: [react({ exclude: [/[\\/]firmware[\\/]firmware[\\/]web[\\/]/, /node_modules/] }), blocklyMedia()],
  clearScreen: false,
  optimizeDeps: { entries: ['index.html'] },
  server: {
    port: Number(process.env.PORT || 1420),
    strictPort: true,
    // other checkouts of this repo (git worktrees in .worktrees/) are never this app's sources; matched below this
    // checkout only, so a checkout that itself lives in .worktrees/ still watches its own files
    watch: { ignored: ['**/firmware/**', '**/target/**', '**/src-tauri/**', (f: string) => path.relative(process.cwd(), f).split(path.sep).includes('.worktrees')] },
    proxy: {
      '/__bridge': toBridge,
      '/plugins': { target: `http://127.0.0.1:${bridge}` },
    },
  },
  preview: {
    port: Number(process.env.PORT || 4173),
    strictPort: true,
    headers: { 'Content-Security-Policy': csp },
    proxy: {
      '/__bridge': toBridge,
      '/plugins': { target: `http://127.0.0.1:${bridge}` },
    },
  },
  build: { chunkSizeWarningLimit: 8000 },
  test: { environment: 'jsdom', include: ['src/**/*.test.ts'], exclude: ['**/node_modules/**', '**/.worktrees/**'] },
} as any);
