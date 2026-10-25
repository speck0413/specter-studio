// An LED pattern sent to a board and played by its show script: the clue puzzle from Your library goes to a practice
// board with "Send to a board…" (the board's answer shown), the script's `pixels press` line is typed with the
// board's buttons offered, and the puzzle is solved out of order with TRIG2, TRIG1, USER1 and USER2, read from the
// strip's lights (the simulator's sim_pixels); USER3 starts it again. A board without a pattern player is not offered.
import { test, expect, Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { allowedPlugins } from './consent';
import { EXAMPLE_PATTERNS } from '../../src/patterns/examples';

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'specter-pattern-send-'));
const BOARD = 'Puzzle Room';
const PUZZLE = EXAMPLE_PATTERNS.find((x) => x.title === 'clue puzzle')!.text;
const SCRIPT = [
  'effect puzzle:', '  pixels = pattern clue puzzle', '  wait for user3',
  'effect clue1:', '  wait for trig1', '  pixels press clue1',
  'effect clue5:', '  wait for trig2', '  pixels press clue5',
  'effect clue2:', '  wait for user1', '  pixels press clue2',
  'effect the rest:', '  wait for user2', '  pixels press clue3', '  pixels press clue4', '  pixels press clue6', '',
].join('\n');

test.describe.configure({ mode: 'serial' });
let page: Page;
let bridge: WebSocket;
let key = '';
let folder = '';
let nextId = 0;
const waiting = new Map<number, (v: any) => void>();
function dl(cmd: string, args: any = {}): Promise<any> {
  const id = ++nextId;
  return new Promise((ok, fail) => {
    waiting.set(id, (v) => (v.ok ? ok(v.result) : fail(new Error(v.error))));
    bridge.send(JSON.stringify({ id, cmd, args }));
  });
}
const rpc = async (k: string, req: any) => dl('rpc', { key: k, req });
/** the strip's lights as [r, g, b] each */
async function lights(): Promise<number[][]> {
  const hex: string = (await rpc(key, { op: 'sim_pixels' })).result.pixels;
  const out: number[][] = [];
  for (let i = 0; i + 6 <= hex.length; i += 6) out.push([0, 2, 4].map((k) => parseInt(hex.slice(i + k, i + k + 2), 16)));
  return out;
}
const count = (ls: number[][], rgb: number[], from = 0, to = 9999) => ls.slice(from, to + 1).filter((p) => p.join() === rgb.join()).length;
const RED = [255, 0, 0], YELLOW = [255, 255, 0], GREEN = [0, 255, 0];
async function press(input: string) {
  await rpc(key, { op: 'sim_input', input, active: true });
  await new Promise((r) => setTimeout(r, 200));
  await rpc(key, { op: 'sim_input', input, active: false });
}

test.beforeAll(async ({ browser }) => {
  bridge = new WebSocket(`ws://127.0.0.1:${process.env.E2E_BRIDGE_PORT || '18792'}/?token=${process.env.SPECTER_BRIDGE_TOKEN}`);
  await new Promise((r) => bridge.addEventListener('open', r));
  bridge.addEventListener('message', (m) => { const v = JSON.parse(String(m.data)); if (v.id && waiting.has(v.id)) { waiting.get(v.id)!(v); waiting.delete(v.id); } });
  folder = await dl('workspace_init', { folder: ws });
  await dl('pattern_save', { folder, name: 'clue puzzle', text: PUZZLE, new: true });
  key = (await dl('sim_start', { name: BOARD, id: 'patternroom01' })).key;
  expect((await rpc(key, { op: 'set_params', values: [{ key: 'pixel_count', value: 60 }] })).ok).toBe(true);
  const ctx = await browser.newContext({ baseURL: `http://localhost:${process.env.E2E_APP_PORT || '14232'}/`, viewport: { width: 1300, height: 900 } });
  const pluginConsent = await allowedPlugins();
  await ctx.addInitScript(([w, c]) => localStorage.setItem('specter-prefs', JSON.stringify({ firstRunDone: true, workspace: w, pluginConsent: c })), [folder, pluginConsent] as const);
  page = await ctx.newPage();
  await page.goto('/');
  await expect(page.getByTestId(`board-${BOARD}`)).toBeVisible({ timeout: 15_000 });
});

test.afterAll(async () => {
  await page?.context().close();
  if (key) await dl('disconnect', { key }).catch(() => {});
  bridge.close();
  fs.rmSync(ws, { recursive: true, force: true });
});

test('"Send to a board…" puts the pattern on the practice board and shows its answer', async () => {
  await page.getByRole('tab', { name: 'Your library' }).click();
  await page.getByTestId('pattern-list').getByRole('button', { name: 'clue puzzle' }).click();
  await page.getByTestId('pattern-send').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByTestId('pattern-send-boards')).toContainText(BOARD);
  await dialog.getByLabel(BOARD).check();
  await dialog.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(dialog.getByTestId('pattern-send-answer')).toContainText(`Sent to ${BOARD}: kept as “clue puzzle”`, { timeout: 15_000 });
  await expect(dialog.getByTestId('pattern-send-answer')).toContainText('clue1, clue2, clue3, clue4, clue5, clue6, reset');
  await dialog.getByRole('button', { name: 'Close' }).click();
  const list = (await rpc(key, { op: 'list_patterns' })).result.patterns;
  expect(list.map((p: any) => p.name)).toEqual(['clue puzzle']);
});

test('the script names the pattern and presses its buttons, offered as they are typed', async () => {
  expect((await rpc(key, { op: 'set_script', text: SCRIPT })).result.ok).toBe(true);
  await page.getByRole('tab', { name: 'Boards' }).click();
  await page.getByTestId(`board-${BOARD}`).getByRole('button', { name: 'Open' }).click();
  await page.getByRole('tab', { name: 'Effect script' }).click();
  const box = page.getByTestId('text-editor');
  await expect(box.locator('.view-lines')).toContainText('pixels press clue6', { timeout: 15_000 });
  await box.locator('.view-lines').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('  pixels press ', { delay: 20 });
  const suggest = box.locator('.suggest-widget');
  await expect(suggest).toBeVisible();
  await expect(suggest).toContainText('reset');
  await expect(suggest).toContainText('clue6');
  await page.keyboard.press('Escape');
  // the press line is a block of its own
  await expect(page.getByTestId('blocks').locator('.blocklySvg .blocklyBlockCanvas').first()).toContainText(/press.the.pattern.s.button\s*clue1/);
});

test('solved out of order: each clue its own stretch, all of them green, USER3 starts again', async () => {
  await expect.poll(async () => count(await lights(), RED), { timeout: 10_000 }).toBe(60);
  await press('TRIG2');  // clue 5
  await expect.poll(async () => count(await lights(), YELLOW, 40, 49), { timeout: 5000 }).toBe(10);
  await press('TRIG1');  // clue 1
  await expect.poll(async () => count(await lights(), YELLOW, 0, 9), { timeout: 5000 }).toBe(10);
  await press('USER1');  // clue 2
  await expect.poll(async () => count(await lights(), YELLOW), { timeout: 5000 }).toBe(30);
  expect(count(await lights(), RED)).toBe(30);
  await press('USER2');  // clues 3, 4 and 6 at once
  await expect.poll(async () => count(await lights(), GREEN), { timeout: 5000 }).toBe(60);
  await press('USER3');  // a fresh puzzle
  await expect.poll(async () => count(await lights(), RED), { timeout: 5000 }).toBe(60);
});
