// The window around the pages: themes, text size, the command palette, back and forward, the side bar.
import { test, expect, Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { allowedPlugins } from './consent';

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'specter-shell-'));
const EFFECT = 'shell test glow';

test.describe.configure({ mode: 'serial' });
let page: Page;

test.beforeAll(async ({ browser }) => {
  fs.mkdirSync(path.join(ws, 'effects'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'effects', `${EFFECT}.txt`), 'effect glow:\n  wait for trig1\n  out1 = on\n  sleep 1\n  out1 = off\n');
  const ctx = await browser.newContext({ baseURL: `http://localhost:${process.env.E2E_APP_PORT || '14232'}/`, viewport: { width: 1300, height: 900 } });
  const pluginConsent = await allowedPlugins();
  // only the first time: a reload keeps what the test changed (theme, text size)
  await ctx.addInitScript(([w, c]) => { if (!localStorage.getItem('specter-prefs')) localStorage.setItem('specter-prefs', JSON.stringify({ firstRunDone: true, workspace: w, pluginConsent: c, theme: 'light' })); }, [ws, pluginConsent] as const);
  page = await ctx.newPage();
  await page.goto('/');
});

test.afterAll(async () => {
  // this file's Studio page goes too: a page left open keeps talking to the shared device layer (and loading the
  // browser) through every later file
  await page?.context().close();
  fs.rmSync(ws, { recursive: true, force: true });
});

const palette = () => page.getByRole('dialog', { name: 'Command palette' });
async function runCommand(text: string) {
  await page.keyboard.press('ControlOrMeta+Shift+P');
  await expect(palette()).toBeVisible();
  await page.keyboard.insertText(text);
  await page.keyboard.press('Enter');
  await expect(palette()).toHaveCount(0);
}

test('command palette: places, actions and boards, from the keyboard or the search box', async () => {
  // every place is listed, with its shortcut
  await page.getByTestId('command-center').click();
  await expect(palette().getByRole('option', { name: /Go to Your library/ })).toBeVisible();
  await expect(palette().getByRole('option', { name: /Stop all boards/ })).toBeVisible();
  await page.keyboard.press('Escape');
  // an action: a practice board, opened straight away
  await runCommand('add a practice board');
  await expect(page.getByRole('heading', { name: 'Practice board 1', level: 2 })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('sidebar-board-Practice board 1')).toBeVisible();
  // a place
  await runCommand('go to library');
  await expect(page.getByRole('tab', { name: 'Your library' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('library-empty')).toContainText('Pick an effect');
  // the places' shortcuts: Ctrl+2 the Dashboard, Ctrl+3 Your library
  await page.keyboard.press('ControlOrMeta+2');
  await expect(page.getByRole('tab', { name: 'Dashboard' })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ControlOrMeta+3');
  await expect(page.getByRole('tab', { name: 'Your library' })).toHaveAttribute('aria-selected', 'true');
  // an effect by name, and the arrow keys
  await page.keyboard.press('ControlOrMeta+Shift+P');
  await page.keyboard.insertText('effect shell test');
  await expect(palette().getByRole('option')).toHaveCount(1);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: EFFECT, level: 2 })).toBeVisible();
  // a board by name
  await runCommand('open board practice');
  await expect(page.getByRole('heading', { name: 'Practice board 1', level: 2 })).toBeVisible();
});

test('back and forward: Alt+Left / Alt+Right, the title bar buttons and the mouse buttons', async () => {
  // where we were: Practice board 1, before it the effect, before that the library
  await page.getByRole('tab', { name: 'Plot' }).click();
  await page.keyboard.press('Alt+ArrowLeft');
  await expect(page.getByRole('heading', { name: EFFECT, level: 2 })).toBeVisible();
  await page.keyboard.press('Alt+ArrowRight');
  await expect(page.getByRole('heading', { name: 'Practice board 1', level: 2 })).toBeVisible();
  // the board comes back with the section it was on
  await expect(page.getByRole('tab', { name: 'Plot' })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: 'Go back' }).click();
  await expect(page.getByRole('heading', { name: EFFECT, level: 2 })).toBeVisible();
  await page.getByRole('button', { name: 'Go forward' }).click();
  await expect(page.getByRole('heading', { name: 'Practice board 1', level: 2 })).toBeVisible();
  // the mouse's back (button 3) and forward (button 4)
  await page.evaluate(() => window.dispatchEvent(new MouseEvent('mouseup', { button: 3 })));
  await expect(page.getByRole('heading', { name: EFFECT, level: 2 })).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new MouseEvent('mouseup', { button: 4 })));
  await expect(page.getByRole('heading', { name: 'Practice board 1', level: 2 })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Go forward' })).toBeDisabled();
});

