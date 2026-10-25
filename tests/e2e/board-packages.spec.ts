// Board packages: one generic firmware image, and the board's pin map sent to it as data. The test extension
// tests/plugins-e2e/board-files-demo offers a made-up "Demo lamp board" package (and one with a wrong pin), a
// profile and a script. Against a practice board (the firmware's simulator answers get_board / set_board): the
// USB install's three choices (Install is never pressed: a real board may be plugged in), Change board package /
// setup… on a board's page with the board's own refusal shown as it said it, the restart question, and Start
// fresh that also forgets the board package.
import { test, expect, Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { allowedPlugins } from './consent';

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'specter-boardpkg-'));
const BOARD = 'Package board';

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
const board = async () => (await dl('rpc', { key, req: { op: 'get_board' } })).result;

test.beforeAll(async ({ browser }) => {
  bridge = new WebSocket(`ws://127.0.0.1:${process.env.E2E_BRIDGE_PORT || '18792'}/?token=${process.env.SPECTER_BRIDGE_TOKEN}`);
  await new Promise((r) => bridge.addEventListener('open', r));
  bridge.addEventListener('message', (m) => { const v = JSON.parse(String(m.data)); if (v.id && waiting.has(v.id)) { waiting.get(v.id)!(v); waiting.delete(v.id); } });
  key = (await dl('sim_start', { name: BOARD })).key;
  const ctx = await browser.newContext({ baseURL: `http://localhost:${process.env.E2E_APP_PORT || '14232'}/`, viewport: { width: 1300, height: 900 } });
  // every test plugin allowed except the one with the board files: this spec allows it on screen
  const pluginConsent: Record<string, string | boolean> = await allowedPlugins();
  delete pluginConsent['board-files-demo'];
  await ctx.addInitScript(([w, c]) => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('specter-prefs', JSON.stringify({ firstRunDone: true, workspace: w, backups: w, pluginConsent: c })); sessionStorage.setItem('seeded', '1'); } }, [ws, pluginConsent] as const);
  page = await ctx.newPage();
  await page.goto('/');
  await expect(page.getByTestId(`board-${BOARD}`)).toBeVisible();
});

