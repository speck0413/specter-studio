// LED patterns in Your library: make one, watch the preview strip animate, move a control, see a plain message for
// a broken or endless pattern, save it, import a pattern file (.epe), see a word's help whole, a colour control with
// nothing chosen yet, and the preview under the desktop window's Content Security Policy (the built app).
import { test, expect, Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { allowedPlugins } from './consent';
import { expectWhollyVisible, hoverWord } from './hover';

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'specter-patterns-'));
const EPE = path.resolve('tests/fixtures/patterns/blue-wave.epe');
// the words beginner mode never shows (tests/e2e/studio.spec.ts, "beginner mode never uses technical words")
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

const colours = (p: Page) => p.getByTestId('pattern-led').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.rgb || ''));

async function openLibrary(p: Page) {
  await p.getByRole('tab', { name: 'Your library' }).click();
  await expect(p.getByTestId('pattern-list')).toBeVisible();
}

/** Replaces the code in the pattern editor (Monaco) with `text`. */
async function setCode(p: Page, text: string) {
  await p.getByTestId('pattern-code').locator('.view-lines').click();
  await p.keyboard.press('ControlOrMeta+A');
  await p.keyboard.press('Delete');
  // pasted, so the editor's closing brackets and indent are not added to it
  await p.evaluate((t) => navigator.clipboard.writeText(t), text);
  await p.keyboard.press('ControlOrMeta+V');
}

test.beforeAll(async ({ browser }) => {
  folder = await dl('workspace_init', { folder: ws });
  const ctx = await browser.newContext({ baseURL: `http://localhost:${process.env.E2E_APP_PORT || '14232'}/`, viewport: { width: 1300, height: 900 } });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
  const pluginConsent = await allowedPlugins();
  await ctx.addInitScript(([w, c]) => { if (!localStorage.getItem('specter-prefs')) localStorage.setItem('specter-prefs', JSON.stringify({ firstRunDone: true, workspace: w, pluginConsent: c })); }, [folder, pluginConsent] as const);
  page = await ctx.newPage();
  await page.goto('/');
  await openLibrary(page);
});

test.afterAll(async () => {
  await page?.context().close();
  fs.rmSync(ws, { recursive: true, force: true });
});

test('a new pattern opens with a preview that animates', async () => {
  expect(fs.existsSync(path.join(folder, 'patterns'))).toBe(true);
  await page.getByRole('button', { name: 'New pattern' }).click();
  await page.getByRole('dialog').getByLabel('Name').fill('my rainbow');
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
  await expect(page.getByTestId('pattern-editor')).toBeVisible();
  await expect(page.getByTestId('pattern-list').getByRole('button', { name: 'my rainbow' })).toBeVisible();
  expect(fs.readFileSync(path.join(folder, 'patterns', 'my rainbow.pattern.js'), 'utf8')).toContain('export function render(index)');
  // 16 lights by default (no board online), lit, and changing from one moment to the next
  await expect(page.getByTestId('pattern-led')).toHaveCount(16);
  await expect.poll(async () => (await colours(page)).filter((c) => c !== '#000000').length, { timeout: 10_000 }).toBe(16);
  const first = await colours(page);
  await expect.poll(async () => (await colours(page)).join(), { timeout: 5_000 }).not.toBe(first.join());
  // beginner words only (the list of studio.spec.ts), and the feature is called patterns
  expect(await page.locator('main').innerText()).not.toMatch(BEGINNER);
});

test('a control changes the pattern', async () => {
  const slider = page.getByTestId('control-sliderSpeed');
  await expect(slider).toBeVisible();
  // the export var shows its value
  await expect(page.getByTestId('var-speed-value')).toHaveText('0.5');
  // a click on the slider's left end, then a drag past its right end
  const box = (await slider.boundingBox())!;
  const y = box.y + box.height / 2;
  await page.mouse.click(box.x + 1, y);
  await expect(page.getByTestId('var-speed-value')).toHaveText('0', { timeout: 5_000 });
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, y, { steps: 5 });
  await page.mouse.move(box.x + box.width + 30, y, { steps: 5 });
  await page.mouse.up();
  await expect(page.getByTestId('var-speed-value')).toHaveText('1', { timeout: 5_000 });
  // still animating
  const a = await colours(page);
  await expect.poll(async () => (await colours(page)).join(), { timeout: 5_000 }).not.toBe(a.join());
});

