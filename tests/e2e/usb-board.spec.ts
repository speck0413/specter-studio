// A board plugged in with USB (a made-up board on a pseudo-terminal, tests/fixtures/fake-usb-board.py): Change board
// package / setup… works through its USB session. Another board package: set_board, then the restart, with no
// flashing. Another firmware image: a backup over USB, then the USB install of the type's list on its port (never
// "not a network board"; the test extension's stand-in image is refused before anything is written).
import { test, expect, Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, ChildProcess } from 'node:child_process';
import { allowedPlugins } from './consent';

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'specter-usbboard-'));
const opsFile = path.join(ws, 'ops.txt');
test.describe.configure({ mode: 'serial' });
let page: Page;
let bridge: WebSocket;
let fake: ChildProcess;
let key = '';
let nextId = 0;
const waiting = new Map<number, (v: any) => void>();
const ops = () => (fs.existsSync(opsFile) ? fs.readFileSync(opsFile, 'utf8').split('\n').filter(Boolean) : []);

function dl(cmd: string, args: any = {}): Promise<any> {
  const id = ++nextId;
  return new Promise((ok, fail) => {
    waiting.set(id, (v) => (v.ok ? ok(v.result) : fail(new Error(v.error))));
    bridge.send(JSON.stringify({ id, cmd, args }));
  });
}

test.beforeAll(async ({ browser }) => {
  fake = spawn('python3', ['-I', path.resolve('tests/fixtures/fake-usb-board.py'), opsFile]);
  const pty: string = await new Promise((res) => fake.stdout!.once('data', (d) => res(String(d).trim())));
  bridge = new WebSocket(`ws://127.0.0.1:${process.env.E2E_BRIDGE_PORT || '18792'}/?token=${process.env.SPECTER_BRIDGE_TOKEN}`);
  await new Promise((r) => bridge.addEventListener('open', r));
  bridge.addEventListener('message', (m) => { const v = JSON.parse(String(m.data)); if (v.id && waiting.has(v.id)) { waiting.get(v.id)!(v); waiting.delete(v.id); } });
  key = (await dl('connect', { serial: pty })).key;
  const ctx = await browser.newContext({ baseURL: `http://localhost:${process.env.E2E_APP_PORT || '14232'}/`, viewport: { width: 1300, height: 900 } });
  const pluginConsent = await allowedPlugins();
  await ctx.addInitScript(([w, c]) => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('specter-prefs', JSON.stringify({ firstRunDone: true, workspace: w, backups: w, pluginConsent: c })); sessionStorage.setItem('seeded', '1'); } }, [ws, pluginConsent] as const);
  page = await ctx.newPage();
  await page.goto('/');
  await expect(page.getByTestId('board-USB lamp')).toBeVisible({ timeout: 15_000 });
});

test.afterAll(async () => {
  await dl('disconnect', { key }).catch(() => {});
  bridge.close();
  fake.kill();
  fs.rmSync(ws, { recursive: true, force: true });
});

test('another board package over USB: set_board, then the restart, no flashing', async () => {
  await page.getByTestId('board-USB lamp').getByRole('button', { name: 'Open' }).click();
  await page.getByRole('button', { name: 'Change board package / setup…' }).click();
  const dlg = page.getByRole('dialog', { name: 'Board package and setup of USB lamp' });
  await dlg.getByRole('combobox', { name: 'Board package' }).click();
  await page.getByRole('option', { name: /^Two lamps \(example\) \(built in\)/ }).click();
  await dlg.getByRole('button', { name: 'Send' }).click();
  const ask = page.getByRole('dialog', { name: 'Restart now to use the new board package?' });
  await expect(ask).toBeVisible({ timeout: 15_000 });
  await ask.getByRole('button', { name: 'Restart now' }).click();
  await expect.poll(() => ops().filter((o) => o === 'set_board' || o === 'reboot'), { timeout: 15_000 }).toEqual(['set_board', 'reboot']);
  expect((await dl('rpc', { key, req: { op: 'get_board' } })).result.running.id).toBe('lamp-two');
});

test('another firmware image over USB: backed up over USB, then written through its port (never "not a network board")', async () => {
  await page.getByRole('button', { name: 'Change board package / setup…' }).click();
  const dlg = page.getByRole('dialog', { name: 'Board package and setup of USB lamp' });
  await dlg.getByRole('combobox', { name: 'Firmware image' }).click();
  await page.getByRole('option', { name: /Demo lamp/ }).click();
  await dlg.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('dialog', { name: /Replace the Generic \(stock\) firmware on USB lamp with Demo lamp\?/ }).getByRole('button', { name: 'Install Demo lamp' }).click();
  const msg = page.getByTestId('action-message');
  // the USB install of the type's list on this board's port: the test extension's stand-in image is refused before
  // anything is written (a real one would go on with esptool)
  await expect(msg).toContainText('USB lamp: the first-flash image is not a merged ESP32 image', { timeout: 90_000 });
  await expect(msg).not.toContainText('network');
  expect(ops()).toContain('get_backup');
  expect(fs.readdirSync(ws).some((f) => f.endsWith('.proptroller.json'))).toBe(true);
});
