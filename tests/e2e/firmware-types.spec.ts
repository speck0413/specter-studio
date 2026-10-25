// Firmware types: the stock firmware plus a type an extension adds (tests/plugins-e2e/firmware-demo, a made-up
// "Demo lamp" with its own release list). The firmware dropdown on a new board's USB install and on a board's
// page; the extension's type appears only once it is allowed; a change of type is asked first and nothing
// happens on Cancel. Nothing is written over USB here: Install is never pressed (a real board may be plugged in).
import { test, expect, Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { allowedPlugins } from './consent';

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'specter-fwtypes-'));
const BOARD = 'Firmware board';

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

test.beforeAll(async ({ browser }) => {
  bridge = new WebSocket(`ws://127.0.0.1:${process.env.E2E_BRIDGE_PORT || '18792'}/?token=${process.env.SPECTER_BRIDGE_TOKEN}`);
  await new Promise((r) => bridge.addEventListener('open', r));
  bridge.addEventListener('message', (m) => { const v = JSON.parse(String(m.data)); if (v.id && waiting.has(v.id)) { waiting.get(v.id)!(v); waiting.delete(v.id); } });
  key = (await dl('sim_start', { name: BOARD })).key;
  const ctx = await browser.newContext({ baseURL: `http://localhost:${process.env.E2E_APP_PORT || '14232'}/`, viewport: { width: 1300, height: 900 } });
  // every test plugin allowed except the one with the firmware list: this spec allows it on screen
  const pluginConsent: Record<string, string | boolean> = await allowedPlugins();
  delete pluginConsent['firmware-demo'];
  await ctx.addInitScript(([w, c]) => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('specter-prefs', JSON.stringify({ firstRunDone: true, workspace: w, pluginConsent: c })); sessionStorage.setItem('seeded', '1'); } }, [ws, pluginConsent] as const);
  page = await ctx.newPage();
  await page.goto('/');
  await expect(page.getByTestId(`board-${BOARD}`)).toBeVisible();
});

