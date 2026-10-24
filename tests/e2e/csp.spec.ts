// The built app under the desktop window's Content Security Policy: everything renders (the editor, the blocks,
// a plugin, a practice board) and the browser reports no blocked resource.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { allowedPlugins } from './consent';

test('the app works under its Content Security Policy', async ({ browser }) => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'specter-csp-'));
  const ctx = await browser.newContext({ baseURL: `http://localhost:${process.env.E2E_PREVIEW_PORT || '14233'}/`, viewport: { width: 1300, height: 900 } });
  const page = await ctx.newPage();
  const blocked: string[] = [];
  page.on('console', (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) blocked.push(m.text()); });
  const pluginConsent = await allowedPlugins();
  await page.addInitScript(([w, c]) => localStorage.setItem('specter-prefs', JSON.stringify({ firstRunDone: true, workspace: w, pluginConsent: c })), [ws, pluginConsent] as const);
  const res = await page.goto('/');
  expect(res?.headers()['content-security-policy']).toContain("script-src 'self'");
  await page.getByRole('button', { name: /Add a practice board/ }).click();
  await expect(page.getByText('Practice board 1').first()).toBeVisible({ timeout: 15_000 });
  await page.getByRole('tab', { name: 'Your library' }).click();
  await page.getByRole('button', { name: 'Start from an example' }).click();
  await page.getByRole('button', { name: /light up ghost/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
  // the example opens (its first lines are the wiring notes)
  await expect(page.getByTestId('text-editor').locator('.view-lines')).toContainText('Light-up ghost');
  await expect(page.getByTestId('blocks').locator('.blocklyBlockCanvas').first()).toBeVisible();
  await expect(page.getByTestId('check')).toContainText('Looks good', { timeout: 10_000 });
  await page.getByRole('tab', { name: 'Board list (example plugin)' }).click();
  await expect(page.frameLocator('iframe[title="Board list (example plugin)"]').getByRole('heading', { name: 'Practice board 1' })).toBeVisible({ timeout: 10_000 });
  expect(blocked).toEqual([]);
  // leave the shared device layer as it was for the other tests
  await page.getByRole('tab', { name: 'Boards' }).click();
  await page.getByRole('button', { name: 'Open' }).first().click();
  await page.getByRole('button', { name: 'Remove from Studio' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByText('No boards yet.')).toBeVisible();
  await ctx.close();
  fs.rmSync(ws, { recursive: true, force: true });
});

// B1: a plugin's page is a sandboxed frame without an origin, but the network is not taken away by the sandbox:
// every plugin response carries its own CSP (no fetch, WebSocket, beacon or frame) and WebRTC is removed.
test('a plugin page cannot reach the network: fetch, WebSocket, beacons and WebRTC are blocked', async ({ browser }) => {
  const http = await import('node:http');
  const hits: string[] = [];
  const listener = http.createServer((req, res) => { hits.push(req.url || ''); res.end('ok'); });
  await new Promise<void>((r) => listener.listen(0, '127.0.0.1', () => r()));
  const port = (listener.address() as any).port;
  const ctx = await browser.newContext({ baseURL: `http://localhost:${process.env.E2E_APP_PORT || '14232'}/` });
  const page = await ctx.newPage();
  const res = await page.goto('/plugins/board-list/index.html');
  const csp = res?.headers()['content-security-policy'] || '';
  expect(csp).toContain("connect-src 'none'");
  expect(csp).toContain("frame-src 'none'");
  const r = await page.evaluate(async (p) => {
    const out: Record<string, string> = {};
    try { await fetch(`http://127.0.0.1:${p}/fetch`, { method: 'POST', body: 'x', mode: 'no-cors' }); out.fetch = 'sent'; } catch { out.fetch = 'blocked'; }
    out.ws = await new Promise<string>((done) => {
      try {
        const w = new WebSocket(`ws://127.0.0.1:${p}/ws`);
        w.onopen = () => done('open'); w.onerror = () => done('blocked');
        setTimeout(() => done('blocked'), 2000);
      } catch { done('blocked'); }
    });
    out.beacon = navigator.sendBeacon?.(`http://127.0.0.1:${p}/beacon`, 'x') ? 'queued' : 'blocked';
    const img = new Image(); img.src = `http://127.0.0.1:${p}/img`;
    out.rtc = typeof (window as any).RTCPeerConnection === 'undefined' && typeof (window as any).webkitRTCPeerConnection === 'undefined' ? 'gone' : 'present';
    await new Promise((d) => setTimeout(d, 500));
    return out;
  }, port);
  expect(r.fetch).toBe('blocked');
  expect(r.ws).toBe('blocked');
  expect(r.rtc).toBe('gone');
  await page.waitForTimeout(500);
  expect(hits).toEqual([]);
  await ctx.close();
  listener.close();
});

// S12: another program on this computer cannot drive the device layer: the bridge's WebSocket needs its token.
test('the device bridge refuses a WebSocket without its token', async () => {
  const port = process.env.E2E_BRIDGE_PORT || '18792';
  const tryOpen = (q: string) => new Promise<string>((done) => {
    const w = new WebSocket(`ws://127.0.0.1:${port}/${q}`);
    w.onopen = () => { w.close(); done('open'); };
    w.onerror = () => done('refused');
  });
  expect(await tryOpen('')).toBe('refused');
  expect(await tryOpen('?token=wrong')).toBe('refused');
  expect(await tryOpen(`?token=${process.env.SPECTER_BRIDGE_TOKEN}`)).toBe('open');
});