test.afterAll(async () => {
  // this file's Studio page goes too: a page left open keeps talking to the shared device layer (and loading the
  // browser) through every later file
  await page?.context().close();
  for (let i = 0; i < 20; i++) {
    await dl('disconnect', { key }).catch(() => {});
    const left = await dl('connections').catch(() => []);
    if (!left.some((c: any) => c.key === key)) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  bridge.close();
  fs.rmSync(ws, { recursive: true, force: true });
});

const optionNames = async () => (await page.getByRole('listbox').getByRole('option').allTextContents());
const pick = async (where: any, label: string, option: RegExp | string) => {
  await where.getByRole('combobox', { name: label }).click();
  await page.getByRole('option', { name: option }).click();
};

test('the practice board takes board packages and says which it runs', async () => {
  const info = (await dl('rpc', { key, req: { op: 'info' } })).result;
  expect(info.capabilities).toContain('board_package');
  const b = await board();
  expect(b.running.source).toBe('built-in');
  expect(b.presets.length).toBeGreaterThan(0);
});

test('Settings allows the extension\'s board files through its consent screen', async () => {
  await page.getByRole('tab', { name: 'Settings' }).first().click();
  const types = page.getByTestId('firmware-types');
  await expect(types).toContainText('2 board packages, the profile Lamp words, the script Lamp on when pressed: offered by the extension “Demo lamp files (test)”, not allowed yet.');
  await types.getByRole('button', { name: 'Allow…' }).click();
  const consent = page.getByRole('dialog', { name: /Allow “Demo lamp files/ });
  await expect(consent).toContainText('Offer for your boards: 2 board packages, profiles (Lamp words), scripts (Lamp on when pressed)');
  await consent.getByRole('button', { name: 'Allow' }).click();
  await expect(types).toContainText('from the extension “Demo lamp files (test)”.');
});

test('a new board over USB: firmware image, board package, profile and script', async () => {
  await page.getByRole('tab', { name: 'Boards' }).first().click();
  const add = page.getByRole('button', { name: 'Add a board' });
  if ((await add.getAttribute('aria-expanded')) !== 'true') await add.click();
  await page.getByRole('button', { name: 'Put firmware on a new board (USB)' }).click();
  const box = page.getByTestId('usb-install');
  await expect(box.getByRole('combobox', { name: 'Firmware image' })).toHaveText('Generic (stock)');
  // the generic image goes on any board with that chip
  await box.getByRole('combobox', { name: 'Kind of board' }).click();
  expect(await optionNames()).toEqual(['ESP32 board', 'Raspberry Pi Pico W']);
  await page.getByRole('option', { name: 'ESP32 board' }).click();
  await box.getByRole('combobox', { name: 'Board package' }).click();
  expect(await optionNames()).toEqual(['Proptroller board (built in)Built into the firmware', 'Demo lamp boardFrom the extension “Demo lamp files (test)”', 'Demo lamp board with a wrong pinFrom the extension “Demo lamp files (test)”']);
  await page.getByRole('option', { name: /^Demo lamp board(?! with)/ }).click();
  // a package file goes on with the firmware: said plainly before anything is written
  await expect(box.getByTestId('usb-install-replaces')).toContainText('replaces the board\'s settings, shows, script and Wi-Fi');
  await box.getByRole('combobox', { name: 'Profile' }).click();
  expect(await optionNames()).toEqual(['None (keep the board’s)', 'Lamp wordsFrom the extension “Demo lamp files (test)”']);
  await page.keyboard.press('Escape');
  await pick(box, 'Script', /Lamp on when pressed/);
  await expect(box.getByRole('combobox', { name: 'Script' })).toHaveText('Lamp on when pressed');
  await box.getByRole('button', { name: 'Close' }).click();
});

test('Change board package / setup…: the board\'s refusal in its own words, nothing changes', async () => {
  await page.getByTestId(`board-${BOARD}`).getByRole('button', { name: 'Open' }).click();
  await page.getByRole('button', { name: 'Change board package / setup…' }).click();
  const dlg = page.getByRole('dialog', { name: `Board package and setup of ${BOARD}` });
  await dlg.getByRole('combobox', { name: 'Board package' }).click();
  const names = await optionNames();
  expect(names[0]).toMatch(/^Keep .+On the board now$/);
  expect(names.some((n) => n.startsWith('Demo lamp boardFrom the extension'))).toBe(true);
  expect(names.some((n) => / \(built in\)Built into the firmware$/.test(n))).toBe(true);
  await page.getByRole('option', { name: /with a wrong pin/ }).click();
  await dlg.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByTestId('action-message')).toContainText('The board did not take the board package: board package: OUT1: GPIO 35 is input-only', { timeout: 15_000 });
  expect((await board()).running.source).toBe('built-in');
  expect((await board()).stored).toBeUndefined();
});

test('a package, profile and script go on; the restart is asked first; the board then runs the package', async () => {
  await page.getByRole('button', { name: 'Change board package / setup…' }).click();
  const dlg = page.getByRole('dialog', { name: `Board package and setup of ${BOARD}` });
  await pick(dlg, 'Board package', /^Demo lamp board(?! with)/);
  await pick(dlg, 'Profile', /Lamp words/);
  await pick(dlg, 'Script', /Lamp on when pressed/);
  await dlg.getByRole('button', { name: 'Send' }).click();
  const ask = page.getByRole('dialog', { name: 'Restart now to use the new board package?' });
  await expect(ask).toContainText('keeps using its old pins until it restarts', { timeout: 15_000 });
  // stored, not yet running
  const pending = await board();
  expect([pending.running.source, pending.stored?.id, pending.stored?.pending]).toEqual(['built-in', 'demo-lamp-board', true]);
  // the profile and script went into the package's own defaults (sent before the restart, the defaults applied at
  // that boot would replace them): they are there after it
  await ask.getByRole('button', { name: 'Restart now' }).click();
  let after: any;
  for (let i = 0; i < 60; i++) {
    after = await board().catch(() => null);
    if (after?.running?.id === 'demo-lamp-board') break;
    await page.waitForTimeout(500);
  }
  expect([after?.running?.id, after?.running?.source]).toEqual(['demo-lamp-board', 'stored']);
  const info = (await dl('rpc', { key, req: { op: 'info' } })).result;
  expect(info.board).toBe('demo-lamp-board');
  let profile: any;
  for (let i = 0; i < 40; i++) {
    profile = (await dl('rpc', { key, req: { op: 'get_profile' } }).catch(() => null))?.result;
    if (JSON.stringify(profile || {}).includes('LAMP')) break;
    await page.waitForTimeout(250);
  }
  expect(JSON.stringify(profile)).toContain('LAMP');
  expect((await dl('rpc', { key, req: { op: 'get_script' } })).result.text).toContain('effect lamp');
});