test('mistakes and endless loops get a plain message, and Save keeps the code', async () => {
  await setCode(page, 'export function render(index) {\n  hsv(hue, 1, 1)\n}\n');
  await expect(page.getByTestId('pattern-error')).toHaveText('Line 2: there is no “hue” (a typo, or a variable that needs “var hue” first?)', { timeout: 5_000 });
  await setCode(page, 'export function render(index) {\n  while (1) {}\n}\n');
  await expect(page.getByTestId('pattern-error')).toContainText('took too long on one frame', { timeout: 5_000 });
  // the window still answers
  await expect(page.getByRole('button', { name: 'Pause' })).toBeEnabled();
  await setCode(page, 'export function render(index) {\n  rgb(index % 2, 0, 1)\n}\n');
  await expect(page.getByTestId('pattern-error')).toHaveCount(0, { timeout: 5_000 });
  await expect.poll(async () => (await colours(page)).slice(0, 2).join(), { timeout: 5_000 }).toBe('#0000ff,#ff00ff');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => fs.readFileSync(path.join(folder, 'patterns', 'my rainbow.pattern.js'), 'utf8')).toContain('rgb(index % 2, 0, 1)');
  // the number of lights follows the field
  await page.getByLabel('Number of lights').fill('30');
  await expect(page.getByTestId('pattern-led')).toHaveCount(30);
  await expect.poll(async () => (await colours(page))[29], { timeout: 5_000 }).toBe('#ff00ff');
  await page.getByLabel('Number of lights').fill('16');
  // an edit not saved yet survives going to another pattern and back
  await setCode(page, 'export function render(index) {\n  rgb(0, 1, 0)\n}\n');
  await expect(page.getByText('not saved', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'New pattern' }).click();
  await page.getByRole('dialog').getByLabel('Name').fill('other');
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
  await expect(page.getByTestId('pattern-editor').getByRole('heading', { name: 'other' })).toBeVisible();
  await page.getByTestId('pattern-list').getByRole('button', { name: 'my rainbow' }).click();
  await expect(page.getByText('Your changes here are not saved yet. Press Save to keep them.')).toBeVisible();
  await expect(page.getByTestId('pattern-code').locator('.view-lines')).toContainText('rgb(0, 1, 0)');
  await expect.poll(async () => (await colours(page))[0], { timeout: 5_000 }).toBe('#00ff00');
  // back to the saved text, and the note about unsaved changes goes with the next save
  await setCode(page, 'export function render(index) {\n  rgb(index % 2, 0, 1)\n}\n');
  await expect(page.getByText('not saved', { exact: true })).toHaveCount(0);
});

