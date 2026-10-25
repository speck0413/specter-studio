// Ctrl+S / ⌘S saves the script on screen (the library's editor, in the script and in the blocks; a board's Effect
// script tab), and the Sound tile plays the board's sound player (a practice board's sound player model).
import { test, expect, Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { allowedPlugins } from './consent';

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'specter-save-'));
const effect = path.join(ws, 'effects', 'porch fog.txt');
const V1 = 'effect porch:\n  wait for trig1\n  out1 = on\n  sleep 3\n  out1 = off\n';

test.describe.configure({ mode: 'serial' });
let page: Page;
let board = '';

async function deviceLayer<T = any>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  const sock = new WebSocket(`ws://127.0.0.1:${process.env.E2E_BRIDGE_PORT || '18792'}/?token=${process.env.SPECTER_BRIDGE_TOKEN}`);
  await new Promise((r) => sock.addEventListener('open', r));
  try {
    return await new Promise<T>((ok, fail) => {
      sock.addEventListener('message', (m) => { const v = JSON.parse(String(m.data)); if (v.id === 1) (v.ok ? ok(v.result) : fail(new Error(v.error))); });
      sock.send(JSON.stringify({ id: 1, cmd, args }));
    });
  } finally { sock.close(); }
}
const keyOf = async (name: string) => {
  for (const c of await deviceLayer<any[]>('connections')) {
    const r = await deviceLayer('rpc', { key: c.key, req: { op: 'info' } }).catch(() => null);
    if (r?.result?.name === name) return c.key as string;
  }
  throw new Error(`no board ${name}`);
};

test.beforeAll(async ({ browser }) => {
  fs.mkdirSync(path.dirname(effect), { recursive: true });
  fs.writeFileSync(effect, V1);
  const ctx = await browser.newContext({ baseURL: `http://localhost:${process.env.E2E_APP_PORT || '14232'}/`, viewport: { width: 1300, height: 900 } });
  const pluginConsent = await allowedPlugins();
  await ctx.addInitScript(([w, c]) => localStorage.setItem('specter-prefs', JSON.stringify({ firstRunDone: true, workspace: w, pluginConsent: c })), [ws, pluginConsent] as const);
  page = await ctx.newPage();
  page.on('dialog', (d) => void d.accept());
  await page.goto('/');
});

test.afterAll(async () => {
  // this file's Studio page goes too: a page left open keeps talking to the shared device layer (and loading the
  // browser) through every later file
  await page?.context().close();
  // the practice board goes (the other specs count boards and expect their own Practice board 1)
  if (board) await deviceLayer('disconnect', { key: await keyOf(board) }).catch(() => {});
  fs.rmSync(ws, { recursive: true, force: true });
});

test('Ctrl+S in the library editor saves the script, the same as Save', async () => {
  await page.getByRole('tab', { name: 'Your library' }).click();
  await page.getByRole('button', { name: /porch fog/ }).first().click();
  await page.getByTestId('text-editor').locator('.view-lines').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.insertText('\n# saved with the keyboard');
  await expect(page.getByRole('heading', { name: 'porch fog (not saved)', level: 2 })).toBeVisible();
  // focus is inside the code editor
  await page.keyboard.press('ControlOrMeta+S');
  await expect(page.getByRole('heading', { name: 'porch fog', exact: true, level: 2 })).toBeVisible();
  await expect(page.getByTestId('editor-message')).toHaveText('Saved “porch fog”.');
  await expect.poll(() => fs.readFileSync(effect, 'utf8')).toContain('# saved with the keyboard');
  // with nothing changed it says so (and the window's own Save page never opens: the page is still here)
  await page.keyboard.press('ControlOrMeta+S');
  await expect(page.getByTestId('editor-message')).toHaveText('“porch fog” is already saved.');
  // the command palette has it, with its shortcut
  await page.getByRole('heading', { name: 'porch fog', exact: true, level: 2 }).click();
  await page.keyboard.press('ControlOrMeta+Shift+P');
  await page.getByRole('combobox', { name: 'Search boards, effects and commands' }).fill('save');
  await expect(page.getByRole('option', { name: /^Save “porch fog” \((Ctrl\+S|⌘S)\)$/ })).toBeVisible();
  await page.keyboard.press('Escape');
});

test('Ctrl+S in the blocks view saves the script', async () => {
  const views = page.getByTestId('editor-view');
  await views.getByRole('button', { name: 'Blocks only' }).click();
  await expect(page.getByTestId('text-editor')).toHaveCount(0);
  // the effect's own blocks (not the ones to drag in from the left)
  const canvas = page.getByTestId('blocks').locator('svg.blocklySvg > .blocklyWorkspace > .blocklyBlockCanvas');
  // the time opens a number with a unit (the block field shows "3 s")
  await canvas.locator('.blocklyEditableField, .blocklyEditableText').filter({ hasText: /^3\s+s/ }).first().click();
  await page.getByRole('spinbutton', { name: 'How long' }).fill('4');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'porch fog (not saved)', level: 2 })).toBeVisible();
  await page.keyboard.press('ControlOrMeta+S');
  await expect(page.getByRole('heading', { name: 'porch fog', exact: true, level: 2 })).toBeVisible();
  await expect.poll(() => fs.readFileSync(effect, 'utf8')).toContain('wait 4');  // a changed block writes wait
  await views.getByRole('button', { name: 'Script and blocks' }).click();
});

