// Effect icons and runs on the cards: an icon and a colour picked in the editor (written as comment lines), the
// icon in the library list and on the board's card, the card filling up while the practice board runs the effect,
// the Dashboard's trigger flash (a still badge with reduced motion, nothing with the setting off), and an
// extension's own icon on its tab and its effect icons in the picker.
import { test, expect, Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { allowedPlugins } from './consent';

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'specter-icons-'));
const BOARD = 'Icon board';
// 30 s at the practice board's 10x speed: a run of about 3 s
const SCRIPT = 'effect scare:\n  wait for trig1\n  out1 = on\n  sleep 30\n  out1 = off\n';

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
const pressTrig1 = () => board({ op: 'sim_input', input: 'TRIG1', active: true, lease_ms: 400 });

test.beforeAll(async ({ browser }) => {
  bridge = new WebSocket(`ws://127.0.0.1:${process.env.E2E_BRIDGE_PORT || '18792'}/?token=${process.env.SPECTER_BRIDGE_TOKEN}`);
  await new Promise((r) => bridge.addEventListener('open', r));
  bridge.addEventListener('message', (m) => { const v = JSON.parse(String(m.data)); if (v.id && waiting.has(v.id)) { waiting.get(v.id)!(v); waiting.delete(v.id); } });
  key = (await dl('sim_start', { name: BOARD })).key;
  const folder = await dl('workspace_init', { folder: ws });
  fs.writeFileSync(path.join(folder, 'effects', 'scare.txt'), SCRIPT);
  const ctx = await browser.newContext({ baseURL: `http://localhost:${process.env.E2E_APP_PORT || '14232'}/`, viewport: { width: 1300, height: 900 } });
  const pluginConsent = await allowedPlugins();
  await ctx.addInitScript(([w, c]) => { if (!localStorage.getItem('specter-prefs')) localStorage.setItem('specter-prefs', JSON.stringify({ firstRunDone: true, workspace: w, pluginConsent: c })); }, [folder, pluginConsent] as const);
  page = await ctx.newPage();
  await page.goto('/');
  await expect(page.getByTestId(`board-${BOARD}`)).toBeVisible({ timeout: 15_000 });
});

test.afterAll(async () => {
  await page?.context().close();
  await dl('disconnect', { key }).catch(() => {});
  bridge.close();
  fs.rmSync(ws, { recursive: true, force: true });
});

test('an icon and a colour picked in the editor are comment lines, shown in the library list', async () => {
  await page.getByRole('tab', { name: 'Your library' }).click();
  const item = page.getByRole('button', { name: /scare/ });
  await expect(item.getByTestId('library-icon')).toHaveAttribute('data-icon', 'play');
  await item.click();
  await expect(page.getByTestId('check')).toContainText('Looks good', { timeout: 10_000 });
  await page.getByTestId('look-picker').click();
  const dlg = page.getByRole('dialog', { name: 'Icon and colour' });
  await dlg.getByRole('button', { name: 'Skull' }).click();
  await dlg.getByRole('button', { name: 'Purple' }).click();
  await expect(dlg.getByRole('button', { name: 'Skull' })).toHaveAttribute('aria-pressed', 'true');
  // the effect's own: a ghost
  await dlg.getByRole('combobox', { name: 'For' }).click();
  await page.getByRole('option', { name: 'Effect “scare”' }).click();
  await dlg.getByRole('button', { name: 'Ghost' }).click();
  await expect(dlg.getByTestId('look-preview')).toHaveAttribute('data-icon', 'ghost');
  await dlg.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('heading', { name: 'scare (not saved)', level: 2 })).toBeVisible();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'scare', level: 2 })).toBeVisible();
  const text = fs.readFileSync(path.join(ws, 'effects', 'scare.txt'), 'utf8');
  expect(text).toBe(`# color: purple\n# icon: skull\n\n# icon: ghost\n${SCRIPT}`);
  await expect(page.getByRole('button', { name: /scare/ }).getByTestId('library-icon')).toHaveAttribute('data-icon', 'skull');
  // the board takes it as it is (comments are skipped by its checker)
  const r = await board({ op: 'set_script', text });
  expect(r.ok ?? r).toBeTruthy();
});

