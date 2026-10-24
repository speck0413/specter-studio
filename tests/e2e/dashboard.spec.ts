// The Dashboard: a practice board is triggered and its tile (runs tonight, lifetime runs, last triggered), the
// fleet total and the live feed follow; a board that only reports over MQTT shows up too; the night is written
// to the library; the board card and the shared page show the counts.
import { test, expect, Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { allowedPlugins } from './consent';

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'specter-dashboard-'));
const BOARD = 'Dash board';
// the device layer's MQTT server cannot be stopped, so it stays up for the specs after this one: the same port as
// studio.spec.ts (E2E_MQTT_PORT), whose adapter and plugin tests then find it running there
const MQTT_PORT = Number(process.env.E2E_MQTT_PORT || '18834');

test.describe.configure({ mode: 'serial' });
let page: Page;
let bridge: WebSocket;
let key = '';
let nextId = 0;
const waiting = new Map<number, (v: any) => void>();

function dl(cmd: string, args: any = {}): Promise<any> {
  const id = ++nextId;
  return new Promise((ok, fail) => {
    waiting.set(id, (v) => (v.ok ? ok(v.result) : fail(new Error(v.error))));
    bridge.send(JSON.stringify({ id, cmd, args }));
  });
}
const board = async (req: any) => (await dl('rpc', { key, req })).result;
// a press of TRIG1 on the practice board, held long enough for its debounce
const pressTrig1 = () => board({ op: 'sim_input', input: 'TRIG1', active: true, lease_ms: 400 });

test.beforeAll(async ({ browser }) => {
  bridge = new WebSocket(`ws://127.0.0.1:${process.env.E2E_BRIDGE_PORT || '18792'}/?token=${process.env.SPECTER_BRIDGE_TOKEN}`);
  await new Promise((r) => bridge.addEventListener('open', r));
  bridge.addEventListener('message', (m) => { const v = JSON.parse(String(m.data)); if (v.id && waiting.has(v.id)) { waiting.get(v.id)!(v); waiting.delete(v.id); } });
  key = (await dl('sim_start', { name: BOARD })).key;
  await board({ op: 'add_example' }); // TRIG1 pulses OUT1 for 2 s
  const ctx = await browser.newContext({ baseURL: `http://localhost:${process.env.E2E_APP_PORT || '14232'}/`, viewport: { width: 1300, height: 900 } });
  const pluginConsent = await allowedPlugins();
  await ctx.addInitScript(([w, c]) => localStorage.setItem('specter-prefs', JSON.stringify({ firstRunDone: true, workspace: w, pluginConsent: c })), [ws, pluginConsent] as const);
  page = await ctx.newPage();
  await page.goto('/');
  await expect(page.getByTestId(`board-${BOARD}`)).toBeVisible({ timeout: 15_000 });
});

test.afterAll(async () => {
  await dl('disconnect', { key }).catch(() => {});
  bridge.close();
  fs.rmSync(ws, { recursive: true, force: true });
});

test('a run on the practice board shows on its tile, in the fleet total and in the feed', async () => {
  await page.getByRole('tab', { name: 'Dashboard' }).click();
  const tile = page.getByTestId(`tile-${BOARD}`);
  await expect(tile.getByTestId('runs-tonight')).toContainText('Runs tonight 0', { timeout: 10_000 });
  const lifetimeBefore = Number((await tile.getByTestId('runs-lifetime').textContent())!.replace(/\D/g, ''));
  await expect(tile.getByTestId('last-triggered')).toContainText('not yet');
  await pressTrig1();
  await expect(tile.getByTestId('runs-tonight')).toContainText('Runs tonight 1', { timeout: 10_000 });
  await expect(tile.getByTestId('runs-lifetime')).toContainText(`Lifetime runs ${(lifetimeBefore + 1).toLocaleString('en-US')}`);
  await expect(tile.getByTestId('last-triggered')).toContainText('just now');
  await expect(page.getByTestId('fleet-tonight')).toContainText('1');
  const feed = page.getByTestId('feed');
  const runLine = feed.locator('li[data-type="run"]').first();
  await expect(runLine).toContainText(BOARD);
  await expect(runLine).toContainText('ran (TRIG1 pressed)');
  // a second run after the example's 2 s pulse and 3 s cooldown (the practice board runs 10x fast)
  await page.waitForTimeout(1500);
  await pressTrig1();
  await expect(tile.getByTestId('runs-tonight')).toContainText('Runs tonight 2', { timeout: 10_000 });
  await expect(feed.locator('li[data-type="run"]')).toHaveCount(2);
});