test('Ctrl+S on a board\'s Effect script tab does Save and send', async () => {
  await page.keyboard.press('ControlOrMeta+Shift+P');
  await page.getByRole('combobox', { name: 'Search boards, effects and commands' }).fill('Add a practice board');
  await page.keyboard.press('Enter');
  const heading = page.getByRole('navigation', { name: 'Where you are' }).getByRole('heading', { level: 2 });
  await expect(heading).toHaveText(/Practice board/, { timeout: 15_000 });
  board = (await heading.textContent())!;
  const key = await keyOf(board);
  const onBoard = async () => (await deviceLayer('rpc', { key, req: { op: 'get_script' } })).result.text as string;
  await page.getByRole('tab', { name: 'Effect script' }).click();
  const panel = page.getByTestId('board-script-panel');
  await panel.getByTestId('text-editor').locator('.view-lines').click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.insertText('effect stairs:\n  wait for trig1\n  out2 = on\n  sleep 1\n  out2 = off\n');
  await expect(panel.getByTestId('check')).toContainText('Looks good', { timeout: 10_000 });
  await expect(panel.getByTestId('board-script-actions')).toContainText(/(Ctrl\+S|⌘S) does Save and send/);
  // not in the library yet: Save and send asks for a name first
  await page.keyboard.press('ControlOrMeta+S');
  await page.getByRole('dialog').getByLabel('Name').fill('stairs');
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText(`“stairs” is on ${board} and running.`)).toBeVisible({ timeout: 10_000 });
  expect(fs.readFileSync(path.join(ws, 'effects', 'stairs.txt'), 'utf8')).toContain('out2 = on');
  await expect.poll(onBoard).toContain('out2 = on');
  await expect(page.getByTestId('script-badge')).toHaveText('“stairs”: up to date', { timeout: 10_000 });
  await expect(panel.getByTestId('board-script-actions')).not.toContainText('Changed here');
  // in the library now: the next Ctrl+S saves and sends without asking
  await panel.getByTestId('text-editor').locator('.view-lines').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.insertText('# again\n');
  await expect(panel.getByTestId('board-script-actions')).toContainText('Changed here');
  await page.keyboard.press('ControlOrMeta+S');
  await expect.poll(onBoard, { timeout: 10_000 }).toContain('# again');
  expect(fs.readFileSync(path.join(ws, 'effects', 'stairs.txt'), 'utf8')).toContain('# again');
  await expect(panel.getByTestId('board-script-actions')).not.toContainText('Changed here');
});

test('the Sound tile plays, repeats, stops and sets the volume for now', async () => {
  const key = await keyOf(board);
  const playing = async () => !!(await deviceLayer('rpc', { key, req: { op: 'state' } })).result.sound?.playing;
  const tile = page.getByTestId('live-pane').getByTestId('sound-tile');
  await expect(tile).toBeVisible();
  await expect(tile.getByTestId('sound-now')).toHaveText('Nothing playing.', { timeout: 10_000 });
  // no card list in the library: one sound number (sound 1 is the card's mp3/0001-….mp3)
  await expect(tile.getByRole('spinbutton', { name: 'Sound number' })).toHaveValue('1');
  await expect(tile.getByRole('spinbutton', { name: /folder|track/i })).toHaveCount(0);
  await tile.getByRole('button', { name: 'Play on repeat' }).click();
  await expect(tile.getByTestId('sound-now')).toHaveText(/^Playing sound 1 on repeat/, { timeout: 10_000 });
  await tile.getByRole('button', { name: 'Stop sound' }).click();
  await expect(tile.getByTestId('sound-now')).toHaveText('Nothing playing.', { timeout: 10_000 });
  // play once ends by itself (a practice board's sound is short, and practice boards run fast in the tests)
  await tile.getByRole('button', { name: 'Play once' }).click();
  await expect(tile.getByRole('alert')).toHaveCount(0);
  // the volume: for now only (the board's own sound op), nothing saved
  await expect(tile.getByTestId('sound-volume-help')).toContainText('for now only');
  const before = (await deviceLayer('rpc', { key, req: { op: 'get_params' } })).result.values.find((p: any) => p.key === 'trigger_volume')?.value;
  const slider = tile.getByRole('slider');
  await slider.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(tile.getByText(/^Volume: \d+$/)).toBeVisible();
  await expect(tile.getByRole('alert')).toHaveCount(0);
  expect((await deviceLayer('rpc', { key, req: { op: 'get_params' } })).result.values.find((p: any) => p.key === 'trigger_volume')?.value).toBe(before);
  // a repeat started here stops when you leave the board page: nothing keeps playing that nobody is looking at
  await tile.getByRole('button', { name: 'Play on repeat' }).click();
  await expect.poll(playing, { timeout: 10_000 }).toBe(true);
  await page.getByRole('tab', { name: 'Your library' }).click();
  await expect.poll(playing, { timeout: 10_000 }).toBe(false);
});