test('a pattern file (.epe) is imported under its name', async () => {
  await page.getByTestId('pattern-import').setInputFiles(EPE);
  await expect(page.getByTestId('pattern-list').getByRole('button', { name: 'Blue wave' })).toBeVisible();
  await expect(page.getByTestId('pattern-editor').getByRole('heading', { name: 'Blue wave' })).toBeVisible();
  const saved = fs.readFileSync(path.join(folder, 'patterns', 'Blue wave.pattern.js'), 'utf8');
  expect(saved).toBe(JSON.parse(fs.readFileSync(EPE, 'utf8')).sources.main);
  await expect.poll(async () => (await colours(page)).filter((c) => /^#0[0-9a-f]{3}[1-9a-f]/.test(c)).length, { timeout: 10_000 }).toBeGreaterThan(8);
  // the same file again never replaces it
  await page.getByTestId('pattern-import').setInputFiles(EPE);
  await expect(page.getByTestId('name-taken')).toContainText('this one is called “Blue wave 2”');
  // a file that is not a pattern file
  const bad = path.join(ws, 'notes.epe');
  fs.writeFileSync(bad, 'hello');
  await page.getByTestId('pattern-import').setInputFiles(bad);
  await expect(page.getByRole('alert').filter({ hasText: 'This file is not a pattern file (.epe)' })).toBeVisible();
});

test('the help for a word is seen whole, even at the editor’s right edge', async () => {
  await setCode(page, 'export function render(index) {\n  var level = index / pixelCount; hsv(level, 1, 1)\n}\n');
  await hoverWord(page, page.getByTestId('pattern-code'), 'hsv');
  const hover = page.locator('.monaco-hover').filter({ hasText: 'colours the light being drawn' });
  await expect(hover).toBeVisible({ timeout: 10_000 });
  await expectWhollyVisible(hover);
  await page.mouse.move(0, 0);
});

test('a colour control with nothing chosen yet shows no made-up colour', async () => {
  await setCode(page, 'var hue = 0.08\nexport function hsvPickerColor(h, s, v) { hue = h }\nexport function rgbPickerTint(r, g, b) { }\nexport function render(index) { hsv(hue, 1, 1) }\n');
  const picker = page.getByTestId('control-hsvPickerColor');
  await expect(picker).toBeVisible({ timeout: 10_000 });
  // the pattern starts orange: the swatch says the colour is the pattern's own, never red
  for (const name of ['hsvPickerColor', 'rgbPickerTint']) {
    await expect(page.getByTestId(`swatch-${name}`)).toHaveAttribute('data-unset', 'true');
    await expect(page.getByTestId(`swatch-${name}`)).not.toHaveCSS('background-color', 'rgb(255, 0, 0)');
  }
  await expect(page.getByTestId('pattern-controls')).toContainText('the pattern’s own');
  // the strip shows the pattern's own orange (red full, some green), not red
  await expect.poll(async () => (await colours(page))[0], { timeout: 5_000 }).toMatch(/^#ff(?!00)[0-9a-f]{2}00$/);
  // a colour picked is shown, and the pattern takes it
  await picker.fill('#00ff00');
  await expect(page.getByTestId('swatch-hsvPickerColor')).toHaveAttribute('data-unset', 'false');
  await expect(page.getByTestId('swatch-hsvPickerColor')).toHaveCSS('background-color', 'rgb(0, 255, 0)');
  await expect.poll(async () => (await colours(page))[0], { timeout: 5_000 }).toBe('#00ff00');
  await expect(page.getByTestId('swatch-rgbPickerTint')).toHaveAttribute('data-unset', 'true');
  expect(await page.locator('main').innerText()).not.toMatch(BEGINNER);
});

test('the preview runs under the desktop window’s Content Security Policy', async ({ browser }) => {
  const ctx = await browser.newContext({ baseURL: `http://localhost:${process.env.E2E_PREVIEW_PORT || '14233'}/`, viewport: { width: 1300, height: 900 } });
  const p = await ctx.newPage();
  const blocked: string[] = [];
  p.on('console', (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) blocked.push(m.text()); });
  const pluginConsent = await allowedPlugins();
  await p.addInitScript(([w, c]) => localStorage.setItem('specter-prefs', JSON.stringify({ firstRunDone: true, workspace: w, pluginConsent: c })), [folder, pluginConsent] as const);
  const res = await p.goto('/');
  expect(res?.headers()['content-security-policy']).toContain("script-src 'self'");
  await openLibrary(p);
  await p.getByTestId('pattern-list').getByRole('button', { name: 'my rainbow' }).click();
  await expect.poll(async () => (await colours(p)).slice(0, 2).join(), { timeout: 10_000 }).toBe('#0000ff,#ff00ff');
  expect(blocked).toEqual([]);
  await ctx.close();
});
