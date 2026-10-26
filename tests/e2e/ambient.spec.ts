// An effect does not have to start with "wait for" (the firmware's SHOW-SCRIPT.md SS-R1): the lines above its
// first "wait for" run at power-on and again after every run (a background sound, a lamp that glows while it
// waits), and an effect with no "wait for" goes round by itself, as long as it takes some time. The ambient
// example is typed in a practice board's script, checked by the board's own checker, shown as blocks with the
// lines above the wait for, sent, and the practice board does it: the dim glow straight away, full on at TRIG1,
// the glow back after the run, and the candle flickering without any trigger.
import { test, expect, Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { allowedPlugins } from './consent';

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'specter-ambient-'));
const BOARD = 'Rainy Porch';
// at the bridge's simulator speed (10x) "wait 30" keeps OUT1 full on for about 3 s
const AMBIENT = 'effect haunt:\n  audio_loop = 1\n  out1 = 15%\n  wait for trig1\n  audio_single = 2\n  out1 = on\n  wait 30\n\n' +
  'effect candle:\n  out2 = 40%\n  flicker out2 for 3\n  wait 1\n';
const NO_TIME = 'effect candle:\n  out2 = 40%\n  audio_single = 1\n';

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
const rpc = async (req: any) => dl('rpc', { key, req });
const level = async (ch: string) => (await rpc({ op: 'state' })).result.outputs.find((o: any) => o.channel === ch).level as number;
const box = () => page.getByTestId('text-editor');
const text = async () => (await box().locator('.view-line').allTextContents()).map((t) => t.replace(/ /g, ' ')).join('\n');

async function typeScript(t: string) {
  await box().locator('.view-lines').click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.insertText(t);
}

test.beforeAll(async ({ browser }) => {
  bridge = new WebSocket(`ws://127.0.0.1:${process.env.E2E_BRIDGE_PORT || '18792'}/?token=${process.env.SPECTER_BRIDGE_TOKEN}`);
  await new Promise((r) => bridge.addEventListener('open', r));
  bridge.addEventListener('message', (m) => { const v = JSON.parse(String(m.data)); if (v.id && waiting.has(v.id)) { waiting.get(v.id)!(v); waiting.delete(v.id); } });
  key = (await dl('sim_start', { name: BOARD, id: 'ambient00001' })).key;
  const ctx = await browser.newContext({ baseURL: `http://localhost:${process.env.E2E_APP_PORT || '14232'}/`, viewport: { width: 1300, height: 900 } });
  const pluginConsent = await allowedPlugins();
  await ctx.addInitScript(([w, c]) => localStorage.setItem('specter-prefs', JSON.stringify({ firstRunDone: true, workspace: w, pluginConsent: c })), [ws, pluginConsent] as const);
  page = await ctx.newPage();
  await page.goto('/');
  await expect(page.getByTestId(`board-${BOARD}`)).toBeVisible({ timeout: 15_000 });
  await page.getByTestId(`board-${BOARD}`).getByRole('button', { name: 'Open' }).click();
  await page.getByRole('tab', { name: 'Effect script' }).click();
  await expect(box()).toBeVisible({ timeout: 15_000 });
});

test.afterAll(async () => {
  await page?.context().close();
  if (key) await dl('disconnect', { key }).catch(() => {}); // the other specs count boards
  bridge.close();
  fs.rmSync(ws, { recursive: true, force: true });
});

test('the board checks an effect that does not start with a wait for, and one that never waits', async () => {
  // with no wait for and no time it would repeat without a pause: the board says so
  await typeScript(NO_TIME);
  await expect(page.getByTestId('check')).toContainText('line 1: effect "candle" never waits, so it would repeat without a pause. Add a "wait 5" or a "wait for trig1".', { timeout: 10_000 });
  // the ambient example: lines above the wait for, and a candle with no wait for that takes time
  await typeScript(AMBIENT);
  await expect.poll(text).toContain('effect candle:');
  await expect(page.getByTestId('check')).toContainText('Looks good', { timeout: 10_000 });
  // the blocks: the background sound and the glow stand above the wait for, the candle has none
  const canvas = page.getByTestId('blocks').locator('.blocklySvg .blocklyBlockCanvas').first();
  await expect(canvas).toContainText(/play\s*sound\s*1[^a-z]*over\s+and\s+over/);
  await expect(canvas).toContainText(/flicker\s*out2[^a-z]*for\s*3/);
  // drawn above the wait for block
  const y = async (words: string) => (await canvas.locator('text').filter({ hasText: words }).first().boundingBox())!.y;
  expect(await y('over')).toBeLessThan(await y('trig1'));
});

test('sent to the practice board: the glow at once, full on at TRIG1, the glow back after, the candle by itself', async () => {
  await page.getByRole('button', { name: 'Send to this board only' }).click();
  await expect.poll(async () => (await rpc({ op: 'get_script' })).result.text, { timeout: 10_000 }).toContain('effect candle:');
  // the lines above the wait for ran straight away; the candle goes round without a trigger
  await expect.poll(() => level('OUT1'), { timeout: 5000 }).toBe(150);
  const seen = new Set<number>();
  for (let i = 0; i < 20 && seen.size < 3; i++) { seen.add(await level('OUT2')); await page.waitForTimeout(50); }
  expect(seen.size).toBeGreaterThanOrEqual(2);
  // nothing starts the candle from outside: the board refuses and says why
  const start = await rpc({ op: 'action', key: 'candle' });
  expect(start.ok).toBe(false);
  expect(start.error.message).toContain('has no "wait for"');
  // TRIG1: full on, then back to the glow when the run is over
  await rpc({ op: 'sim_input', input: 'TRIG1', active: true });
  await page.waitForTimeout(300);
  await rpc({ op: 'sim_input', input: 'TRIG1', active: false });
  await expect.poll(() => level('OUT1'), { timeout: 5000 }).toBe(1000);
  await expect.poll(() => level('OUT1'), { timeout: 10_000 }).toBe(150);
  // the live panel shows the candle running
  const live = page.getByRole('tab', { name: 'Live' });
  if (await live.count()) await live.last().click(); // beside the sections on a wide window, behind the Live tab on a narrow one
  await expect(page.getByText(/candle: running \(line \d+\)/).first()).toBeVisible({ timeout: 10_000 });
});
