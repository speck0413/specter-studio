// Start fresh where people look for it: the banner when a board runs another firmware than Studio last saw (a
// change simulated by what Studio remembers for the practice board), Keep mine remembered, and Start fresh from the
// board's Settings tab keeping its name and Wi-Fi network (the password typed again).
import { test, expect, Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { allowedPlugins } from './consent';

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'specter-fresh-'));
const BOARD = 'Fresh board';
const USE = 'Script board one';
const KEEP = 'Script board two';
const scriptKeys: Record<string, string> = {};
const MINE = 'effect mine:\n  wait for trig1\n  out1 = on\n  sleep 1\n  out1 = off\n';
// a made-up board package that brings its own script
const PKG = { board_package: 1, id: 'demo-script-board', name: 'Demo script board', mcu: 'esp32-devkit',
  terminals: { OUT1: { pin: 23 }, OUT2: { pin: 22 }, TRIG1: { pin: 36, active: 'low', pull: 'board' } },
  defaults: { script_name: 'Lamp on when pressed', script: 'effect lamp:\n  wait for trig1\n  out1 = on\n  sleep 2\n  out1 = off\n' } };
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
const bannerOf = (name: string) => page.locator(`[data-testid="fresh-banner"][data-board="${name}"]`);
const param = async (k: string) => ((await dl('rpc', { key, req: { op: 'get_params' } })).result.values || []).find((v: any) => v.key === k)?.value;

test.beforeAll(async ({ browser }) => {
  bridge = new WebSocket(`ws://127.0.0.1:${process.env.E2E_BRIDGE_PORT || '18792'}/?token=${process.env.SPECTER_BRIDGE_TOKEN}`);
  await new Promise((r) => bridge.addEventListener('open', r));
  bridge.addEventListener('message', (m) => { const v = JSON.parse(String(m.data)); if (v.id && waiting.has(v.id)) { waiting.get(v.id)!(v); waiting.delete(v.id); } });
  // each practice board its own id: Studio remembers what a board runs by its id
  const r = await dl('sim_start', { name: BOARD, id: 'f1e5b0a1d001' });
  key = r.key;
  // Studio last saw this board on another firmware type: it now runs the stock one
  const seen: Record<string, any> = { [r.info.id]: { fw: 'demo-lamp', board: r.info.board || 'proptroller' } };
  // two boards that now run a board package with its own script (Studio last saw them on the built-in one)
  for (const [name, id] of [[USE, 'f1e5b0a1d002'], [KEEP, 'f1e5b0a1d003']]) {
    const s = await dl('sim_start', { name, id });
    scriptKeys[name] = s.key;
    await dl('rpc', { key: s.key, req: { op: 'set_script', text: MINE } });
    const set = await dl('rpc', { key: s.key, req: { op: 'set_board', package: PKG } });
    if (!set.ok) throw new Error(JSON.stringify(set));
    await dl('rpc', { key: s.key, req: { op: 'reboot' } });
    for (let i = 0; i < 40; i++) {
      const g = await dl('rpc', { key: s.key, req: { op: 'get_board' } }).catch(() => null);
      if (g?.result?.running?.id === PKG.id) break;
      await new Promise((ok) => setTimeout(ok, 250));
    }
    seen[s.info.id] = { fw: 'generic', board: 'proptroller' };
  }
  const ctx = await browser.newContext({ baseURL: `http://localhost:${process.env.E2E_APP_PORT || '14232'}/`, viewport: { width: 1300, height: 900 } });
  const pluginConsent = await allowedPlugins();
  await ctx.addInitScript(([w, c, s]) => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('specter-prefs', JSON.stringify({ firstRunDone: true, workspace: w, backups: w, pluginConsent: c, firmwareSeen: s })); sessionStorage.setItem('seeded', '1'); } }, [ws, pluginConsent, seen] as const);
  page = await ctx.newPage();
  await page.goto('/');
  await expect(page.getByTestId(`board-${BOARD}`)).toBeVisible();
});

