// Board to board: one practice board's script tells another to start an effect (SHOW-SCRIPT.md §11, the firmware's
// board link). Two practice boards on this computer, each with a UDP port of its own and the other's as its link
// peer (`link_peers`, the simulator's --link-peers), so they tell each other straight, without an MQTT broker.
// The tell line is typed with the typeahead (the other board by its network name, then its effect), shown as a
// block, sent, and Front Door's TRIG1 then turns Porch's OUT1 on. The board link settings are in Settings, the key
// as a set-only secret; with the same key on both boards (signed messages) the tell still gets through.
import { test, expect, Page } from '@playwright/test';
import dgram from 'node:dgram';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { allowedPlugins } from './consent';

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'specter-tell-'));
const FRONT = 'Front Door';
const PORCH = 'Porch';
const DOORBELL = 'effect doorbell:\n  wait for trig1\n  wait 1\n';
// at the bridge's simulator speed (10x) "wait 20" keeps OUT1 on for about 2 s, long enough to see
const PORCH_SCRIPT = 'effect blackout:\n  wait for trig1\n  out1 = on\n  wait 20\n  out1 = off\n';

test.describe.configure({ mode: 'serial' });
let page: Page;
let bridge: WebSocket;
let front = '';
let porch = '';
let nextId = 0;
const waiting = new Map<number, (v: any) => void>();

function dl(cmd: string, args: any = {}): Promise<any> {
  const id = ++nextId;
  return new Promise((ok, fail) => {
    waiting.set(id, (v) => (v.ok ? ok(v.result) : fail(new Error(v.error))));
    bridge.send(JSON.stringify({ id, cmd, args }));
  });
}
const rpc = async (key: string, req: any) => dl('rpc', { key, req });
const out1 = async (key: string) => (await rpc(key, { op: 'state' })).result.outputs.find((o: any) => o.channel === 'OUT1').level;
const box = () => page.getByTestId('text-editor');
const text = async () => (await box().locator('.view-line').allTextContents()).map((t) => t.replace(/\u00a0/g, ' ')).join('\n');

async function freeUdpPort(): Promise<number> {
  const s = dgram.createSocket('udp4');
  await new Promise<void>((ok) => s.bind(0, '127.0.0.1', ok));
  const p = s.address().port;
  await new Promise<void>((ok) => s.close(() => ok()));
  return p;
}

async function ring() {
  await rpc(front, { op: 'sim_input', input: 'TRIG1', active: true });
  await new Promise((r) => setTimeout(r, 300));
  await rpc(front, { op: 'sim_input', input: 'TRIG1', active: false });
}

test.beforeAll(async ({ browser }) => {
  bridge = new WebSocket(`ws://127.0.0.1:${process.env.E2E_BRIDGE_PORT || '18792'}/?token=${process.env.SPECTER_BRIDGE_TOKEN}`);
  await new Promise((r) => bridge.addEventListener('open', r));
  bridge.addEventListener('message', (m) => { const v = JSON.parse(String(m.data)); if (v.id && waiting.has(v.id)) { waiting.get(v.id)!(v); waiting.delete(v.id); } });
  const [a, b] = [await freeUdpPort(), await freeUdpPort()];
  front = (await dl('sim_start', { name: FRONT, id: 'tellfront0001', discovery_port: a, link_peers: `127.0.0.1:${b}` })).key;
  porch = (await dl('sim_start', { name: PORCH, id: 'tellporch0002', discovery_port: b, link_peers: `127.0.0.1:${a}` })).key;
  for (const k of [front, porch]) expect((await rpc(k, { op: 'set_params', values: [{ key: 'board_link', value: 'wifi' }] })).ok).toBe(true);
  expect((await rpc(front, { op: 'set_script', text: DOORBELL })).result.ok).toBe(true);
  expect((await rpc(porch, { op: 'set_script', text: PORCH_SCRIPT })).result.ok).toBe(true);
  // Porch lets the blackout be started from elsewhere (remote starts are off by default)
  expect((await rpc(porch, { op: 'set_params', values: [{ key: 'remote_free_effects', value: 'blackout' }] })).ok).toBe(true);
  const ctx = await browser.newContext({ baseURL: `http://localhost:${process.env.E2E_APP_PORT || '14232'}/`, viewport: { width: 1300, height: 900 } });
  const pluginConsent = await allowedPlugins();
  await ctx.addInitScript(([w, c]) => localStorage.setItem('specter-prefs', JSON.stringify({ firstRunDone: true, workspace: w, pluginConsent: c })), [ws, pluginConsent] as const);
  page = await ctx.newPage();
  await page.goto('/');
  // Porch's script is read, so its effects are offered after "tell porch"
  await expect(page.getByTestId(`board-${PORCH}`)).toBeVisible({ timeout: 15_000 });
  await page.getByTestId(`board-${FRONT}`).getByRole('button', { name: 'Open' }).click();
  await page.getByRole('tab', { name: 'Effect script' }).click();
  await expect(box().locator('.view-lines')).toContainText('wait 1', { timeout: 15_000 });
});