test('side bar: a board opens from it, right-click has its actions, Ctrl+B hides it', async () => {
  await page.getByRole('tab', { name: 'Boards' }).click();
  await expect(page.getByTestId('board-Practice board 1')).toBeVisible(); // the overview
  const row = page.getByTestId('sidebar-board-Practice board 1');
  await row.click({ button: 'right' });
  const menu = page.getByRole('menu', { name: 'What to do with Practice board 1' });
  await expect(menu.getByRole('menuitem', { name: 'Back up' })).toBeVisible();
  await menu.getByRole('menuitem', { name: 'Its settings' }).click();
  await expect(page.getByRole('heading', { name: 'Practice board 1', level: 2 })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Settings' }).last()).toHaveAttribute('aria-selected', 'true');
  // an effect in Your library has its own menu
  await page.getByRole('tab', { name: 'Your library' }).click();
  await page.getByRole('button', { name: new RegExp(EFFECT) }).click({ button: 'right' });
  const fx = page.getByRole('menu', { name: `What to do with “${EFFECT}”` });
  await expect(fx.getByRole('menuitem', { name: 'Duplicate…' })).toBeVisible();
  await fx.getByRole('menuitem', { name: 'Open' }).click();
  await expect(page.getByRole('heading', { name: EFFECT, level: 2 })).toBeVisible();
  await page.keyboard.press('ControlOrMeta+B');
  await expect(page.getByTestId('side-bar')).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+B');
  await expect(page.getByTestId('side-bar')).toBeVisible();
});

test('themes: picked in Settings or the status bar, kept after a restart; the top bar switches light and dark', async () => {
  const bg = () => page.locator('body').evaluate((b) => getComputedStyle(b).backgroundColor);
  await page.getByRole('tab', { name: 'Settings' }).first().click();
  await page.getByRole('combobox', { name: 'Theme' }).click();
  await page.getByRole('option', { name: 'Halloween' }).click();
  await expect(page.getByTestId('status-theme')).toHaveText('Halloween');
  expect(await bg()).toBe('rgb(22, 18, 26)'); // #16121a
  await page.reload();
  await expect(page.getByTestId('status-theme')).toHaveText('Halloween');
  // the status bar's theme menu
  await page.getByTestId('status-theme').click();
  await page.getByRole('menu', { name: 'Themes' }).getByRole('menuitem', { name: 'Gruvbox', exact: true }).click();
  await expect(page.getByTestId('status-theme')).toHaveText('Gruvbox');
  expect(await bg()).toBe('rgb(40, 40, 40)'); // #282828
  // the quick toggle goes to the theme's light partner and back
  await page.getByRole('button', { name: 'Use the light theme' }).click();
  await expect(page.getByTestId('status-theme')).toHaveText('Gruvbox light');
  await page.getByRole('button', { name: 'Use the dark theme' }).click();
  await expect(page.getByTestId('status-theme')).toHaveText('Gruvbox');
  // and from the palette
  await runCommand('theme light');
  await expect(page.getByTestId('status-theme')).toHaveText('Light');
});

test('text size: Ctrl + / - and Ctrl + mouse wheel scale everything, kept after a restart, Ctrl+0 resets', async () => {
  const size = () => page.locator('main').evaluate((m) => parseFloat(getComputedStyle(m).fontSize));
  const zoom = page.getByTestId('status-zoom');
  await expect(zoom).toHaveText('Text 100 %');
  const before = await size();
  await page.keyboard.press('ControlOrMeta+Equal');
  await page.keyboard.press('ControlOrMeta+Equal');
  await expect(zoom).toHaveText('Text 120 %');
  expect(await size()).toBeCloseTo(before * 1.2, 0);
  // Ctrl + wheel: our zoom, not the page scrolling
  const main = page.locator('main');
  await main.hover();
  const scrolled = await main.evaluate((m) => m.scrollTop);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -120);
  await page.keyboard.up('Control');
  await expect(zoom).toHaveText('Text 130 %');
  expect(await main.evaluate((m) => m.scrollTop)).toBe(scrolled);
  await page.keyboard.press('ControlOrMeta+Minus');
  await expect(zoom).toHaveText('Text 120 %');
  await page.reload();
  await expect(page.getByTestId('status-zoom')).toHaveText('Text 120 %');
  await expect(page.getByTestId('status-theme')).toHaveText('Light');
  await page.keyboard.press('ControlOrMeta+0');
  await expect(page.getByTestId('status-zoom')).toHaveText('Text 100 %');
  // Settings has the same choice; the status bar click resets it
  await page.getByRole('tab', { name: 'Settings' }).first().click();
  await page.getByRole('combobox', { name: 'Text size' }).click();
  await page.getByRole('option', { name: '150 %' }).click();
  await expect(page.getByTestId('status-zoom')).toHaveText('Text 150 %');
  await page.getByTestId('status-zoom').click();
  await expect(page.getByTestId('status-zoom')).toHaveText('Text 100 %');
});

test('the practice board goes again (the other test files share the device layer)', async () => {
  await runCommand('open board practice board 1');
  await page.getByRole('button', { name: 'Remove from Studio' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByTestId('sidebar-empty')).toBeVisible();
});
