// Hot exit: unsaved effect edits survive the page going away without saving (a reload here; a crash, a kill or
// the computer shutting down in the desktop app). They come back with a note, Keep / Discard each, and an effect
// saved elsewhere meanwhile shows both versions to pick from.
import { test, expect, Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { allowedPlugins } from './consent';

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'specter-hotexit-'));
const effect = path.join(ws, 'effects', 'porch fog.txt');
const cache = path.join(ws, '.specter', 'unsaved.json');
const V1 = 'effect porch:\n  wait for trig1\n  out1 = on\n  sleep 3\n  out1 = off\n';

test.describe.configure({ mode: 'serial' });
let page: Page;

test.beforeAll(async ({ browser }) => {
  fs.mkdirSync(path.dirname(effect), { recursive: true });
  fs.writeFileSync(effect, V1);
  const ctx = await browser.newContext({ baseURL: `http://localhost:${process.env.E2E_APP_PORT || '14232'}/`, viewport: { width: 1300, height: 900 } });
  const pluginConsent = await allowedPlugins();
  await ctx.addInitScript(([w, c]) => localStorage.setItem('specter-prefs', JSON.stringify({ firstRunDone: true, workspace: w, pluginConsent: c })), [ws, pluginConsent] as const);
  page = await ctx.newPage();
  page.on('dialog', (d) => void d.accept()); // the browser's "leave the page?" on a reload with unsaved edits
  await page.goto('/');
});

test.afterAll(async () => {
  // this file's Studio page goes too: a page left open keeps talking to the shared device layer (and loading the
  // browser) through every later file
  await page?.context().close();
  fs.rmSync(ws, { recursive: true, force: true });
});

async function openEffect() {
  await page.getByRole('tab', { name: 'Your library' }).click();
  await page.getByRole('button', { name: /porch fog/ }).first().click();
}

async function addLine(line: string) {
  await page.getByTestId('text-editor').locator('.view-lines').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.press('Enter');
  await page.keyboard.insertText(line);
  await expect(page.getByRole('heading', { name: 'porch fog (not saved)', level: 2 })).toBeVisible();
  // kept on disk a moment later, before anything is saved
  await expect.poll(() => (fs.existsSync(cache) ? fs.readFileSync(cache, 'utf8') : ''), { timeout: 5_000 }).toContain(line);
}

test('an unsaved edit survives a reload and comes back with a note', async () => {
  await openEffect();
  await addLine('# kept for later');
  expect(fs.readFileSync(effect, 'utf8')).toBe(V1); // nothing saved
  await page.reload();
  const note = page.getByTestId('restore-note');
  await expect(note).toContainText('Restored your unsaved changes from last time');
  await expect(note).toContainText('The effect “porch fog”: not saved yet.');
  await openEffect();
  await expect(page.getByRole('heading', { name: 'porch fog (not saved)', level: 2 })).toBeVisible();
  await expect(page.getByTestId('text-editor').locator('.view-lines')).toContainText('# kept for later');
  await expect(page.getByText('Restored your unsaved changes from last time. Press Save to keep them.')).toBeVisible();
  await note.getByRole('group', { name: 'effect porch fog' }).getByRole('button', { name: 'Keep' }).click();
  await expect(note).toHaveCount(0);
  // saving it: the library has it, and nothing is left in the cache
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'porch fog', level: 2 })).toBeVisible();
  expect(fs.readFileSync(effect, 'utf8')).toContain('# kept for later');
  await expect.poll(() => fs.existsSync(cache), { timeout: 5_000 }).toBe(false);
});

test('Discard drops a restored edit', async () => {
  await addLine('# not wanted');
  await page.reload();
  const note = page.getByTestId('restore-note');
  await note.getByRole('group', { name: 'effect porch fog' }).getByRole('button', { name: 'Discard' }).click();
  await expect(note).toHaveCount(0);
  await openEffect();
  await expect(page.getByRole('heading', { name: 'porch fog', level: 2 })).toBeVisible();
  await expect(page.getByTestId('text-editor').locator('.view-lines')).not.toContainText('# not wanted');
  await expect.poll(() => fs.existsSync(cache), { timeout: 5_000 }).toBe(false);
});

