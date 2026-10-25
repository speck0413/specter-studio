// Hold to test on the inputs of a board that is not a practice board (firmware op test_input): a simulated board
// added by its address stands in for a real one. The press is momentary; with the board's remote start off it
// shows and starts nothing (and says so); with it on, the board reacts as to a real press.
import { test, expect, Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, ChildProcess } from 'node:child_process';
import { allowedPlugins } from './consent';

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'specter-inputtest-'));
const NAME = 'Bench board';
test.describe.configure({ mode: 'serial' });
let page: Page;
let sim: ChildProcess;
let address = '';

async function freePort(): Promise<number> {
  return new Promise((ok) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => ok(p)); }); });
}
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
const keyOf = async () => {
  for (const c of await deviceLayer<any[]>('connections')) {
    const r = await deviceLayer('rpc', { key: c.key, req: { op: 'info' } }).catch(() => null);
    if (r?.result?.name === NAME) return c.key as string;
  }
  throw new Error(`no board ${NAME}`);
};

test.beforeAll(async ({ browser }) => {
  const bin = fs.readdirSync('src-tauri/binaries').find((f) => f.startsWith('proptroller-sim-'));
  if (!bin) throw new Error('no simulator: sh scripts/build-sim.sh');
  const port = await freePort();
  sim = spawn(path.resolve('src-tauri/binaries', bin), ['--port', String(port), '--discovery-port', String(await freePort()), '--id', 'bench1', '--name', NAME], { stdio: 'ignore' });
  address = `127.0.0.1:${port}`;
  const ctx = await browser.newContext({ baseURL: `http://localhost:${process.env.E2E_APP_PORT || '14232'}/`, viewport: { width: 1300, height: 900 } });
  const pluginConsent = await allowedPlugins();
  await ctx.addInitScript(([w, c]) => localStorage.setItem('specter-prefs', JSON.stringify({ firstRunDone: true, workspace: w, pluginConsent: c })), [ws, pluginConsent] as const);
  page = await ctx.newPage();
  await page.goto('/');
});

test.afterAll(async () => {
  // this file's Studio page goes too: a page left open keeps talking to the shared device layer (and loading the
  // browser) through every later file
  await page?.context().close();
  await keyOf().then((key) => deviceLayer('disconnect', { key })).catch(() => {});
  sim?.kill();
  fs.rmSync(ws, { recursive: true, force: true });
});

test('a board added by its address: Hold to test on its inputs, momentary, and only shown while remote start is off', async () => {
  await page.getByRole('tab', { name: 'Boards' }).click();
  await page.getByRole('button', { name: 'Add a board' }).first().click();
  await page.getByRole('textbox', { name: 'Board address' }).fill(address);
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByTestId(`board-${NAME}`)).toBeVisible({ timeout: 20_000 });
  await page.getByTestId(`board-${NAME}`).getByRole('button', { name: 'Open' }).click();
  const key = await keyOf();
  await deviceLayer('rpc', { key, req: { op: 'add_example' } }); // TRIG1 pulses OUT1 for 2 s
  const live = page.getByTestId('live-pane');
  const trig = live.getByTestId('input-TRIG1');
  await expect(trig.getByRole('button', { name: 'Press' })).toHaveCount(0); // not a practice board's wire press
  const hold = trig.getByRole('button', { name: 'Hold to test' });
  await hold.scrollIntoViewIfNeeded();
  const box = (await hold.boundingBox())!;
  // remote start off: the press shows on the input, nothing starts, and the tile says how to change that
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await expect(trig.getByText('pressed')).toBeVisible({ timeout: 5000 });
  await expect(trig.getByTestId('test-press-shown-only')).toContainText('turn on network start');
  await page.waitForTimeout(500);
  await expect(live.getByTestId('output-OUT1').getByTestId('level')).toHaveText(/^off/);
  await page.mouse.up();
  await expect(trig.getByText('open')).toBeVisible({ timeout: 5000 });
  await expect(trig.getByTestId('test-press-shown-only')).toHaveCount(0);
  // remote start on: the same press runs the show, as a real press would
  await deviceLayer('rpc', { key, req: { op: 'set_params', values: [{ key: 'remote_trigger_enable', value: true }] } });
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await expect(live.getByTestId('output-OUT1').getByTestId('level')).toHaveText(/^on/, { timeout: 5000 });
  await expect(trig.getByTestId('test-press-shown-only')).toHaveCount(0);
  await page.mouse.up();
  await expect(trig.getByText('open')).toBeVisible({ timeout: 5000 });
  // the board itself holds no test press any more
  const st = (await deviceLayer('rpc', { key, req: { op: 'state' } })).result;
  expect(st.inputs.find((i: any) => i.input === 'TRIG1').test).toBeUndefined();
});