test.afterAll(async () => {
  await page?.context().close();
  for (const k of [front, porch]) if (k) await dl('disconnect', { key: k }).catch(() => {}); // the other specs count boards
  bridge.close();
  fs.rmSync(ws, { recursive: true, force: true });
});

test('typeahead after tell: the other boards by network name and all, then the board\'s effects', async () => {
  const suggest = box().locator('.suggest-widget');
  await box().locator('.view-lines').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('  tell ', { delay: 20 });
  await expect(suggest).toBeVisible();
  await expect(suggest).toContainText('porch');
  await expect(suggest).toContainText('all');
  await expect(suggest).not.toContainText('front-door'); // never this board itself
  await page.keyboard.type('porc', { delay: 20 });
  await page.keyboard.press('Enter');
  await expect(suggest).toBeVisible();
  await expect(suggest).toContainText('blackout');
  await page.keyboard.press('Enter');
  await expect.poll(text).toBe('effect doorbell:\n  wait for trig1\n  wait 1\n  tell porch blackout');
  await expect(page.getByTestId('check')).toContainText('Looks good', { timeout: 10_000 });
  // the tell block
  await expect(page.getByTestId('blocks').locator('.blocklySvg .blocklyBlockCanvas').first()).toContainText(/tell\s*porch\s*blackout/);
});

test('the help says how a tell line works', async () => {
  const word = box().locator('.view-line span span').filter({ hasText: /^tell$/ }).first();
  await word.hover();
  const hover = page.locator('.monaco-hover').filter({ hasText: 'Tells another board' });
  await expect(hover).toBeVisible({ timeout: 10_000 });
  await expect(hover).toContainText('remote_free_effects');
  await expect(hover).toContainText('not saved');
  await page.mouse.move(0, 0);
});

test('sent to Front Door, its TRIG1 starts the blackout on Porch', async () => {
  await page.getByRole('button', { name: 'Send to this board only' }).click();
  await expect.poll(async () => (await rpc(front, { op: 'get_script' })).result.text, { timeout: 10_000 }).toContain('tell porch blackout');
  expect(await out1(porch)).toBe(0);
  await ring();
  await expect.poll(() => out1(porch), { timeout: 5000 }).toBe(1000);
  // Front Door's own log says it was sent
  await page.getByRole('tablist', { name: 'Board sections' }).getByRole('tab', { name: 'Activity' }).click();
  await expect(page.getByRole('list', { name: 'Activity' })).toContainText('tell porch blackout', { timeout: 10_000 });
  await expect.poll(() => out1(porch), { timeout: 10_000 }).toBe(0);
});

test('the board link settings: the key is set-only, and with the same key on both the tell still gets through', async () => {
  const KEY = 'e2e-link-key-1';
  await page.getByRole('tablist', { name: 'Board sections' }).getByRole('tab', { name: 'Settings' }).click();
  const more = page.getByRole('button', { name: 'More settings (for experts)' });
  if (await more.count()) await more.click();
  await expect(page.getByLabel('Tell lines go')).toBeVisible();
  await expect(page.getByLabel('Board link group')).toBeVisible();
  const key = page.getByLabel('Board link key');
  await expect(key).toHaveAttribute('type', 'password');
  await expect(key).toHaveValue('');
  await key.fill(KEY);
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByText('Saved.')).toBeVisible({ timeout: 10_000 });
  // never shown or read back
  await expect(key).toHaveValue('');
  await expect(page.getByText(/\(set\) Type a new one/).first()).toBeVisible();
  const params = (await rpc(front, { op: 'get_params' })).result;
  expect(JSON.stringify(params)).not.toContain(KEY);
  // Front Door now signs its tells: Porch without the key drops them, with the same key it takes them
  await ring();
  await new Promise((r) => setTimeout(r, 1500));
  expect(await out1(porch)).toBe(0);
  expect((await rpc(porch, { op: 'set_params', values: [{ key: 'link_key', value: KEY }] })).ok).toBe(true);
  await ring();
  await expect.poll(() => out1(porch), { timeout: 5000 }).toBe(1000);
});
