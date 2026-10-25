// The pixel strip in effect scripts (`pixels = <effect> <colour>`): the board's checker takes it, the "light the
// pixels" block picks an effect and a colour (also an exact one with the colour picker) and offers no colour after
// rainbow, fire or off, typeahead after `pixels = `, the help links to LED patterns, and the pattern page says
// sending is coming.
import { test, expect, Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { allowedPlugins } from './consent';
import { expectWhollyVisible } from './hover';

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'specter-pixels-'));
const SCRIPT = 'effect lights:\n  pixels = breathe purple\n  wait for trig1\n  pixels = chase red\n  wait 2\n';
const BEGINNER = /JSON|protocol|DSL|\bgit\b|partition|submodule|branch|platformio|MQTT|DMX|\bACKs?\b|checksum|hash|baud|\bms\b|trigger_repeat|sound_trigger|_/i;

test.describe.configure({ mode: 'serial' });
let page: Page;
let folder = '';

async function dl(cmd: string, args: Record<string, unknown> = {}): Promise<any> {
  const sock = new WebSocket(`ws://127.0.0.1:${process.env.E2E_BRIDGE_PORT || '18792'}/?token=${process.env.SPECTER_BRIDGE_TOKEN}`);
  await new Promise((r) => sock.addEventListener('open', r));
  try {
    return await new Promise((ok, fail) => {
      sock.addEventListener('message', (m) => { const v = JSON.parse(String(m.data)); if (v.id === 1) (v.ok ? ok(v.result) : fail(new Error(v.error))); });
      sock.send(JSON.stringify({ id: 1, cmd, args }));
    });
  } finally { sock.close(); }
}

const box = () => page.getByTestId('text-editor');
const text = async () => (await box().locator('.view-line').allTextContents()).map((t) => t.replace(/ /g, ' ')).join('\n');

test.beforeAll(async ({ browser }) => {
  folder = await dl('workspace_init', { folder: ws });
  fs.writeFileSync(path.join(folder, 'effects', 'lights.txt'), SCRIPT);
  await dl('pattern_save', { folder, name: 'glow', text: 'export function render(i) { hsv(0.1, 1, 1) }\n', new: true });
  const ctx = await browser.newContext({ baseURL: `http://localhost:${process.env.E2E_APP_PORT || '14232'}/`, viewport: { width: 1300, height: 900 } });
  const pluginConsent = await allowedPlugins();
  await ctx.addInitScript(([w, c]) => { if (!localStorage.getItem('specter-prefs')) localStorage.setItem('specter-prefs', JSON.stringify({ firstRunDone: true, workspace: w, pluginConsent: c })); }, [folder, pluginConsent] as const);
  page = await ctx.newPage();
  await page.goto('/');
  await page.getByRole('tab', { name: 'Your library' }).click();
  await page.getByRole('button', { name: 'lights' }).click();
  await expect(box().locator('.view-lines')).toContainText('pixels = chase red');
});

test.afterAll(async () => {
  await page?.context().close();
  fs.rmSync(ws, { recursive: true, force: true });
});

test('the board takes the pixel lines, and they are blocks', async () => {
  await expect(page.getByTestId('check')).toContainText('Looks good', { timeout: 10_000 });
  const blocks = page.getByTestId('blocks');
  // Blockly draws a block's next blocks inside it, before its own words
  const canvas = blocks.locator('.blocklySvg .blocklyBlockCanvas').first();
  await expect(canvas).toContainText('light the pixelsbreathe ▾purple ▾');
  await expect(canvas).toContainText('light the pixelschase ▾red ▾');
  expect(await page.locator('main').innerText()).not.toMatch(BEGINNER);
});

test('the block picks an effect and an exact colour', async () => {
  const views = page.getByTestId('editor-view');
  await views.getByRole('button', { name: 'Blocks only' }).click();
  const blocks = page.getByTestId('blocks');
  const chase = blocks.locator('.blocklyBlockCanvas g[data-id]').filter({ hasText: /light\sthe\spixels\s*chase/ }).last(); // the innermost: the chase block itself
  const fields = chase.locator('.blocklyEditableField, .blocklyEditableText');
  await expect(chase).toBeVisible();
  const menuItem = (name: string) => page.locator('.blocklyDropDownDiv').getByRole('option', { name, exact: true });
  await fields.filter({ hasText: /^red/ }).click();
  await expect(menuItem('warm white')).toBeVisible();
  await menuItem('exact colour…').click();
  const picker = page.getByLabel('Pick the exact colour');
  await expect(picker).toBeVisible();
  await picker.fill('#00ff80');
  await page.getByRole('button', { name: 'Done' }).click();
  await fields.filter({ hasText: /^chase/ }).click();
  await menuItem('comet').click();
  await views.getByRole('button', { name: 'Script and blocks' }).click();
  await expect.poll(text).toBe('effect lights:\n  pixels = breathe purple\n  wait for trig1\n  pixels = comet 0x00ff80\n  wait 2\n');
  await expect(page.getByTestId('check')).toContainText('Looks good', { timeout: 10_000 });
});

