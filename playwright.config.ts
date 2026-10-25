import { defineConfig } from '@playwright/test';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';

// The UI against the real device layer (the bridge) and real simulated boards. CHROMIUM picks the browser.
// E2E_BRIDGE_PORT / E2E_APP_PORT / E2E_PREVIEW_PORT / E2E_GITHUB_PORT (and E2E_MQTT_PORT, tests/e2e/studio.spec.ts) move the servers, so two checkouts can test at once.
const BRIDGE = (process.env.E2E_BRIDGE_PORT ||= '18792');
const APP = (process.env.E2E_APP_PORT ||= '14232');
const PREVIEW = (process.env.E2E_PREVIEW_PORT ||= '14233');
const GITHUB = (process.env.E2E_GITHUB_PORT ||= '18793');
// the bridge's WebSocket token (core/src/bin/bridge.rs), shared by the bridge, both dev servers and the tests
const TOKEN = (process.env.SPECTER_BRIDGE_TOKEN ||= randomBytes(16).toString('hex'));
// git for the script sources and extensions tests: a made-up identity (never the person's own settings), no
// file manager windows, and extensions added from git in a folder of their own
const GIT_ENV = {
  GIT_CONFIG_GLOBAL: path.resolve('tests/fixtures/gitconfig'),
  GIT_CONFIG_NOSYSTEM: '1',
  SPECTER_NO_OPEN: '1',
  SPECTER_STUDIO_EXTENSIONS_DIR: (process.env.E2E_EXTENSIONS_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), 'specter-e2e-extensions-'))),
};
// the SD card tool (tests/e2e/sdcard.spec.ts): one fake card, a folder; the device layer never runs a disk tool for it
const SDCARD = (process.env.E2E_SDCARD_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), 'specter-e2e-sdcard-')));
fs.mkdirSync(path.join(SDCARD, 'card'), { recursive: true });
const TEST_DRIVES = JSON.stringify([{ id: 'test-card', name: 'SPOOKY', label: 'SPOOKY', mount: path.join(SDCARD, 'card'), size: 8_000_000_000, removable: true, fs: 'vfat' }]);
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 120_000,
  workers: 1,
  use: {
    baseURL: `http://localhost:${APP}/`,
    launchOptions: { executablePath: process.env.CHROMIUM || '/usr/bin/google-chrome' },
    viewport: { width: 1300, height: 900 },
    screenshot: 'only-on-failure',
    // on CI a failed test keeps its trace (actions, page snapshots, console) in test-results, uploaded by the workflow
    trace: process.env.CI ? 'retain-on-failure' : 'off',
  },
  webServer: [
    // GitHub's release API, faked: the default firmware release source never reaches the internet in tests
    { command: `node tests/fixtures/github-mock.mjs ${GITHUB}`, port: Number(GITHUB) },
    { command: `cargo run -q -p studio-core --bin bridge -- --port ${BRIDGE}`, port: Number(BRIDGE), timeout: 300_000, env: { SPECTER_BRIDGE_TOKEN: TOKEN, SPECTER_SIM_SPEED: '10', SPECTER_STUDIO_EXAMPLE_PLUGINS: '1', SPECTER_GITHUB_API: `http://127.0.0.1:${GITHUB}`, SPECTER_STUDIO_PLUGINS: path.resolve('tests/plugins-e2e'), SPECTER_BUNDLED_FIRMWARE: path.resolve('tests/fixtures/bundled-firmware'), SPECTER_TEST_SERIAL_PORTS: JSON.stringify([{ path: '/dev/null', what: 'ESP32 board (CH340 USB chip)', usb: true, esp_bridge: true }]), SPECTER_TEST_DRIVES: TEST_DRIVES, ...GIT_ENV, ...(process.env.SPECTER_GUIDES_DIR ? { SPECTER_GUIDES_DIR: process.env.SPECTER_GUIDES_DIR } : {}) } },
    { command: 'npx vite', port: Number(APP), env: { PORT: APP, BRIDGE_PORT: BRIDGE, SPECTER_BRIDGE_TOKEN: TOKEN } },
    // the built app under the desktop window's Content Security Policy (tests/e2e/csp.spec.ts)
    { command: 'npx vite build && npx vite preview', port: Number(PREVIEW), timeout: 180_000, env: { PORT: PREVIEW, BRIDGE_PORT: BRIDGE, SPECTER_BRIDGE_TOKEN: TOKEN } },
  ],
});