test.afterAll(async () => {
  // this file's Studio page goes too: a page left open keeps talking to the shared device layer (and loading the
  // browser) through every later file
  await page?.context().close();
  // the practice board goes (the other specs count boards); after its factory reset it may still be coming back, so
  // until the device layer no longer lists it
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

async function openUsbInstall() {
  await page.getByRole('tab', { name: 'Boards' }).first().click();
  const add = page.getByRole('button', { name: 'Add a board' });
  if ((await add.getAttribute('aria-expanded')) !== 'true') await add.click();
  const open = page.getByRole('button', { name: 'Put firmware on a new board (USB)' });
  if (await open.count()) await open.click();
  return page.getByTestId('usb-install');
}

test('a new board over USB: the firmware dropdown has the stock firmware, the extension\'s type only once allowed', async () => {
  let box = await openUsbInstall();
  await box.getByRole('combobox', { name: 'Firmware image' }).click();
  expect(await optionNames()).toEqual(['Generic (stock)']);
  await page.keyboard.press('Escape');
  // the stock release (tests/fixtures/github-mock.mjs) has USB images for ESP32 and Pico W boards
  await box.getByRole('combobox', { name: 'Kind of board' }).click();
  // the generic image goes on any board with that chip (the board package says which board it is)
  expect(await optionNames()).toEqual(['ESP32 board', 'Raspberry Pi Pico W']);
  await page.keyboard.press('Escape');
  await box.getByRole('button', { name: 'Close' }).click();

  // Settings names the extension's firmware and allows it through its consent screen
  await page.getByRole('tab', { name: 'Settings' }).first().click();
  const types = page.getByTestId('firmware-types');
  await expect(types).toContainText('Demo lamp: offered by the extension “Demo firmware (test)”, not allowed yet.');
  await types.getByRole('button', { name: 'Allow…' }).click();
  const consent = page.getByRole('dialog', { name: /Allow “Demo firmware/ });
  await expect(consent).toContainText('Offer firmware for your boards: Demo lamp');
  await consent.getByRole('button', { name: 'Allow' }).click();
  await expect(types).toContainText('Demo lamp: from the extension “Demo firmware (test)”.');

  box = await openUsbInstall();
  await box.getByRole('combobox', { name: 'Firmware image' }).click();
  expect(await optionNames()).toEqual(['Generic (stock)', 'Demo lamp' + 'From the extension “Demo firmware (test)”']);
  await page.getByRole('option', { name: /Demo lamp/ }).click();
  await expect(box.getByRole('combobox', { name: 'Firmware image' })).toHaveText('Demo lamp');
  // an extension's image has its board built in: no board package to pick, and the reason says so
  await expect(box.getByTestId('board-package-why')).toContainText('has its board built in');
  await expect(box.getByRole('combobox', { name: 'Board package' })).toHaveCount(0);
  // its list has USB images for ESP32 chips only: on the Proptroller board and on a board package of its own
  await box.getByRole('combobox', { name: 'Kind of board' }).click();
  expect(await optionNames()).toEqual(['ESP32 board · Proptroller board', 'ESP32 board · Demo lamp board']);
  await page.keyboard.press('Escape');
  await box.getByRole('button', { name: 'Close' }).click();
});

test('a board\'s page: it says which firmware it runs, and a change of type is asked first', async () => {
  await page.getByRole('tab', { name: 'Boards' }).first().click();
  await page.getByTestId(`board-${BOARD}`).getByRole('button', { name: 'Open' }).click();
  await expect(page.getByText('Generic (stock) firmware · Proptroller board', { exact: false }).first()).toBeVisible({ timeout: 15_000 });
  const before = (await dl('rpc', { key, req: { op: 'info' } })).result;
  await page.getByRole('button', { name: 'Change board package / setup…' }).click();
  const dlg = page.getByRole('dialog', { name: `Board package and setup of ${BOARD}` });
  await dlg.getByRole('combobox', { name: 'Firmware image' }).click();
  expect(await optionNames()).toEqual(['Generic (stock)On the board now', 'Demo lamp' + 'From the extension “Demo firmware (test)”']);
  await page.getByRole('option', { name: /Demo lamp/ }).click();
  await dlg.getByRole('button', { name: 'Next' }).click();
  const ask = page.getByRole('dialog', { name: `Replace the Generic (stock) firmware on ${BOARD} with Demo lamp?` });
  await expect(ask).toContainText('backup');
  await ask.getByRole('button', { name: 'Cancel' }).click();
  await expect(ask).toHaveCount(0);
  const after = (await dl('rpc', { key, req: { op: 'info' } })).result;
  expect([after.fw, after.fw_version, after.fw_build]).toEqual([before.fw, before.fw_version, before.fw_build]);

  // the device layer refuses another type without the confirmation, whoever asks
  const plugins = ['firmware-demo'];
  await expect(dl('update', { key, plugins, fw: 'demo-lamp' })).rejects.toThrow(/confirm the switch/);
  // and an update without a type follows the board's own: nothing newer in the stock list for a practice board
  const plan = await dl('update_plan', { plugins, info: before });
  expect([plan.fw, plan.type_name, plan.out_of_date]).toEqual(['generic', 'Generic (stock)', false]);
});

test('start fresh: a separate, confirmed action under Change board package / setup…; the board takes its firmware\'s defaults', async () => {
  const val = async (k: string) => ((await dl('rpc', { key, req: { op: 'get_params' } })).result.values || []).find((v: any) => v.key === k)?.value;
  const before = await val('trig_debounce_ms');
  await dl('rpc', { key, req: { op: 'set_params', values: [{ key: 'trig_debounce_ms', value: before + 50 }] } });
  expect(await val('trig_debounce_ms')).toBe(before + 50);
  await page.getByRole('button', { name: 'Change board package / setup…' }).click();
  await page.getByRole('dialog', { name: `Board package and setup of ${BOARD}` }).getByRole('button', { name: "Start fresh with this firmware's defaults…" }).click();
  const ask = page.getByRole('dialog', { name: `Start ${BOARD} fresh with the Generic (stock) firmware's defaults?` });
  await expect(ask).toContainText('Wi-Fi');
  // Cancel changes nothing
  await ask.getByRole('button', { name: 'Cancel' }).click();
  expect(await val('trig_debounce_ms')).toBe(before + 50);
  await page.getByRole('button', { name: 'Change board package / setup…' }).click();
  await page.getByRole('dialog', { name: `Board package and setup of ${BOARD}` }).getByRole('button', { name: "Start fresh with this firmware's defaults…" }).click();
  await page.getByRole('dialog', { name: /fresh with the Generic \(stock\) firmware's defaults/ }).getByRole('button', { name: 'Start fresh' }).click();
  await expect(page.getByTestId('action-message')).toContainText("restarts with the Generic (stock) firmware's defaults", { timeout: 20_000 });
  // the board restarted with its defaults
  let after: any;
  for (let i = 0; i < 40; i++) {
    after = await val('trig_debounce_ms').catch(() => undefined);
    if (after === before) break;
    await page.waitForTimeout(500);
  }
  expect(after).toBe(before);
});

test('a USB board that does not answer: Studio says it may have no firmware and offers the USB install on that port', async () => {
  // the test bridge lists a fake ESP32 port (/dev/null, SPECTER_TEST_SERIAL_PORTS in playwright.config.ts): it never answers
  await page.getByRole('tab', { name: 'Boards' }).first().click();
  const add = page.getByRole('button', { name: 'Add a board' });
  if ((await add.getAttribute('aria-expanded')) !== 'true') await add.click();
  await page.getByRole('button', { name: 'Plugged in with USB' }).click();
  await page.getByRole('combobox', { name: 'USB port' }).first().click();
  await page.getByRole('option', { name: /\/dev\/null/ }).click();
  await expect(page.getByRole('button', { name: 'Put firmware on a board (USB)' })).toBeVisible();
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  const note = page.getByRole('alert').filter({ hasText: "doesn't answer like a Specter board yet" });
  await expect(note).toContainText('It may have no Specter firmware. Put firmware on it?', { timeout: 30_000 });
  await note.getByRole('button', { name: 'Put firmware on it…' }).click();
  const box = page.getByTestId('usb-install');
  await expect(box.getByRole('combobox', { name: 'USB port' })).toContainText('/dev/null');
  await expect(box.getByRole('combobox', { name: 'Kind of board' })).toContainText('ESP32 board');
  // nothing is written without the confirmation: Install asks first
  await box.getByRole('button', { name: 'Install' }).click();
  await expect(page.getByRole('dialog', { name: /Put the .* firmware on this board\?/ })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
  await box.getByRole('button', { name: 'Close' }).click();
});

