// A board on USB running an extension's firmware moves to the generic image: the board package goes on in the same
// USB write (a file system image holding it), so the board never runs another pin map. A made-up board on a
// pseudo-terminal (tests/fixtures/fake-usb-board.py) and a release folder made here with an image that passes
// Studio's checks; the write itself cannot succeed on a pretend port, but the file system image Studio put in the
// write is there to read.
import { test, expect, Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, ChildProcess } from 'node:child_process';
import { allowedPlugins } from './consent';

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'specter-usbswitch-'));
const opsFile = path.join(ws, 'ops.txt');
const BOARD = 'USB lamp two';
test.describe.configure({ mode: 'serial' });
let page: Page;
let bridge: WebSocket;
let fake: ChildProcess;
let key = '';
let nextId = 0;
const waiting = new Map<number, (v: any) => void>();
const ops = () => (fs.existsSync(opsFile) ? fs.readFileSync(opsFile, 'utf8').split('\n').filter(Boolean) : []);
// where the device layer writes the files of a USB install (core usb_install: the bridge's temporary folder, which
// need not be this test process's): the one written during this test
const started = Date.now();
function writtenImage(): string | null {
  const dirs = [...new Set([os.tmpdir(), process.env.TMPDIR, path.join(os.homedir(), '.cache', 'tmp'), '/tmp'].filter(Boolean) as string[])];
  const found = dirs.map((d) => path.join(d, 'specter-studio-first-flash', 'board-package-fs.bin'))
    .filter((f) => fs.existsSync(f) && fs.statSync(f).mtimeMs >= started - 1000)
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return found[0] || null;
}

function dl(cmd: string, args: any = {}): Promise<any> {
  const id = ++nextId;
  return new Promise((ok, fail) => {
    waiting.set(id, (v) => (v.ok ? ok(v.result) : fail(new Error(v.error))));
    bridge.send(JSON.stringify({ id, cmd, args }));
  });
}

test.beforeAll(async ({ browser }) => {
  // a generic release in a folder: an ESP32 first-flash image shaped like a merged one (bootloader padding, then the
  // app image's first byte), so Studio's checks pass and the write is tried
  const rel = path.join(ws, 'release');
  fs.mkdirSync(rel);
  const img = Buffer.concat([Buffer.alloc(0x1000, 0xff), Buffer.from([0xe9, 0, 0, 0])]);
  fs.writeFileSync(path.join(rel, 'first-flash-esp32-devkit-9.9.9.bin'), img);
  fs.writeFileSync(path.join(rel, 'proptroller-firmware.json'), JSON.stringify({ version: '9.9.9', images: [
    { fw: 'generic', impl: 'cpp', mcu: 'esp32-devkit', board: 'proptroller', file: 'first-flash-esp32-devkit-9.9.9.bin', bytes: img.length, sha256: createHash('sha256').update(img).digest('hex'), first_flash: true }] }));
  fake = spawn('python3', ['-I', path.resolve('tests/fixtures/fake-usb-board.py'), opsFile, 'demo-lamp', BOARD]);
  const pty: string = await new Promise((res) => fake.stdout!.once('data', (d) => res(String(d).trim())));
  bridge = new WebSocket(`ws://127.0.0.1:${process.env.E2E_BRIDGE_PORT || '18792'}/?token=${process.env.SPECTER_BRIDGE_TOKEN}`);
  await new Promise((r) => bridge.addEventListener('open', r));
  bridge.addEventListener('message', (m) => { const v = JSON.parse(String(m.data)); if (v.id && waiting.has(v.id)) { waiting.get(v.id)!(v); waiting.delete(v.id); } });
  key = (await dl('connect', { serial: pty })).key;
  const ctx = await browser.newContext({ baseURL: `http://localhost:${process.env.E2E_APP_PORT || '14232'}/`, viewport: { width: 1300, height: 900 } });
  const pluginConsent = await allowedPlugins();
  await ctx.addInitScript(([w, c, r]) => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('specter-prefs', JSON.stringify({ firstRunDone: true, workspace: w, backups: w, pluginConsent: c, releases: r })); sessionStorage.setItem('seeded', '1'); } }, [ws, pluginConsent, rel] as const);
  page = await ctx.newPage();
  await page.goto('/');
  await expect(page.getByTestId(`board-${BOARD}`)).toBeVisible({ timeout: 15_000 });
});

test.afterAll(async () => {
  await dl('disconnect', { key }).catch(() => {});
  bridge.close();
  fake.kill();
  fs.rmSync(ws, { recursive: true, force: true });
});

test('to the generic image over USB: the chosen board package goes on in the same write, the name and Wi-Fi are given back', async () => {
  await page.getByTestId(`board-${BOARD}`).getByRole('button', { name: 'Open' }).click();
  await page.getByRole('button', { name: 'Change board package / setup…' }).click();
  const dlg = page.getByRole('dialog', { name: `Board package and setup of ${BOARD}` });
  await dlg.getByRole('combobox', { name: 'Firmware image' }).click();
  await page.getByRole('option', { name: /^Generic \(stock\)/ }).click();
  // picked now, not after the install
  await dlg.getByRole('combobox', { name: 'Board package' }).click();
  await page.getByRole('option', { name: /^Demo lamp board(?! with)/ }).click();
  await dlg.getByLabel('Password of “Lab network”').fill('typed-again');
  await dlg.getByRole('button', { name: 'Next' }).click();
  const ask = page.getByRole('dialog', { name: /Replace the Demo lamp firmware on USB lamp two with Generic \(stock\)\?/ });
  await expect(ask).toContainText('It gets the board package “Demo lamp board” in the same write, so it starts on the right pins at once');
  await ask.getByRole('button', { name: 'Install Generic (stock)' }).click();
  // a pretend port takes no firmware: the write is tried (esptool cannot reach a board there)
  const msg = page.getByTestId('action-message');
  await expect(msg).toContainText(/USB lamp two: (the board did not answer|flashing failed|PlatformIO is not installed)/, { timeout: 120_000 });
  expect(ops()).toContain('get_backup');
  // the file system image in the write holds the chosen package
  const image = writtenImage();
  expect(image).not.toBeNull();
  // (the record is packed in groups of eight with a flag byte between them, so only a short piece reads as it is)
  expect(fs.readFileSync(image!).includes(Buffer.from('"demo-la'))).toBe(true);
  expect(fs.readFileSync(image!).includes(Buffer.from('PTBP'))).toBe(true);
});