test('saved elsewhere meanwhile: both versions side by side, pick one', async () => {
  await addLine('# my version');
  // another computer (a shared library folder) saves the same effect
  const elsewhere = fs.readFileSync(effect, 'utf8').trimEnd() + '\n# saved on the laptop\n';
  fs.writeFileSync(effect, elsewhere);
  await page.reload();
  const note = page.getByTestId('restore-note');
  await expect(note).toContainText('it was saved again since then, so there are two versions');
  await note.getByRole('button', { name: 'Compare and pick…' }).click();
  const dlg = page.getByRole('dialog', { name: 'Two versions of “porch fog”' });
  await expect(dlg.getByTestId('compare-mine')).toContainText('# my version');
  await expect(dlg.getByTestId('compare-mine')).not.toContainText('# saved on the laptop');
  await expect(dlg.getByTestId('compare-library')).toContainText('# saved on the laptop');
  await dlg.getByRole('button', { name: 'Decide later' }).click();
  // the editor says so too, and offers the same choice
  await openEffect();
  await expect(page.getByText('This effect was saved again since Studio kept your unsaved changes')).toBeVisible();
  await page.getByRole('button', { name: 'Compare and pick…' }).last().click();
  await page.getByRole('dialog').getByRole('button', { name: "Use the library's version" }).click();
  await expect(note).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'porch fog', level: 2 })).toBeVisible();
  await expect(page.getByTestId('text-editor').locator('.view-lines')).toContainText('# saved on the laptop');
  await expect(page.getByTestId('text-editor').locator('.view-lines')).not.toContainText('# my version');
  expect(fs.readFileSync(effect, 'utf8')).toBe(elsewhere);
  await expect.poll(() => fs.existsSync(cache), { timeout: 5_000 }).toBe(false);
});

test('Keep my changes after a conflict: mine stay unsaved until Save', async () => {
  await addLine('# mine again');
  fs.writeFileSync(effect, fs.readFileSync(effect, 'utf8').trimEnd() + '\n# laptop again\n');
  await page.reload();
  await page.getByTestId('restore-note').getByRole('button', { name: 'Compare and pick…' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Keep my changes' }).click();
  await expect(page.getByTestId('restore-note')).toHaveCount(0);
  await openEffect();
  await expect(page.getByRole('heading', { name: 'porch fog (not saved)', level: 2 })).toBeVisible();
  await expect(page.getByTestId('text-editor').locator('.view-lines')).toContainText('# mine again');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'porch fog', level: 2 })).toBeVisible();
  expect(fs.readFileSync(effect, 'utf8')).toContain('# mine again');
  await expect.poll(() => fs.existsSync(cache), { timeout: 5_000 }).toBe(false);
});

// bench run 2026-10-22: a line typed and deleted again is no unsaved change. (On the bench the last Backspace
// took the indent Monaco put after Enter and left a blank line, so the text was not the saved one; one more
// Backspace, or Ctrl+Z, brings it back exactly.)
for (const how of ['Backspace', 'Undo'] as const) {
  test(`an edit undone back to the saved text is not kept as unsaved (${how})`, async () => {
    await page.reload();
    await openEffect();
    await expect(page.getByRole('heading', { name: 'porch fog', level: 2, exact: true })).toBeVisible();
    await page.getByTestId('text-editor').locator('.view-line', { hasText: 'wait for trig1' }).click();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('out9 = on');
    await expect(page.getByRole('heading', { name: 'porch fog (not saved)', level: 2 })).toBeVisible();
    await expect.poll(() => (fs.existsSync(cache) ? fs.readFileSync(cache, 'utf8') : ''), { timeout: 5_000 }).toContain('out9 = on');
    if (how === 'Backspace') {
      for (let i = 0; i < 'out9 = on'.length; i++) await page.keyboard.press('Backspace');
      await page.keyboard.press('Backspace'); // the indent after the line break
      await expect(page.getByRole('heading', { name: 'porch fog (not saved)', level: 2 })).toBeVisible(); // a blank line is left: a change
      await page.keyboard.press('Backspace'); // the line break
    } else {
      for (let i = 0; i < 6 && await page.getByRole('heading', { name: 'porch fog (not saved)', level: 2 }).isVisible(); i++) {
        await page.keyboard.press('ControlOrMeta+z');
        await page.waitForTimeout(150);
      }
    }
    await expect(page.getByRole('heading', { name: 'porch fog', level: 2, exact: true })).toBeVisible();
    await expect.poll(() => fs.existsSync(cache), { timeout: 5_000 }).toBe(false);
    await page.reload();
    await expect(page.getByTestId('restore-note')).toHaveCount(0);
  });
}