test.afterAll(async () => {
  // this file's Studio page goes too: a page left open keeps talking to the shared device layer (and loading the
  // browser) through every later file
  await page?.context().close();
  for (const k of Object.values(scriptKeys)) await dl('disconnect', { key: k }).catch(() => {});
  for (let i = 0; i < 20; i++) {
    await dl('disconnect', { key }).catch(() => {});
    const left = await dl('connections').catch(() => []);
    if (!left.some((c: any) => c.key === key)) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  bridge.close();
  fs.rmSync(ws, { recursive: true, force: true });
});

test('a board on another firmware than Studio last saw: the banner on its card and page; Keep mine is remembered', async () => {
  const words = "This board now runs Generic (stock). Its stored script and settings are from the previous firmware. Start fresh to load Generic (stock)'s defaults?";
  const card = page.getByTestId(`board-${BOARD}`);
  await expect(card.getByTestId('fresh-banner')).toContainText(words, { timeout: 15_000 });
  await card.getByRole('button', { name: 'Open' }).click();
  const banner = bannerOf(BOARD).first();
  await expect(banner).toContainText(words);
  // the stock firmware brings no script of its own: no question about the script
  await expect(banner.getByRole('button', { name: /script/ })).toHaveCount(0);
  await expect(banner.getByRole('button', { name: 'Start fresh…' })).toBeEnabled();
  await banner.getByRole('button', { name: 'Keep mine' }).click();
  await expect(bannerOf(BOARD)).toHaveCount(0);
  // still gone after a reload (remembered for this board on this firmware)
  await page.reload();
  await expect(page.getByTestId(`board-${BOARD}`)).toBeVisible();
  await page.waitForTimeout(1000);
  await expect(bannerOf(BOARD)).toHaveCount(0);
  const prefs = JSON.parse(await page.evaluate(() => localStorage.getItem('specter-prefs') || '{}'));
  expect(Object.keys(prefs.freshKept || {}).some((k) => k.endsWith('|generic|proptroller'))).toBe(true);
});

test('Start fresh from the Settings tab, keeping its name and Wi-Fi (the board keeps them itself)', async () => {
  const before = await param('trig_debounce_ms');
  await dl('rpc', { key, req: { op: 'set_params', values: [{ key: 'trig_debounce_ms', value: before + 50 }, { key: 'wifi_ssid', value: 'Lab network' }, { key: 'wifi_pass', value: 'not-a-real-one' }] } });
  expect(await param('trig_debounce_ms')).toBe(before + 50);
  await page.getByTestId(`board-${BOARD}`).getByRole('button', { name: 'Open' }).click();
  await page.getByRole('tablist', { name: 'Board sections' }).getByRole('tab', { name: 'Settings' }).click();
  const section = page.getByTestId('start-fresh-section');
  await section.getByRole('button', { name: "Start fresh (this firmware's default settings and script)…" }).click();
  const dlg = page.getByRole('dialog', { name: `Start ${BOARD} fresh` });
  await expect(dlg.getByRole('checkbox', { name: 'Keep its name and Wi-Fi' })).toBeChecked();
  // this firmware keeps them itself (factory_reset keep_wifi): no password to type again
  await expect(dlg).toContainText('The board keeps them itself (and its Wi-Fi password) and comes back on your network.');
  await expect(dlg.getByLabel('Password of “Lab network”')).toHaveCount(0);
  await dlg.getByRole('button', { name: 'Next' }).click();
  const ask = page.getByRole('dialog', { name: `Start ${BOARD} fresh with the Generic (stock) firmware's defaults?` });
  await expect(ask).toContainText('It keeps its name and its Wi-Fi network and password, and comes back on your network.');
  await ask.getByRole('button', { name: 'Start fresh' }).click();
  await expect(page.getByTestId('action-message')).toContainText(`${BOARD} started fresh with the Generic (stock) firmware's defaults and kept its name and Wi-Fi.`, { timeout: 60_000 });
  // the defaults are back; the name and network are the ones it had
  expect(await param('trig_debounce_ms')).toBe(before);
  expect(await param('name')).toBe(BOARD);
  expect(await param('wifi_ssid')).toBe('Lab network');
});

const script = async (name: string) => (await dl('rpc', { key: scriptKeys[name], req: { op: 'get_script' } })).result.text || '';

test('another board package with its own script: Use its script (the old one saved to the library first)', async () => {
  await page.getByRole('tab', { name: 'Boards' }).first().click();
  await page.getByTestId(`board-${USE}`).getByRole('button', { name: 'Open' }).click();
  const banner = bannerOf(USE).first();
  await expect(banner).toContainText("Demo script board comes with its own script (“Lamp on when pressed”). Use it, or keep the script that's on the board now?", { timeout: 15_000 });
  await expect(banner).toContainText('Your other settings, Wi-Fi and name stay.');
  await banner.getByRole('button', { name: "Use Demo script board's script" }).click();
  await expect(page.getByTestId('action-message')).toContainText(`${USE} now runs Demo script board's script “Lamp on when pressed”. Its other settings, Wi-Fi and name are kept. Its old script is kept in Your library as “kept from ${USE}”.`, { timeout: 20_000 });
  expect(await script(USE)).toContain('effect lamp');
  const lib: any[] = await dl('library_list', { folder: ws });
  expect(lib.some((e) => String(e.name).includes(`kept from ${USE}`))).toBe(true);
  await expect(bannerOf(USE)).toHaveCount(0);
});

test('another board package with its own script: Keep my script, and it is not asked again', async () => {
  await page.getByRole('tab', { name: 'Boards' }).first().click();
  await page.getByTestId(`board-${KEEP}`).getByRole('button', { name: 'Open' }).click();
  const banner = bannerOf(KEEP).first();
  await expect(banner.getByRole('button', { name: 'Keep my script' })).toBeVisible({ timeout: 15_000 });
  await banner.getByRole('button', { name: 'Keep my script' }).click();
  await expect(bannerOf(KEEP)).toHaveCount(0);
  expect(await script(KEEP)).toContain('effect mine');
  await page.reload();
  await expect(page.getByTestId(`board-${KEEP}`)).toBeVisible();
  await page.waitForTimeout(1000);
  await expect(bannerOf(KEEP)).toHaveCount(0);
});
