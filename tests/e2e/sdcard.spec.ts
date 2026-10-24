// The SD card tool against a fake card: SPECTER_TEST_DRIVES (playwright.config.ts) makes the device layer report one
// card, SPOOKY, whose files are the folder E2E_SDCARD_DIR/card. Formatting it only empties that folder: no disk
// tool ever runs in a test.
import { test, expect, Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { allowedPlugins } from './consent';

const card = path.join(process.env.E2E_SDCARD_DIR!, 'card');
const sounds = fs.mkdtempSync(path.join(os.tmpdir(), 'specter-e2e-sounds-'));
const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'specter-e2e-sdws-'));

test.describe.configure({ mode: 'serial' });
let page: Page;

test.beforeAll(async ({ browser }) => {
  for (const [n, body] of [['rain.mp3', 'RAIN'], ['elevator.mp3', 'ELEVATOR'], ['scream.wav', 'SCREAM!']]) fs.writeFileSync(path.join(sounds, n), body);
  fs.mkdirSync(card, { recursive: true });
  fs.writeFileSync(path.join(card, 'old notes.txt'), 'left from before');
  const ctx = await browser.newContext({ baseURL: `http://localhost:${process.env.E2E_APP_PORT || '14232'}/`, viewport: { width: 1300, height: 900 } });
  const pluginConsent = await allowedPlugins();
  await ctx.addInitScript(([w, c]) => { if (!localStorage.getItem('specter-prefs')) localStorage.setItem('specter-prefs', JSON.stringify({ firstRunDone: true, workspace: w, pluginConsent: c, theme: 'light' })); }, [ws, pluginConsent] as const);
  page = await ctx.newPage();
  await page.goto('/');
});

test.afterAll(() => { fs.rmSync(sounds, { recursive: true, force: true }); fs.rmSync(ws, { recursive: true, force: true }); });

test('sounds go on the card numbered, in the order of the list, and Check finds nothing wrong', async () => {
  // reachable from the library's side bar
  await page.getByRole('tab', { name: 'Your library' }).click();
  await page.getByTestId('library-sdcard').click();
  await expect(page.getByRole('tab', { name: 'SD card' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('heading', { name: 'SD card for sounds' })).toBeVisible();
  await expect(page.getByTestId('sd-drive-SPOOKY')).toContainText('8.0 GB');
  await expect(page.getByRole('radio', { name: /SPOOKY/ })).toBeChecked();

  // add three sounds (the browser's file picker is a prompt for paths)
  const answers = [`${path.join(sounds, 'rain.mp3')}|${path.join(sounds, 'elevator.mp3')}`, path.join(sounds, 'scream.wav')];
  page.on('dialog', (d) => void d.accept(answers.shift() ?? ''));
  await page.getByRole('button', { name: 'Add sounds…' }).click();
  await expect(page.getByTestId('sd-sound')).toHaveCount(2);
  await page.getByRole('button', { name: 'Add sounds…' }).click();
  const labels = page.getByTestId('sd-sound-label');
  await expect(labels).toHaveText(['1 · rain', '2 · elevator', '3 · scream']);

  // scream moves up one, from the keyboard
  await page.getByRole('button', { name: 'Move scream up' }).focus();
  await page.keyboard.press('Enter');
  await expect(labels).toHaveText(['1 · rain', '2 · scream', '3 · elevator']);
  await expect(page.getByTestId('sd-sounds')).toContainText('0002-scream.wav');

  // copy, with Erase and format ticked (the default): the card's name is typed to confirm
  await expect(page.getByRole('checkbox', { name: /Erase and format/ })).toBeChecked();
  await page.getByTestId('sd-copy').click();
  const dlg = page.getByRole('dialog', { name: 'Erase “SPOOKY”?' });
  await expect(dlg.getByRole('button', { name: 'Erase and copy' })).toBeDisabled();
  await dlg.getByRole('textbox', { name: "The card's name" }).fill('spooky');
  await dlg.getByRole('button', { name: 'Erase and copy' }).click();

  const map = page.getByTestId('sd-map');
  await expect(map.getByTestId('sd-map-row')).toHaveText(['10001-rain.mp3', '20002-scream.wav', '30003-elevator.mp3'], { timeout: 15_000 });
  expect(fs.readdirSync(card).sort()).toEqual(['mp3']);
  expect(fs.readdirSync(path.join(card, 'mp3')).sort()).toEqual(['0001-rain.mp3', '0002-scream.wav', '0003-elevator.mp3']);
  expect(fs.readFileSync(path.join(card, 'mp3', '0002-scream.wav'), 'utf8')).toBe('SCREAM!');
  // the person's own files are still there
  expect(fs.readdirSync(sounds).sort()).toEqual(['elevator.mp3', 'rain.mp3', 'scream.wav']);

  // keep the list with the library (sounds.csv, hints for the editor)
  await map.getByRole('button', { name: 'Keep the list with your library' }).click();
  await expect(page.getByTestId('sd-saved')).toContainText('sounds.csv');
  expect(fs.readFileSync(path.join(ws, 'sounds.csv'), 'utf8')).toBe('number,file\n1,rain.mp3\n2,scream.wav\n3,elevator.mp3\n');

  // Check the card: in order, nothing wrong
  await page.getByTestId('sd-check').click();
  await expect(page.getByTestId('sd-check-report')).toContainText('No problems found on SPOOKY (FAT): 3 sounds, in order.');
  await expect(page.getByTestId('sd-check-report').getByRole('list')).toContainText('0002-scream.wav');
  await page.screenshot({ path: test.info().outputPath('sd-card.png'), fullPage: true });

  // no serious accessibility problems, light and dark
  const { default: AxeBuilder } = await import('@axe-core/playwright');
  for (const mode of ['Light', 'Dark']) {
    await page.getByTestId('status-theme').click();
    await page.getByRole('menu', { name: 'Themes' }).getByRole('menuitem', { name: mode, exact: true }).click();
    await expect(page.locator('.MuiMenu-root')).toHaveCount(0);
    await expect(page.getByTestId('status-theme')).toHaveText(mode);
    const r = await new AxeBuilder({ page }).analyze();
    expect(r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${mode}: ${v.id} ${v.nodes[0]?.target}`)).toEqual([]);
  }
});

test('a card copied without formatting lists what it deletes first', async () => {
  fs.writeFileSync(path.join(card, 'stray.txt'), 'x');
  await page.getByRole('checkbox', { name: /Erase and format/ }).uncheck();
  await page.getByTestId('sd-copy').click();
  const dlg = page.getByRole('dialog', { name: 'Delete these files from the card?' });
  await expect(dlg.getByTestId('sd-delete-list')).toContainText('mp3/0001-rain.mp3');
  await expect(dlg.getByTestId('sd-delete-list')).toContainText('stray.txt');
  await dlg.getByRole('button', { name: 'Delete and copy' }).click();
  await expect(page.getByTestId('sd-map').getByTestId('sd-map-row')).toHaveCount(3, { timeout: 15_000 });
  expect(fs.existsSync(path.join(card, 'stray.txt'))).toBe(false);
  await page.getByTestId('sd-check').click();
  await expect(page.getByTestId('sd-check-report')).toContainText('No problems found');
});