test('the block offers no colour after an effect that takes none', async () => {
  const views = page.getByTestId('editor-view');
  await views.getByRole('button', { name: 'Blocks only' }).click();
  const blocks = page.getByTestId('blocks');
  const breathe = blocks.locator('.blocklyBlockCanvas g[data-id]').filter({ hasText: /light\sthe\spixels\s*breathe/ }).last();
  await expect(breathe).toBeVisible();
  // the same block after its effect changes
  const block = blocks.locator(`.blocklyBlockCanvas g[data-id="${await breathe.getAttribute('data-id')}"]`);
  const fields = block.locator('.blocklyEditableField, .blocklyEditableText');
  const menu = page.locator('.blocklyDropDownDiv');
  const menuItem = (name: string) => menu.getByRole('option', { name, exact: true });
  await fields.filter({ hasText: /^breathe/ }).click();
  await menuItem('fire').click();
  // the colour written before is kept and marked; the menu offers only the effect's own colours
  await fields.filter({ hasText: /^purple\s\(fire\stakes\sno\scolour\)/ }).click();
  await expect(menuItem('its own colours')).toBeVisible();
  for (const name of ['red', 'warm white', 'exact colour…', 'no colour (white)']) await expect(menuItem(name)).toHaveCount(0);
  await menuItem('its own colours').click();
  await views.getByRole('button', { name: 'Script and blocks' }).click();
  await expect.poll(text).toContain('  pixels = fire\n  wait for trig1\n');
  await expect(page.getByTestId('check')).toContainText('Looks good', { timeout: 10_000 });
});

test('typeahead after pixels =: the effects, then the colours', async () => {
  const suggest = box().locator('.suggest-widget');
  await box().locator('.view-lines').click();
  // the empty line after the last one
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('  pixels = ', { delay: 20 });
  await expect(suggest).toBeVisible();
  await expect(suggest).toContainText('sparkle');
  await page.keyboard.type('spark', { delay: 20 });
  await page.keyboard.press('Enter');
  await expect(suggest).toBeVisible();
  await expect(suggest).toContainText('exact colour');
  await expect(suggest).not.toContainText('sparkle');
  await page.keyboard.type('cya', { delay: 20 });
  await page.keyboard.press('Enter');
  await expect.poll(text).toContain('  pixels = sparkle cyan');
  await expect(page.getByTestId('check')).toContainText('Looks good', { timeout: 10_000 });
});

// a guard: the text typeahead already left the colours out here; the block's colour menu (above) did not
test('typeahead offers no colours after an effect that has its own (rainbow, fire) or none (off)', async () => {
  const suggest = box().locator('.suggest-widget');
  for (const effect of ['fire', 'rainbow', 'off']) {
    // typed by hand, then a space
    await box().locator('.view-lines').click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.press('Enter');
    await page.keyboard.type(`pixels = ${effect} `, { delay: 20 });
    await page.waitForTimeout(500);
    await expect(suggest.filter({ visible: true }).filter({ hasText: /exact colour|cyan/ })).toHaveCount(0);
    await page.keyboard.press('Escape');
    // picked from the list, then a space
    await page.keyboard.press('Enter');
    await page.keyboard.type(`pixels = ${effect.slice(0, -1)}`, { delay: 20 });
    await expect(suggest).toContainText(effect);
    await page.keyboard.press('Enter');
    await page.keyboard.type(' ', { delay: 20 });
    await page.waitForTimeout(500);
    await expect(suggest.filter({ visible: true }).filter({ hasText: /exact colour|cyan/ })).toHaveCount(0);
    await page.keyboard.press('Escape');
  }
  // an effect that takes a colour still offers them
  await page.keyboard.press('Enter');
  await page.keyboard.type('pixels = chase ', { delay: 20 });
  await expect(suggest).toContainText('exact colour');
  await page.keyboard.press('Escape');
});

test('the pixels help links to LED patterns, and the pattern page sends to a board', async () => {
  const word = box().locator('.view-line span span').filter({ hasText: /^pixels$/ }).first();
  await word.hover();
  const hover = page.locator('.monaco-hover').filter({ hasText: 'Lights the LED strip' });
  await expect(hover).toBeVisible({ timeout: 10_000 });
  // near the top of the editor: the help is not cut off at its first line
  await expectWhollyVisible(hover);
  await hover.getByRole('link', { name: 'LED pattern' }).click();
  // unsaved edits: Studio asks or keeps them; either way Your library opens without the effect
  const keep = page.getByRole('dialog').getByRole('button', { name: /Keep|Leave|Discard|Don.t save/ });
  if (await keep.count()) await keep.first().click();
  await expect(page.getByTestId('library-empty')).toBeVisible();
  await expect(page.getByTestId('pattern-list')).toBeVisible();
  await page.getByTestId('pattern-list').getByRole('button', { name: 'glow' }).click();
  await expect(page.getByTestId('pattern-send')).toHaveText('Send to a board…');
});