test('the board card shows the icon and fills up while the effect runs', async () => {
  await page.getByRole('tab', { name: 'Boards' }).click();
  const card = page.getByTestId(`board-${BOARD}`);
  await expect(card.getByTestId('card-icon')).toHaveAttribute('data-icon', 'skull', { timeout: 10_000 });
  await expect(card.getByTestId('card-icon')).toHaveAttribute('data-color', '#7b1fa2');
  await pressTrig1();
  const fill = card.getByTestId('card-fill');
  await expect(fill).toBeVisible({ timeout: 5_000 });
  await expect(fill).toHaveAttribute('aria-label', `${BOARD}: “scare” running`);
  // the effect's own icon while it runs, with its name
  await expect(card.getByTestId('card-running')).toContainText('scare');
  await expect(card.getByTestId('card-icon')).toHaveAttribute('data-icon', 'ghost');
  const first = Number(await fill.getAttribute('aria-valuenow'));
  await expect.poll(async () => Number(await fill.getAttribute('aria-valuenow')), { timeout: 3_000 }).toBeGreaterThan(first);
  // and it ends with the run
  await expect(fill).toHaveCount(0, { timeout: 10_000 });
  await expect(card.getByTestId('card-icon')).toHaveAttribute('data-icon', 'skull');
});

test('the Dashboard flashes the effect\'s icon over the card when it starts', async () => {
  await page.getByRole('tab', { name: 'Dashboard' }).click();
  const tile = page.getByTestId(`tile-${BOARD}`);
  await expect(tile.getByTestId('card-icon')).toHaveAttribute('data-icon', 'skull');
  await pressTrig1();
  const flash = tile.getByTestId('trigger-flash');
  await expect(flash).toBeVisible({ timeout: 5_000 });
  await expect(flash).toHaveAttribute('aria-label', `${BOARD} started scare`);
  await expect(flash.getByRole('img', { name: 'Ghost' })).toBeVisible();
  await expect(tile.getByTestId('card-fill')).toBeVisible();
  // gone after a moment, while the run goes on
  await expect(flash).toHaveCount(0, { timeout: 3_000 });
  await expect(tile.getByTestId('card-fill')).toHaveCount(0, { timeout: 10_000 });
});

test('with reduced motion a still badge instead; with the setting off nothing', async () => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const tile = page.getByTestId(`tile-${BOARD}`);
  await pressTrig1();
  const badge = tile.getByTestId('trigger-badge');
  await expect(badge).toBeVisible({ timeout: 5_000 });
  await expect(badge).toContainText('scare');
  await expect(tile.getByTestId('trigger-flash')).toHaveCount(0);
  await expect(badge).toHaveCount(0, { timeout: 3_000 });
  await expect(tile.getByTestId('card-fill')).toHaveCount(0, { timeout: 10_000 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });

  await page.getByRole('tab', { name: 'Settings' }).click();
  const sw = page.getByTestId('trigger-flash-setting').locator('input');
  await expect(sw).toBeChecked();
  await sw.uncheck();
  await page.getByRole('tab', { name: 'Dashboard' }).click();
  await pressTrig1();
  await expect(tile.getByTestId('card-fill')).toBeVisible({ timeout: 5_000 });
  await expect(tile.getByTestId('trigger-flash')).toHaveCount(0);
  await expect(tile.getByTestId('trigger-badge')).toHaveCount(0);
  await expect(tile.getByTestId('card-fill')).toHaveCount(0, { timeout: 10_000 });
  await page.getByRole('tab', { name: 'Settings' }).click();
  await page.getByTestId('trigger-flash-setting').locator('input').check();
});

test('an extension\'s own icon is on its tab, and its effect icons are in the picker', async () => {
  const tab = page.getByRole('tab', { name: 'Board list (example plugin)' });
  await expect(tab.getByTestId('extension-icon-board-list')).toBeVisible();
  expect(await tab.getByTestId('extension-icon-board-list').innerHTML()).toContain('<path');
  await page.getByRole('tab', { name: 'Your library' }).click();
  await page.mouse.move(800, 500); // the tab's tooltip off the list
  await expect(async () => {
    await page.getByRole('button', { name: /scare/ }).click();
    await expect(page.getByRole('heading', { name: 'scare', level: 2 })).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 15_000 });
  await page.getByTestId('look-picker').click();
  const dlg = page.getByRole('dialog', { name: 'Icon and colour' });
  await dlg.getByRole('button', { name: /Lantern \(from Board list/ }).click();
  await expect(dlg.getByTestId('look-preview')).toHaveAttribute('data-icon', 'lantern');
  await dlg.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByTestId('look-picker').getByRole('img')).toHaveAttribute('data-icon', 'lantern');
  // saved, so no unsaved work is left behind for the specs after this one (hot exit is kept by the device layer)
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'scare', level: 2 })).toBeVisible();
  expect(fs.readFileSync(path.join(ws, 'effects', 'scare.txt'), 'utf8')).toContain('# icon: lantern');
});