test('the feed filters by type and board, pauses and clears', async () => {
  const feed = page.getByTestId('feed');
  await page.getByRole('button', { name: 'Runs', exact: true }).click(); // runs off
  await expect(feed.locator('li[data-type="run"]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Runs', exact: true }).click();
  await expect(feed.locator('li[data-type="run"]')).toHaveCount(2);
  await page.getByRole('button', { name: 'Pause' }).click();
  await page.waitForTimeout(1500);
  await pressTrig1();
  await expect(page.getByRole('button', { name: /Resume \(\d+ new\)/ })).toBeVisible({ timeout: 10_000 });
  await expect(feed.locator('li[data-type="run"]')).toHaveCount(2);
  await page.getByRole('button', { name: /Resume/ }).click();
  await expect(feed.locator('li[data-type="run"]')).toHaveCount(3);
  await page.getByRole('combobox', { name: 'Board' }).click();
  await page.getByRole('option', { name: BOARD }).click();
  await expect(feed.locator('li[data-type="run"]')).toHaveCount(3);
  await page.getByRole('combobox', { name: 'Board' }).click();
  await page.getByRole('option', { name: 'All boards' }).click();
  await page.getByRole('button', { name: 'Clear' }).click();
  await expect(feed).toContainText('Nothing yet');
});

test('a board that only reports over MQTT shows up with its counts and events', async () => {
  await dl('mqtt_start', { port: MQTT_PORT });
  const p = 'proptroller/crypt';
  await dl('mqtt_publish', { topic: `${p}/online`, payload: 'true' });
  await dl('mqtt_publish', { topic: `${p}/state`, payload: JSON.stringify({ v: 1, uptime_ms: 60000, outputs: [], runs_since_power_on: 7, runs_lifetime: 1234, last_run_uptime_ms: 55000 }) });
  const tile = page.getByTestId('tile-crypt');
  await expect(tile).toContainText('reports over MQTT', { timeout: 10_000 });
  await expect(tile.getByTestId('runs-tonight')).toContainText('Runs tonight 7');
  await expect(tile.getByTestId('runs-lifetime')).toContainText('Lifetime runs 1,234');
  await dl('mqtt_publish', { topic: `${p}/event`, payload: JSON.stringify({ v: 1, seq: 9, event: 'run', data: { source: 'api', kind: 'effect', name: 'pulse_and_recover', runs_since_power_on: 8, runs_lifetime: 1235, uptime_ms: 61000 } }) });
  const line = page.getByTestId('feed').locator('li[data-type="run"]').first();
  await expect(line).toContainText('crypt', { timeout: 10_000 });
  await expect(line).toContainText('The built-in effect ran');
  await expect(line).toContainText('MQTT');
  await dl('mqtt_publish', { topic: `${p}/online`, payload: 'false' });
  await expect(page.getByTestId('feed').locator('li[data-type="online"]').first()).toContainText('Offline', { timeout: 10_000 });
});

test('the night is written to the library and listed', async () => {
  const dir = path.join(ws, '.specter', 'nights');
  await expect.poll(() => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).length : 0), { timeout: 10_000 }).toBeGreaterThan(0);
  const file = fs.readdirSync(dir).find((f) => f.endsWith('.jsonl'))!;
  const runs = () => fs.readFileSync(path.join(dir, file), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.type === 'run' && e.board === BOARD).length;
  await expect.poll(runs, { timeout: 10_000 }).toBeGreaterThanOrEqual(3); // written every 2 s
  const night = file.replace('.jsonl', '');
  await page.reload();
  await page.getByRole('tab', { name: 'Dashboard' }).click();
  await page.getByTestId(`night-${night}`).click();
  await expect(page.getByTestId('night-detail')).toContainText(BOARD);
  await expect(page.getByTestId('night-detail')).toContainText(/\d+ runs/);
});

test('the board card and the board page show the counts', async () => {
  await page.getByRole('tab', { name: 'Boards' }).click();
  const card = page.getByTestId(`board-${BOARD}`);
  await expect(card.getByTestId('runs-tonight')).toContainText('Runs tonight 3', { timeout: 10_000 });
  await card.getByRole('button', { name: 'Open' }).click();
  await expect(page.getByTestId('run-counts').first()).toContainText('Lifetime runs');
  await page.getByRole('button', { name: 'All boards', exact: true }).click();
});

test('the shared page shows the counts and the fleet total', async ({ browser }) => {
  await page.getByRole('tab', { name: 'Settings' }).first().click();
  await page.getByLabel('Share with others').click();
  await expect(page.getByTestId('share-url')).toBeVisible({ timeout: 10_000 });
  const url = (await page.getByTestId('share-url').textContent())!;
  const viewer = await (await browser.newContext()).newPage();
  await viewer.goto(url);
  const card = viewer.locator(`section[data-board="${BOARD}"]`);
  await expect(card.locator('.tonight')).toHaveText('3', { timeout: 10_000 });
  await expect(card).toContainText('Lifetime runs');
  await expect(card).toContainText('Last triggered');
  await expect(viewer.getByTestId('fleet-tonight')).toContainText('Runs tonight, all boards:');
  await viewer.close();
  await page.getByLabel('Share with others').click();
  await expect(page.getByTestId('share-url')).toHaveCount(0);
});