test('Start fresh can also forget the board package', async () => {
  await page.getByRole('button', { name: 'Change board package / setup…' }).click();
  const dlg = page.getByRole('dialog', { name: `Board package and setup of ${BOARD}` });
  await expect(dlg.getByRole('combobox', { name: 'Board package' })).toHaveText('Keep Demo lamp board', { timeout: 15_000 });
  await dlg.getByRole('checkbox', { name: 'When starting fresh, also forget the board package' }).check();
  await dlg.getByRole('button', { name: "Start fresh with this firmware's defaults…" }).click();
  const ask = page.getByRole('dialog', { name: /fresh with the Generic \(stock\) firmware's defaults/ });
  await expect(ask).toContainText('its stored board package is forgotten too');
  await ask.getByRole('button', { name: 'Start fresh' }).click();
  await expect(page.getByTestId('action-message')).toContainText("restarts with the Generic (stock) firmware's defaults", { timeout: 20_000 });
  let after: any;
  for (let i = 0; i < 60; i++) {
    after = await board().catch(() => null);
    if (after?.running?.source === 'built-in') break;
    await page.waitForTimeout(500);
  }
  expect(after?.running?.source).toBe('built-in');
});

test('with no release published and no folder, the generic firmware that comes with Studio and the Proptroller board are offered', async ({ browser }) => {
  const ctx = await browser.newContext({ baseURL: `http://localhost:${process.env.E2E_APP_PORT || '14232'}/`, viewport: { width: 1300, height: 900 } });
  // a release source with nothing published (the GitHub stand-in has no such repository)
  const consent = await allowedPlugins();
  await ctx.addInitScript(([w, c]) => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('specter-prefs', JSON.stringify({ firstRunDone: true, workspace: w, pluginConsent: c, releases: 'https://github.com/example/nothing-published-here' })); sessionStorage.setItem('seeded', '1'); } }, [ws, consent] as const);
  const p = await ctx.newPage();
  await p.goto('/');
  await p.getByRole('tab', { name: 'Boards' }).first().click();
  const add = p.getByRole('button', { name: 'Add a board' });
  if ((await add.getAttribute('aria-expanded')) !== 'true') await add.click();
  await p.getByRole('button', { name: 'Put firmware on a new board (USB)' }).click();
  const box = p.getByTestId('usb-install');
  // the lists are read first (a moment longer when the whole suite runs)
  await expect(box.getByRole('combobox', { name: 'Firmware image' })).toHaveText('Generic (stock)', { timeout: 15_000 });
  await expect(box.getByRole('combobox', { name: 'Kind of board' })).toHaveText('ESP32 board', { timeout: 15_000 });
  await box.getByRole('combobox', { name: 'Firmware image' }).click();
  // the extensions' types follow it
  expect((await p.getByRole('listbox').getByRole('option').allTextContents())[0]).toBe('Generic (stock)0.0.1 comes with Studio');
  await p.keyboard.press('Escape');
  await expect(box.getByRole('combobox', { name: 'Kind of board' })).toHaveText('ESP32 board');
  await expect(box.getByRole('combobox', { name: 'Board package' })).toHaveText('Proptroller board (built in)');
  await expect(box.getByTestId('no-firmware-yet')).toHaveCount(0);
  await ctx.close();
});
