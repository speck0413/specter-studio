// Specter Studio end to end: the UI, the device layer (bridge) and simulated boards built from the real
// firmware. One story, in the order a beginner meets things.
import { test, expect, Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Studio's MQTT server in the adapter and plugin tests (E2E_MQTT_PORT moves it, like the E2E_* ports in playwright.config.ts)
const MQTT_PORT = process.env.E2E_MQTT_PORT || '18834';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'specter-e2e-'));
const workspace = path.join(tmp, 'My Props');
const backups = path.join(tmp, 'Backups');
const releases = path.join(tmp, 'release');

function simImage(version: string) {
  const head = JSON.stringify({ mcu: 'sim', fw_version: version, fw_build: 'e2e0001', self_check: 'pass' });
  return Buffer.concat([Buffer.from('PROPTROLLER-SIM-IMAGE\n' + head + '\n'), Buffer.alloc(150_000, 7)]);
}

// window.prompt stands in for the folder dialog in a browser
const answers: string[] = [];
function answerPrompts(_page: Page, list: string[]) {
  answers.push(...list);
}

// the device layer directly (a second connection, as another program would): for setting up a test's board
async function deviceLayer<T = any>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  const ws = new WebSocket(`ws://127.0.0.1:${process.env.E2E_BRIDGE_PORT || '18792'}/?token=${process.env.SPECTER_BRIDGE_TOKEN}`);
  await new Promise((r) => ws.addEventListener('open', r));
  try {
    return await new Promise<T>((ok, fail) => {
      ws.addEventListener('message', (m) => { const v = JSON.parse(String(m.data)); if (v.id === 1) (v.ok ? ok(v.result) : fail(new Error(v.error))); });
      ws.send(JSON.stringify({ id: 1, cmd, args }));
    });
  } finally { ws.close(); }
}
const keyOf = async (name: string) => {
  for (const c of await deviceLayer<any[]>('connections')) {
    const r = await deviceLayer('rpc', { key: c.key, req: { op: 'info' } }).catch(() => null);
    if (r?.result?.name === name) return c.key as string;
  }
  throw new Error(`no board ${name}`);
};

// a board's live tiles: beside the other sections on a wide window, behind the Live tab on a narrow one
async function showLive(p: Page) {
  const tab = p.getByRole('tab', { name: 'Live' });
  if (await tab.count()) await tab.last().click();
}

test.describe.configure({ mode: 'serial' });
let page: Page;

test.beforeAll(async ({ browser }) => {
  // the story starts with no boards: a retry of this file (or a file before it) may have left boards in the shared
  // device layer, which a first run would show (the script checker's own board stays)
  for (const c of await deviceLayer<any[]>('connections')) if (c.key !== 'checker') await deviceLayer('disconnect', { key: c.key });
  await expect.poll(async () => (await deviceLayer<any[]>('connections')).filter((c) => c.key !== 'checker').length).toBe(0);
  page = await (await browser.newContext({ viewport: { width: 1300, height: 900 }, baseURL: `http://localhost:${process.env.E2E_APP_PORT || '14232'}/` })).newPage();
  page.on('dialog', (d) => void d.accept(answers.shift() ?? ''));
});

test('first run: library folder and a practice board', async () => {
  answerPrompts(page, [workspace]);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose another folder…' }).click();
  await expect(page.getByTestId('workspace-folder')).toHaveText(workspace);
  await page.getByRole('button', { name: 'Use this folder' }).click();
  // the device layer makes the folders after the click (asynchronously)
  await expect.poll(() => fs.existsSync(path.join(workspace, 'effects'))).toBe(true);
  await expect.poll(() => fs.existsSync(path.join(workspace, 'firmware'))).toBe(true);
  await page.getByRole('dialog').getByRole('button', { name: /practice board/ }).click();
  await expect(page.getByRole('dialog').getByText('Added: Practice board 1')).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Done' }).click();
  // the example device adapter asks first (its topics), once
  const consent = page.getByRole('dialog', { name: /Allow “Demo lamps/ });
  await expect(consent).toContainText('Read messages on: demolamp/#');
  await consent.getByRole('button', { name: 'Allow' }).click();
  const card = page.getByTestId('board-Practice board 1');
  await expect(card).toBeVisible();
  await expect(card.getByTestId('script-badge')).toHaveText('No effect script', { timeout: 10_000 });
  // beginner words only
  await expect(page.locator('body')).not.toContainText(/JSON|protocol|DSL|git|partition/i);
});

test('a wrong board address says what to try next', async () => {
  await page.getByRole('button', { name: 'Add a board' }).click();
  await page.getByRole('textbox', { name: 'Board address' }).fill('192.0.2.1');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'No board answered at “192.0.2.1”' })).toContainText('Find boards on my network', { timeout: 30_000 });
  await page.getByRole('textbox', { name: 'Board address' }).fill('');
  await page.getByRole('button', { name: 'Add a board' }).click();
});

test('live controls are momentary', async () => {
  await page.getByTestId('board-Practice board 1').getByRole('button', { name: 'Open' }).click();
  const trig = page.getByTestId('input-TRIG1');
  const press = trig.getByRole('button', { name: 'Press' });
  await press.scrollIntoViewIfNeeded(); const box = (await press.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await expect(trig.getByText('pressed')).toBeVisible();
  await page.mouse.up();
  await expect(trig.getByText('open')).toBeVisible();
  const out = page.getByTestId('output-OUT1');
  const hold = out.getByRole('button', { name: 'Hold to test' });
  await hold.scrollIntoViewIfNeeded(); const hb = (await hold.boundingBox())!;
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await expect(out.getByTestId('level')).toHaveText(/^on/);
  await page.mouse.up();
  await expect(out.getByTestId('level')).toHaveText(/^off/);
  await expect(page.getByTestId('left-on')).toHaveCount(0); // a normal let-go never shows "still on from a test"
  // an output left on by a test nobody holds (a let-go lost with the connection, another program): one click lets go
  const key = await keyOf('Practice board 1');
  await deviceLayer('rpc', { key, req: { op: 'set_output', channel: 'OUT2', level: 1000 } });
  const leftOn = page.getByTestId('left-on');
  await expect(leftOn).toContainText('OUT2 is still on from a test', { timeout: 5000 });
  await leftOn.getByRole('button', { name: 'Release' }).click();
  await expect(page.getByTestId('output-OUT2').getByTestId('level')).toHaveText(/^off/, { timeout: 5000 });
  await expect(leftOn).toHaveCount(0);
});

test('settings come from the board', async () => {
  await page.getByRole('tab', { name: 'Settings' }).last().click();
  // beginners see a short list; the rest is one click away
  await expect(page.getByLabel('Trigger debounce', { exact: false })).toHaveCount(0);
  await page.getByRole('button', { name: 'More settings (for experts)' }).click();
  await expect(page.getByLabel('Trigger debounce', { exact: false }).first()).toBeVisible();
  // times are in seconds (the board keeps milliseconds), as on the board's own page
  {
    const k = await keyOf('Practice board 1');
    const maxOn = page.getByRole('spinbutton', { name: 'OUT1 max on (s)' });
    const was = (await deviceLayer('rpc', { key: k, req: { op: 'get_params' } })).result.values.find((v: any) => v.key === 'out1_max_on_ms').value;
    await expect(maxOn).toHaveValue(String(was / 1000));
    await maxOn.fill('2.5');
    await page.getByRole('button', { name: 'Save settings' }).click();
    await expect(page.getByText(/^Saved/)).toBeVisible();
    await expect.poll(async () => (await deviceLayer('rpc', { key: k, req: { op: 'get_params' } })).result.values.find((v: any) => v.key === 'out1_max_on_ms').value).toBe(2500);
    await maxOn.fill(String(was / 1000));
    await page.getByRole('button', { name: 'Save settings' }).click();
    await expect.poll(async () => (await deviceLayer('rpc', { key: k, req: { op: 'get_params' } })).result.values.find((v: any) => v.key === 'out1_max_on_ms').value).toBe(was);
  }
  await page.getByRole('button', { name: 'Fewer settings' }).click();
  await expect(page.getByLabel('Page password')).toHaveValue('');
  // a change not saved yet survives a look at another tab
  const name = page.getByRole('textbox', { name: 'Name', exact: true });
  const was = await name.inputValue();
  await name.fill('Porch ghost');
  await page.getByRole('tab', { name: 'Plot' }).last().click();
  await page.getByRole('tab', { name: 'Settings' }).last().click();
  await expect(page.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Porch ghost');
  await expect(page.getByText('You have changes here that are not saved yet.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Undo changes' }).click();
  await expect(page.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue(was);
  // changed somewhere else (the board's own page, another program): the open form and the tiles follow
  const key = await keyOf('Practice board 1');
  const out4 = page.getByRole('textbox', { name: 'OUT4 is connected to' });
  const before = await out4.inputValue();
  await deviceLayer('rpc', { key, req: { op: 'set_params', values: [{ key: 'out4_name', value: 'smoke test' }] } });
  await expect(out4).toHaveValue('smoke test', { timeout: 5000 });
  await expect(page.getByText('The board\'s settings were just changed somewhere else.', { exact: false })).toBeVisible();
  await showLive(page);
  await expect(page.getByTestId('output-OUT4')).toContainText('smoke test', { timeout: 5000 });
  await deviceLayer('rpc', { key, req: { op: 'set_params', values: [{ key: 'out4_name', value: before }] } });
  await expect(page.getByTestId('output-OUT4')).not.toContainText('smoke test', { timeout: 5000 });
  await page.getByRole('tab', { name: 'Settings' }).last().click();
});

test('Wi-Fi network: type a name or pick one the board sees', async () => {
  // the practice board has `wifi_scan` and "sees" a fixed sample list 1.5 s after it is asked (firmware sim.cpp)
  await page.getByRole('tab', { name: 'Settings' }).last().click();
  const ssid = page.getByRole('combobox', { name: 'Wi-Fi network' });
  await expect(ssid).toBeVisible();
  const was = await ssid.inputValue();
  await ssid.click();
  await ssid.press('ArrowDown');
  const options = page.getByRole('listbox').getByRole('option');
  // one entry per name (Office twice on air), strongest first, the hidden network left out
  await expect(options).toHaveText([/^Office.*strong · password$/, /^Workshop 2\.4.*strong · password$/, /^Guest Wi-Fi.*good · open$/, /^Neighbour.*very weak · password$/], { timeout: 10_000 });
  await options.filter({ hasText: 'Guest Wi-Fi' }).click();
  await expect(ssid).toHaveValue('Guest Wi-Fi');
  await expect(page.getByTestId('wifi-pick-hint')).toContainText('“Guest Wi-Fi” is open (no password): leave Wi-Fi password empty');
  await expect(page.getByRole('button', { name: 'Save settings' })).toBeEnabled();
  // a name the board does not see can still be typed
  await ssid.fill('Barn');
  await expect(ssid).toHaveValue('Barn');
  await expect(page.getByTestId('wifi-pick-hint')).toHaveCount(0);
  // Rescan asks the board again; too soon after the last scan it says when it can (retry_ms)
  await page.getByRole('button', { name: 'Rescan' }).click();
  await expect(page.getByTestId('wifi-scan-status')).toHaveText(/Rescan works again in \d+ s|Networks this board can see/, { timeout: 10_000 });
  await page.getByRole('button', { name: 'Undo changes' }).click();
  await expect(ssid).toHaveValue(was);
});

test('Wi-Fi network: one the board sees with a password is not saved without it; an open one is', async () => {
  const k = await keyOf('Practice board 1');
  const params = async () => Object.fromEntries((await deviceLayer('rpc', { key: k, req: { op: 'get_params' } })).result.values.map((v: any) => [v.key, v]));
  const was = (await params()).wifi_ssid.value;
  // a password stored for the network the board has now (the network unchanged keeps it)
  await deviceLayer('rpc', { key: k, req: { op: 'set_params', values: [{ key: 'wifi_pass', value: 'hunter22' }] } });
  expect((await params()).wifi_pass.set).toBe(true);
  await page.getByRole('tab', { name: 'Settings' }).last().click();
  const ssid = page.getByRole('combobox', { name: 'Wi-Fi network' });
  const options = page.getByRole('listbox').getByRole('option');
  await ssid.click();
  await ssid.press('ArrowDown');
  await options.filter({ hasText: 'Office' }).click();
  await expect(page.getByLabel('Wi-Fi password', { exact: true })).toHaveAccessibleDescription(/leave it empty only for an open network/);
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByText('This network needs its password: type the password of “Office”', { exact: false })).toBeVisible();
  await expect(page.getByLabel('Wi-Fi password', { exact: true })).toBeFocused();
  const now = await params();
  expect(now.wifi_ssid.value, 'nothing saved').toBe(was);
  expect(now.wifi_pass.set).toBe(true);
  // an open network: saved with no password, and the board drops the old network's one (firmware set_params)
  await ssid.click();
  await ssid.press('ArrowDown');
  await options.filter({ hasText: 'Guest Wi-Fi' }).click();
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByText(/^Saved/)).toBeVisible();
  await expect.poll(async () => (await params()).wifi_ssid.value).toBe('Guest Wi-Fi');
  expect((await params()).wifi_pass.set).toBe(false);
  await deviceLayer('rpc', { key: k, req: { op: 'set_params', values: [{ key: 'wifi_ssid', value: was }] } });
  await expect.poll(async () => (await params()).wifi_ssid.value).toBe(was);
});

const NAME = 'lamp and fog - lab room 1';
const GOOD = 'effect porch:\n  wait for trig1\n  out1 = on\n  sleep 15\n  out1 = off\n';

test('write an effect, check it, save it, send it', async () => {
  await page.getByRole('tab', { name: 'Your library' }).click();
  answerPrompts(page, []);
  await page.getByRole('button', { name: 'New effect' }).click();
  await page.getByRole('dialog').getByLabel('Name').fill(NAME);
  await page.getByRole('dialog').getByRole('button', { name: 'Make it' }).click();
  await expect(page.getByRole('heading', { name: NAME, level: 2 })).toBeVisible();
  expect(fs.existsSync(path.join(workspace, 'effects', `${NAME}.txt`))).toBe(true);
  // the blocks show the starter effect
  await expect(page.getByTestId('blocks').locator('.blocklySvg').first()).toBeVisible();
  // type a mistake: the board's own message
  await page.getByTestId('text-editor').locator('.view-lines').click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.insertText('effect porch:\n  wait for trig1\n  rly1 = 50%\n');
  await expect(page.getByTestId('check')).toContainText('line 3: rly1 can only be on or off, not 50%. Dimming works on out1 to out4.', { timeout: 10_000 });
  // a pause written the natural way gets a way forward (the board's own message, or Studio's hint under an
  // older board's message)
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.insertText('effect porch:\n  wait for trig1\n  out1 = on\npause 2 seconds\n');
  await expect(page.getByTestId('check')).toContainText(/to wait a time, write "wait 2|To pause, write "wait 2"/i, { timeout: 10_000 });
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.insertText(GOOD);
  await expect(page.getByTestId('check')).toContainText('Looks good', { timeout: 10_000 });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText(`Saved “${NAME}”.`)).toBeVisible();
  // send it to the practice board
  await page.getByRole('combobox', { name: 'Board', exact: true }).click();
  await page.getByRole('option', { name: 'Practice board 1' }).click();
  await page.getByRole('button', { name: 'Send to board' }).click();
  await expect(page.getByText(`“${NAME}” is on Practice board 1 and running.`)).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('running-Practice board 1')).toContainText('Same version', { timeout: 10_000 });
});

test('fast typing loses no characters', async () => {
  await page.getByTestId('text-editor').locator('.view-lines').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('# quick brown fox jumps over the lazy dog 0123456789', { delay: 5 });
  await expect(page.getByTestId('text-editor').locator('.view-lines')).toContainText('# quick brown fox jumps over the lazy dog 0123456789');
  await page.keyboard.press('ControlOrMeta+Z');
});

test('a checker message goes to its line (click or Enter)', async () => {
  const box = page.getByTestId('text-editor');
  await box.locator('.view-lines').click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.insertText('effect porch:\n  wait for trig1\n  out1 = on\n  sleep 15\n  rly1 = 50%\n');
  const msg = page.getByTestId('check-error').filter({ hasText: 'rly1 can only be on or off' });
  await expect(msg).toBeVisible({ timeout: 10_000 });
  // the cursor is somewhere else first
  await box.locator('.view-lines').click();
  await page.keyboard.press('ControlOrMeta+Home');
  await expect(box).toHaveAttribute('data-cursor-line', '1');
  await msg.click();
  await expect(box).toHaveAttribute('data-cursor-line', '5');
  await expect(box).toHaveAttribute('data-goto-line', '5');
  await expect(box.locator('.goto-line')).toHaveCount(1);
  // the cursor is at the line's first word, ready to type
  await expect(box.locator('.view-line').nth(4)).toContainText('rly1 = 50%');
  // the blocks view selects the block for that line
  await expect(page.getByTestId('blocks').locator('.blocklySelected')).toHaveCount(1);
  // keyboard: Tab to the message, Enter
  await page.keyboard.press('ControlOrMeta+Home');
  await expect(box).toHaveAttribute('data-cursor-line', '1');
  await msg.focus();
  await page.keyboard.press('Enter');
  await expect(box).toHaveAttribute('data-cursor-line', '5');
  await expect(box.locator('.monaco-editor.focused')).toHaveCount(1);
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.insertText(GOOD);
  await expect(page.getByTestId('check')).toContainText('Looks good', { timeout: 10_000 });
});

test('typing a script line by line keeps the two-space indent (no staircase)', async () => {
  const lines = page.getByTestId('text-editor').locator('.view-line');
  const before = await lines.allTextContents();
  await page.getByTestId('text-editor').locator('.view-lines').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.press('Enter');
  for (const l of ['effect knock:', '  wait for trig2', '  out2 = on']) {
    await page.keyboard.type(l, { delay: 5 });
    await page.keyboard.press('Enter');
  }
  const indentOf = async (text: string) => {
    const all = (await lines.allTextContents()).map((t) => t.replace(/\u00a0/g, ' ')); // the editor draws spaces as no-break spaces
    const line = all.find((t) => t.includes(text));
    return line === undefined ? -1 : line.length - line.replace(/^ +/, '').length;
  };
  await expect.poll(() => indentOf('wait for trig2')).toBe(2);
  expect(await indentOf('out2 = on')).toBe(2);
  // back to the saved script
  for (let i = 0; i < 60 && JSON.stringify(await lines.allTextContents()) !== JSON.stringify(before); i++) await page.keyboard.press('ControlOrMeta+Z');
  expect(await lines.allTextContents()).toEqual(before);
});

test('the editor view: script and blocks, script only, blocks only; edits in each show in the other', async () => {
  const views = page.getByTestId('editor-view');
  const lines = page.getByTestId('text-editor').locator('.view-line');
  const text = async () => (await lines.allTextContents()).map((t) => t.replace(/\u00a0/g, ' ')).join('\n');
  const before = await text();
  // the exact text before (the editor's lines wrap): the unsaved copy Studio keeps on disk, else the saved file
  await page.waitForTimeout(500);
  const unsavedFile = path.join(workspace, '.specter', 'unsaved.json');
  const computers = fs.existsSync(unsavedFile) ? Object.values(JSON.parse(fs.readFileSync(unsavedFile, 'utf8')).computers || {}) as any[] : [];
  const kept: string | undefined = computers.map((c) => c.effects?.[NAME]?.text).find((t) => t !== undefined);
  const exact: string = kept ?? fs.readFileSync(path.join(workspace, 'effects', `${NAME}.txt`), 'utf8');
  const heading = await page.getByRole('heading', { level: 2 }).first().textContent();
  await expect(views.getByRole('button', { name: 'Script and blocks' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('text-editor')).toBeVisible();
  await expect(page.getByTestId('blocks')).toBeVisible();
  // script only: the blocks go away; an edit here is there when the blocks come back
  await views.getByRole('button', { name: 'Script only' }).click();
  await expect(page.getByTestId('blocks')).toHaveCount(0);
  await page.getByTestId('text-editor').locator('.view-lines').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.insertText('\n# typed in script only\n');
  // blocks only (keyboard: the switch is a group of buttons)
  await views.getByRole('button', { name: 'Blocks only' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('text-editor')).toHaveCount(0);
  await expect(page.getByTestId('blocks').getByRole('button', { name: /typed in script only/ }).first()).toBeVisible();
  // an edit in the blocks: the wait becomes 14 s (the time opens a number with a unit)
  await page.getByTestId('blocks').locator('.blocklyEditableField, .blocklyEditableText').filter({ hasText: /^15\s+s/ }).first().click();
  await page.getByRole('spinbutton', { name: 'How long' }).fill('14');
  await page.keyboard.press('Enter');
  // remembered for this person (Studio's preferences), not for this effect
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('specter-prefs') || '{}').editorView)).toBe('blocks');
  await page.getByTestId('editor-view').getByRole('button', { name: 'Script and blocks' }).click();
  await expect.poll(text).toContain('wait 14');
  expect(await text()).toContain('# typed in script only');
  // back to what it was
  await page.getByTestId('text-editor').locator('.view-lines').click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.insertText(exact);
  await expect.poll(text).toBe(before);
  await expect(page.getByRole('heading', { level: 2 }).first()).toHaveText(heading!);
});

test('blocks pick from lists: wait for trig1 and out1 = 50% with clicks only', async () => {
  const views = page.getByTestId('editor-view');
  const lines = page.getByTestId('text-editor').locator('.view-line');
  const text = async () => (await lines.allTextContents()).map((t) => t.replace(/\u00a0/g, ' ')).join('\n');
  const before = await text();
  await page.getByTestId('text-editor').locator('.view-lines').click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.insertText('effect porch:');
  await expect.poll(text).toBe('effect porch:');
  // blocks only: room for the blocks
  await views.getByRole('button', { name: 'Blocks only' }).click();
  const blocks = page.getByTestId('blocks');
  const placed = blocks.locator('.blocklySvg .blocklyBlockCanvas g[data-id]');
  const effect = placed.filter({ hasText: /^effect/ }).first();
  await expect(effect).toBeVisible();
  // drags a block from the flyout so its top left lands at (x, y)
  const dragFrom = async (label: RegExp, x: number, y: number) => {
    const src = blocks.locator('.blocklyFlyout g[data-id]').filter({ hasText: label }).first();
    const b = (await src.boundingBox())!;
    await page.mouse.move(b.x + 6, b.y + 6);
    await page.mouse.down();
    for (let i = 1; i <= 12; i++) await page.mouse.move(b.x + 6 + ((x - b.x) * i) / 12, b.y + 6 + ((y - b.y) * i) / 12);
    await page.mouse.up();
  };
  // into the effect: the output line, then the wait above it (a block dropped at the top goes in first)
  const e = (await effect.boundingBox())!;
  await dragFrom(/^out1[^=]*=\s*on/, e.x + 18, e.y + 34);
  await expect(placed.filter({ hasText: /^out1/ })).toHaveCount(1);
  await dragFrom(/^wait\sfor/, e.x + 18, e.y + 34);
  const wait = placed.filter({ hasText: /^wait\sfor/ }).first();
  await expect(wait).toBeVisible();
  const set = placed.filter({ hasText: /^(out1|rly1)[^=]*=/ }).last();
  await expect(set).toBeVisible();
  const menuItem = (name: string) => page.locator('.blocklyDropDownDiv').getByRole('option', { name, exact: true });
  const fields = (b: typeof set) => b.locator('.blocklyEditableField, .blocklyEditableText');
  // the input from a dropdown of the board's inputs
  await fields(wait).first().click();
  await menuItem('trig2').click();
  await expect(fields(wait).first()).toContainText('trig2');
  await fields(wait).first().click();
  await menuItem('trig1').click();
  // the level: on / off / level…; level gives a slider and a number (50 to start)
  await fields(set).filter({ hasText: /^on/ }).click();
  await expect(menuItem('off')).toBeVisible();
  await menuItem('level…').click();
  await expect(page.getByRole('slider', { name: 'Level in percent' })).toHaveValue('50');
  await page.getByRole('button', { name: 'Done' }).click();
  // the same with the keyboard: Enter opens the menu, arrows and Enter pick "level…", the slider moves by 5, Enter
  // closes it and the keyboard is back on the block
  await fields(set).filter({ hasText: /^50%/ }).focus();
  await page.keyboard.press('Enter');
  await expect(menuItem('level…')).toBeVisible();
  for (let i = 0; i < 6 && !(await menuItem('level…').evaluate((e) => e.classList.contains('blocklyMenuItemHighlight'))); i++) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  const slider = page.getByRole('slider', { name: 'Level in percent' });
  await expect(slider).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(slider).toHaveValue('55');
  await page.keyboard.press('Enter');
  await expect(slider).toHaveCount(0);
  expect(await blocks.evaluate((b) => b.contains(document.activeElement))).toBe(true);
  await views.getByRole('button', { name: 'Script and blocks' }).click();
  await expect.poll(text).toBe('effect porch:\n  wait for trig1\n  out1 = 55%\n');
  // a relay: on and off only, and the 55% becomes on (with a note on the block)
  await views.getByRole('button', { name: 'Blocks only' }).click();
  await fields(set).first().click();
  await menuItem('rly1').click();
  await fields(set).filter({ hasText: /^on/ }).click();
  await expect(menuItem('off')).toBeVisible();
  await expect(menuItem('level…')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await views.getByRole('button', { name: 'Script and blocks' }).click();
  await expect.poll(text).toBe('effect porch:\n  wait for trig1\n  rly1 = on\n');
  // back to what it was
  await page.getByTestId('text-editor').locator('.view-lines').click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.insertText(before);
  await expect.poll(text).toBe(before);
});

test('typeahead: on / off and one level for a dimmable output, no % for a relay', async () => {
  const box = page.getByTestId('text-editor');
  const lines = box.locator('.view-line');
  const text = async () => (await lines.allTextContents()).map((t) => t.replace(/\u00a0/g, ' ')).join('\n');
  const before = await text();
  const suggest = box.locator('.suggest-widget');
  await box.locator('.view-lines').click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.insertText('effect porch:\n  wait for trig1\n  ');
  await page.keyboard.type('rly1 = ', { delay: 20 });
  await expect(suggest).toBeVisible();
  await expect(suggest.locator('.monaco-list-row')).toHaveCount(2);
  await expect(suggest).toContainText('on');
  await expect(suggest).toContainText('off');
  await expect(suggest).not.toContainText('%');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Enter');
  await page.keyboard.type('out1 = ', { delay: 20 });
  await expect(suggest).toBeVisible();
  await expect(suggest).toContainText('level %');
  await expect(suggest.locator('.monaco-list-row')).toHaveCount(3);
  // the level snippet: 50% with the number selected, so typing replaces it
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.keyboard.type('70');
  await expect.poll(text).toContain('out1 = 70%');
  // back to what it was
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.insertText(before);
  await expect.poll(text).toBe(before);
});

test('the library moves on: the board shows an older version, one click updates it', async () => {
  await page.getByTestId('text-editor').locator('.view-lines').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.insertText('# version two\n');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByTestId('running-Practice board 1')).toContainText('Older version', { timeout: 10_000 });
  await page.getByRole('button', { name: /Update all 1 board/ }).click();
  await expect(page.getByTestId('running-Practice board 1')).toContainText('Same version', { timeout: 10_000 });
  // the board's text names the script and its version
  await page.getByRole('tab', { name: 'Boards' }).click();
  await expect(page.getByTestId('board-Practice board 1').getByTestId('script-badge')).toHaveText(`“${NAME}”: up to date`);
});

test('the effect runs on the board', async () => {
  await page.getByTestId('board-Practice board 1').getByRole('button', { name: 'Open' }).click();
  const press = page.getByTestId('input-TRIG1').getByRole('button', { name: 'Press' });
  await press.scrollIntoViewIfNeeded(); const box = (await press.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(300);
  await page.mouse.up();
  await expect(page.getByTestId('output-OUT1').getByTestId('level')).toHaveText(/^on/, { timeout: 5000 });
  await expect(page.getByTestId('output-OUT1').getByTestId('level')).toHaveText(/^off/, { timeout: 5000 });
  await page.getByRole('tab', { name: 'Activity' }).click();
  await expect(page.getByRole('list', { name: 'Activity' })).toContainText('TRIG1 pressed');
  await expect(page.getByRole('list', { name: 'Activity' })).toContainText('Effect “porch” started');
  await page.getByRole('tab', { name: 'Effect script' }).click();
  await expect(page.getByTestId('board-script-header')).toContainText(`Sent from Studio: “${NAME}”, saved `);
});

test('back up and restore', async () => {
  await page.getByRole('tab', { name: 'Settings' }).first().click();
  answerPrompts(page, [backups]);
  await page.getByRole('button', { name: 'Choose…' }).nth(1).click();
  await expect(page.getByText(backups)).toBeVisible();
  await page.getByRole('tab', { name: 'Boards' }).click();
  await page.getByRole('button', { name: 'Back up all boards' }).click();
  await expect(page.getByText(/Backed up Practice board 1 to your backups folder/)).toBeVisible({ timeout: 10_000 });
  expect(fs.readdirSync(backups).filter((f) => f.endsWith('.proptroller.json')).length).toBe(1);
  // restore it onto a second practice board: the effect comes with it
  await page.getByRole('button', { name: 'Add a board' }).click().catch(() => {});
  await page.getByRole('button', { name: /Add a practice board/ }).click();
  const second = page.getByTestId('board-Practice board 2');
  await expect(second.getByTestId('script-badge')).toHaveText('No effect script', { timeout: 15_000 });
  await second.getByRole('button', { name: 'Open' }).click();
  await page.getByRole('tab', { name: 'Backups' }).click();
  await page.getByRole('button', { name: 'Restore to this board' }).first().click();
  await page.getByRole('dialog').getByRole('button', { name: 'Restore' }).click();
  await expect(page.getByText('Restored Practice board 2.')).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: 'All boards', exact: true }).click();
  await expect(second.getByTestId('script-badge')).toHaveText(`“${NAME}”: up to date`, { timeout: 10_000 });
  await second.getByRole('button', { name: 'Open' }).click();
  // a backup file from anywhere (a ready-made setup, such as the starter kit)
  const file = path.join(backups, fs.readdirSync(backups).find((f) => f.endsWith('.proptroller.json'))!);
  await page.getByRole('tab', { name: 'Backups' }).click();
  if (await page.getByTestId('action-message').count()) await page.getByTestId('action-message').getByRole('button', { name: 'Close' }).click();
  await expect(page.getByText('Restored Practice board 2.')).toHaveCount(0);
  answerPrompts(page, [file]);
  await page.getByRole('button', { name: 'Restore from a file…' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Restore' }).click();
  await expect(page.getByText('Restored Practice board 2.')).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: 'Remove from Studio' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Remove' }).click();
});

test('start from an example', async () => {
  await page.getByRole('tab', { name: 'Your library' }).click();
  await page.getByRole('button', { name: 'Start from an example' }).click();
  await page.getByRole('button', { name: /light up ghost/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('heading', { name: 'light up ghost', level: 2 })).toBeVisible();
  await expect(page.getByTestId('check')).toContainText('Looks good', { timeout: 10_000 });
  await page.getByRole('tab', { name: 'Boards' }).click();
});

test('leaving the editor never loses unsaved changes', async () => {
  await page.getByRole('tab', { name: 'Your library' }).click();
  await page.getByRole('button', { name: /light up ghost/ }).first().click();
  await expect(page.getByTestId('check')).toContainText('Looks good', { timeout: 10_000 });
  await page.getByTestId('text-editor').locator('.view-lines').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.insertText('\n# my unsaved note\n');
  await expect(page.getByRole('heading', { name: 'light up ghost (not saved)', level: 2 })).toBeVisible();
  // away to Boards and back: the change is still there, and it says so
  await page.getByRole('tab', { name: 'Boards' }).click();
  await page.getByRole('tab', { name: 'Your library' }).click();
  await page.getByRole('button', { name: /light up ghost/ }).first().click();
  await expect(page.getByRole('heading', { name: 'light up ghost (not saved)', level: 2 })).toBeVisible();
  await expect(page.getByText('Your changes here are not saved yet. Press Save to keep them.')).toBeVisible();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'light up ghost', level: 2 })).toBeVisible();
  // what was saved is the kept change (the editor shows only the lines in view)
  expect(fs.readFileSync(path.join(workspace, 'effects', 'light up ghost.txt'), 'utf8')).toContain('# my unsaved note');
  // the file changed outside Studio meanwhile (another window, a sync folder): Save does not overwrite it unasked
  const file = path.join(workspace, 'effects', 'light up ghost.txt');
  await page.getByTestId('text-editor').locator('.view-lines').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.insertText('# mine\n');
  fs.appendFileSync(file, '# from the laptop\n');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const m = page.getByTestId('editor-message');
  await expect(m).toContainText('was changed outside Studio since you opened it');
  expect(fs.readFileSync(file, 'utf8')).toContain('# from the laptop');
  await m.getByRole('button', { name: 'Save mine over it' }).click();
  await expect(page.getByRole('heading', { name: 'light up ghost', level: 2 })).toBeVisible();
  expect(fs.readFileSync(file, 'utf8')).toContain('# mine');
  await page.getByRole('tab', { name: 'Boards' }).click();
});

test('one obvious path from a board: make it do something, it goes to the board, try it there', async () => {
  await page.getByRole('tab', { name: 'Boards' }).click();
  await page.getByRole('button', { name: 'Add a board' }).click().catch(() => {});
  await page.getByRole('button', { name: /Add a practice board/ }).click();
  const card = page.getByTestId('board-Practice board 2');
  await expect(card.getByTestId('script-badge')).toHaveText('No effect script', { timeout: 15_000 });
  // plain words for the kind of board (not the reply's name)
  await expect(card).toContainText('Connected · Practice board (on this computer)');
  await card.getByRole('button', { name: 'Open' }).click();
  await page.getByRole('button', { name: 'Make it do something…' }).click();
  const dlg = page.getByRole('dialog', { name: 'What should Practice board 2 do?' });
  await dlg.getByLabel('Name').fill('fog burst');
  await dlg.getByRole('combobox', { name: /^Turn on/ }).click();
  await page.getByRole('option', { name: /RLY1/ }).click();
  await dlg.getByLabel('And also turn on').click();
  await page.getByRole('option', { name: /^OUT1/ }).click();
  await dlg.getByLabel('For how many seconds').fill('10'); // practice boards run 10 times faster in the tests
  await dlg.getByRole('button', { name: 'Make it and send it to Practice board 2' }).click();
  await expect(page.getByText('“fog burst” is on Practice board 2 and running.')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('try-hint')).toContainText('hold Press on TRIG1 in the Live panel for a moment. RLY1 and OUT1 turn on for 10 seconds.');
  expect(fs.readFileSync(path.join(workspace, 'effects', 'fog burst.txt'), 'utf8')).toContain('rly1 = on\n  out1 = on');
  const press = page.getByTestId('input-TRIG1').getByRole('button', { name: 'Press' });
  await press.scrollIntoViewIfNeeded(); const box = (await press.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down(); await page.waitForTimeout(300); await page.mouse.up();
  await expect(page.getByTestId('output-RLY1').getByTestId('level')).toHaveText(/^on/, { timeout: 5000 });
  await expect(page.getByTestId('output-OUT1').getByTestId('level')).toHaveText(/^on/);
  // the hint shows it too, where the person is looking (the tiles can be below the fold)
  await expect(page.getByTestId('try-now-RLY1')).toContainText('RLY1: on');
  await expect(page.getByTestId('output-RLY1').getByTestId('level')).toHaveText(/^off/, { timeout: 5000 });
  await expect(page.getByTestId('try-now-RLY1')).toContainText('RLY1: off');
  await page.getByRole('button', { name: 'Remove from Studio' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Remove' }).click();
});

test('record effect: the board copies you live, says it back, keeps it, and does it on the trigger', async () => {
  await page.getByRole('tab', { name: 'Boards' }).click();
  await page.getByRole('button', { name: 'Add a board' }).click().catch(() => {});
  await page.getByRole('button', { name: /Add a practice board/ }).click();
  const card = page.getByTestId(/^board-Practice board ([2-9]|\d\d)$/).last();
  await expect(card.getByTestId('script-badge')).toHaveText('No effect script', { timeout: 15_000 });
  const boardName = (await card.getAttribute('data-testid'))!.replace('board-', '');
  await card.getByRole('button', { name: 'Open' }).click();
  await page.getByRole('button', { name: 'Make it do something…' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Record effect' }).click();
  const rec = page.getByTestId('record-effect');
  await expect(rec).toBeVisible();
  await rec.getByLabel('Count 3, 2, 1 first').uncheck();
  // the buttons wait for Start
  await expect(rec.getByTestId('tap-OUT1')).toBeDisabled();
  await rec.getByRole('button', { name: 'Start' }).click();
  // hold OUT1 with the mouse: the real (practice) board turns it on, as reported by the board itself
  const tap = rec.getByTestId('tap-OUT1');
  await expect(tap).toBeEnabled();
  const tb = (await tap.boundingBox())!;
  await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2);
  await page.mouse.down();
  await expect(page.getByTestId('output-OUT1').getByTestId('level')).toHaveText(/^on/, { timeout: 3000 });
  await expect(tap.getByTestId('board-says')).toContainText('board: on');
  await page.waitForTimeout(4000);
  await page.mouse.up();
  await expect(page.getByTestId('output-OUT1').getByTestId('level')).toHaveText(/^off/, { timeout: 3000 });
  // then RLY1 with its number key (5), while the timeline grows
  // (practice boards run 10 times faster in the tests: a long hold stays visible when the board replays it)
  await page.keyboard.down('5');
  await expect(page.getByTestId('output-RLY1').getByTestId('level')).toHaveText(/^on/, { timeout: 3000 });
  await page.waitForTimeout(8000);
  await page.keyboard.up('5');
  await expect(page.getByTestId('output-RLY1').getByTestId('level')).toHaveText(/^off/, { timeout: 3000 });
  await expect(rec.getByTestId('timeline')).toBeVisible();
  // Space stops; the board does it back straight away
  await page.keyboard.press('Space');
  await expect(rec.getByText('The board is doing it back…')).toBeVisible();
  await expect(page.getByTestId('output-OUT1').getByTestId('level')).toHaveText(/^on/, { timeout: 3000 });
  await expect(page.getByTestId('output-RLY1').getByTestId('level')).toHaveText(/^on/, { timeout: 8000 });
  await expect(rec.getByRole('button', { name: /^Keep it: save and send to/ })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('output-RLY1').getByTestId('level')).toHaveText(/^off/, { timeout: 3000 });
  await expect(page.getByTestId('output-OUT1').getByTestId('level')).toHaveText(/^off/);
  // add more on top: the first pass plays on the board while OUT2 is held; the window losing focus lets it go
  await rec.getByRole('button', { name: 'Add more on top' }).click();
  await rec.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByTestId('output-OUT1').getByTestId('level')).toHaveText(/^on/, { timeout: 3000 });
  await page.keyboard.down('2');
  await expect(page.getByTestId('output-OUT2').getByTestId('level')).toHaveText(/^on/, { timeout: 3000 });
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  // everything off at once, the take ends there and is kept
  await expect(page.getByTestId('output-OUT2').getByTestId('level')).toHaveText(/^off/, { timeout: 3000 });
  await page.keyboard.up('2');
  await expect(rec.getByText(/its window lost focus/)).toBeVisible();
  await expect(rec.getByRole('button', { name: /^Keep it/ })).toBeVisible({ timeout: 15_000 });
  for (const ch of ['OUT1', 'OUT2', 'RLY1']) await expect(page.getByTestId(`output-${ch}`).getByTestId('level')).toHaveText(/^off/, { timeout: 3000 });
  // the board's STOP during a pass: the output goes off and the recording ends (what was tapped is kept)
  await rec.getByRole('button', { name: 'Add more on top' }).click();
  await rec.getByRole('button', { name: 'Start' }).click();
  await page.keyboard.down('3');
  await expect(page.getByTestId('output-OUT3').getByTestId('level')).toHaveText(/^on/, { timeout: 3000 });
  await page.getByRole('button', { name: 'Stop', exact: true }).first().click();
  await expect(page.getByTestId('output-OUT3').getByTestId('level')).toHaveText(/^off/, { timeout: 3000 });
  await page.keyboard.up('3');
  await expect(rec.getByRole('button', { name: /^Keep it/ })).toBeVisible({ timeout: 5000 });
  // stopped stays stopped: nothing plays or records until the board restarts
  await expect(rec.getByTestId('record-paused')).toBeVisible();
  await expect(rec.getByRole('button', { name: 'Play it again' })).toBeDisabled();
  await page.getByRole('button', { name: 'Restart', exact: true }).click();
  await expect(rec.getByTestId('record-paused')).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByText('Stopped: triggers are ignored until you resume or restart it')).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByTestId('input-TRIG1').getByTestId('input-status')).toHaveText('Ready', { timeout: 15_000 });
  // Space on a focused button is that button's own (here: Try again is not pressed by accident, nothing starts)
  await rec.getByRole('button', { name: 'Play it again' }).focus();
  await page.keyboard.press('Space');
  await expect(rec.getByText('The board is doing it back…')).toBeVisible();
  await expect(rec.getByRole('button', { name: /^Keep it/ })).toBeVisible({ timeout: 15_000 });
  // keep it: a readable effect script in the library, sent to the board
  await rec.getByLabel('Name').fill('tapped scare');
  await rec.getByRole('button', { name: /^Keep it/ }).click();
  await expect(page.getByText(`“tapped scare” is on ${boardName} and running.`)).toBeVisible({ timeout: 10_000 });
  const text = fs.readFileSync(path.join(workspace, 'effects', 'tapped scare.txt'), 'utf8');
  expect(text).toMatch(/effect tapped scare:\n  wait for trig1\n/);
  for (const l of ['out1 = on', 'out1 = off', 'out2 = on', 'out2 = off', 'out3 = on', 'out3 = off', 'rly1 = on', 'rly1 = off']) expect(text).toContain(`\n  ${l}\n`);
  expect(text).toMatch(/\n  wait \d+(\.\d)?\n/);
  expect(text).toMatch(/rly1 = off\n$/);
  await expect(page.getByTestId('record-effect')).toHaveCount(0);
  await expect(page.getByTestId('try-hint')).toContainText('hold Press on TRIG1 in the Live panel for a moment');
  // press the trigger: the board does it on its own now
  const press = page.getByTestId('input-TRIG1').getByRole('button', { name: 'Press' });
  await press.scrollIntoViewIfNeeded(); const box = (await press.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down(); await page.waitForTimeout(300); await page.mouse.up();
  await expect(page.getByTestId('output-OUT1').getByTestId('level')).toHaveText(/^on · script/, { timeout: 5000 });
  await expect(page.getByTestId('output-RLY1').getByTestId('level')).toHaveText(/^on · script/, { timeout: 5000 });
  await expect(page.getByTestId('output-RLY1').getByTestId('level')).toHaveText(/^off/, { timeout: 5000 });
  await page.getByRole('button', { name: 'Remove from Studio' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Remove' }).click();
});

test('record effect: Cancel at every step lets go of everything and keeps nothing', async () => {
  await page.getByRole('tab', { name: 'Boards' }).click();
  await page.getByRole('button', { name: 'Add a board' }).click().catch(() => {});
  await page.getByRole('button', { name: /Add a practice board/ }).click();
  const card = page.getByTestId(/^board-Practice board ([2-9]|\d\d)$/).last();
  await expect(card.getByTestId('script-badge')).toHaveText('No effect script', { timeout: 15_000 });
  await card.getByRole('button', { name: 'Open' }).click();
  const effects = path.join(workspace, 'effects');
  const saved = () => (fs.existsSync(effects) ? fs.readdirSync(effects).sort() : []);
  const before = saved();
  const level = (ch: string) => page.getByTestId(`output-${ch}`).getByTestId('level');
  const make = page.getByRole('button', { name: 'Make it do something…' });
  const open = async () => {
    await make.click();
    await page.getByRole('dialog').getByRole('button', { name: 'Record effect' }).click();
    await expect(page.getByTestId('record-effect')).toBeVisible();
    return page.getByTestId('record-effect');
  };
  const beginner = /JSON|protocol|DSL|\bgit\b|partition|submodule|branch|platformio|MQTT|DMX|\bACKs?\b|checksum|hash|baud|\bms\b|trigger_repeat|sound_trigger|_/i;

  // arming (the 3-2-1): Cancel is there, nothing recorded, so it closes without a question
  let rec = await open();
  await expect(rec.getByTestId('record-cancel')).toBeVisible();
  expect(await rec.innerText()).not.toMatch(beginner);
  // Escape with the "What starts it" list open closes the list, not the recorder
  await rec.getByLabel('What starts it').click();
  await expect(page.getByRole('listbox')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await expect(rec).toBeVisible();
  await rec.getByRole('button', { name: 'Start' }).click();
  await expect(rec.getByTestId('count-in')).toBeVisible();
  await expect(rec.getByTestId('record-cancel')).toBeVisible();
  await rec.getByTestId('record-cancel').click();
  await expect(page.getByTestId('record-effect')).toHaveCount(0);
  await expect(page.getByTestId('record-discard')).toHaveCount(0);
  await expect(make).toBeFocused(); // back where it was started
  await page.waitForTimeout(3000); // the count-in would have ended by now: nothing starts later
  await expect(page.getByTestId('record-effect')).toHaveCount(0);

  // mid-recording, OUT1 and RLY1 held (keys 1 and 5): Escape lets go of both at once, before anything is asked
  rec = await open();
  await rec.getByLabel('Count 3, 2, 1 first').uncheck();
  await rec.getByRole('button', { name: 'Start' }).click();
  await expect(rec.getByTestId('rec-clock')).toBeVisible();
  await expect(rec.getByTestId('record-cancel')).toBeVisible();
  await page.keyboard.down('1');
  await page.keyboard.down('5');
  await expect(level('OUT1')).toHaveText(/^on/, { timeout: 3000 });
  await expect(level('RLY1')).toHaveText(/^on/, { timeout: 3000 });
  await page.waitForTimeout(1000);
  await page.keyboard.press('Escape');
  const ask = page.getByTestId('record-discard');
  await expect(ask.getByRole('heading', { name: 'Discard this recording?' })).toBeVisible();
  await expect(level('OUT1')).toHaveText(/^off/, { timeout: 3000 });
  await expect(level('RLY1')).toHaveText(/^off/, { timeout: 3000 });
  await page.keyboard.up('1');
  await page.keyboard.up('5');
  expect(await ask.innerText()).not.toMatch(beginner);
  await expect(ask.getByRole('button', { name: 'No, go back' })).toBeFocused(); // Enter never throws a take away
  await ask.getByRole('button', { name: 'Discard' }).click();
  await expect(page.getByTestId('record-effect')).toHaveCount(0);
  await expect(make).toBeFocused();
  await page.waitForTimeout(1000); // no playback after a discard
  await expect(level('OUT1')).toHaveText(/^off/);
  await expect(level('RLY1')).toHaveText(/^off/);
  expect(saved()).toEqual(before);

  // on review: No, go back keeps the take; Cancel again, Discard: nothing saved, nothing sent
  rec = await open();
  await rec.getByLabel('Count 3, 2, 1 first').uncheck();
  await rec.getByRole('button', { name: 'Start' }).click();
  await page.keyboard.down('5');
  await expect(level('RLY1')).toHaveText(/^on/, { timeout: 3000 });
  await page.waitForTimeout(1500);
  await page.keyboard.up('5');
  await page.keyboard.press('Space');
  await expect(rec.getByRole('button', { name: /^Keep it: save and send to/ })).toBeVisible({ timeout: 15_000 });
  await expect(rec.getByTestId('record-cancel')).toBeVisible();
  await rec.getByTestId('record-cancel').click();
  await expect(ask).toBeVisible();
  await ask.getByRole('button', { name: 'No, go back' }).click();
  await expect(ask).toHaveCount(0);
  await expect(rec.getByRole('button', { name: /^Keep it: save and send to/ })).toBeFocused();
  await expect(rec.getByTestId('recorded-script')).toContainText('rly1 = on');
  await rec.getByTestId('record-cancel').click();
  await ask.getByRole('button', { name: 'Discard' }).click();
  await expect(page.getByTestId('record-effect')).toHaveCount(0);
  expect(saved()).toEqual(before);
  await expect(page.getByTestId('script-badge')).toHaveText('No effect script');
  for (const ch of ['OUT1', 'RLY1']) await expect(level(ch)).toHaveText(/^off/);
  await page.getByRole('button', { name: 'Remove from Studio' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Remove' }).click();
});

test('library: duplicate, rename, delete', async () => {
  await page.getByRole('tab', { name: 'Your library' }).click();
  await page.getByRole('button', { name: /light up ghost/ }).first().click();
  await page.getByRole('button', { name: 'Duplicate…' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('heading', { name: 'light up ghost (copy)', level: 2 })).toBeVisible();
  await page.getByRole('button', { name: 'Rename…' }).click();
  await page.getByRole('dialog').getByLabel('Name').fill('spare ghost');
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('heading', { name: 'spare ghost', level: 2 })).toBeVisible();
  expect(fs.existsSync(path.join(workspace, 'effects', 'spare ghost.txt'))).toBe(true);
  await page.getByRole('button', { name: 'Delete…' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByRole('button', { name: /spare ghost/ })).toHaveCount(0);
  expect(fs.existsSync(path.join(workspace, 'effects', 'spare ghost.txt'))).toBe(false);
  expect(fs.readdirSync(path.join(workspace, '.specter', 'trash')).length).toBe(1);
});

test('a new effect with a name already in the library replaces nothing', async () => {
  const before = fs.readFileSync(path.join(workspace, 'effects', `${NAME}.txt`), 'utf8');
  await page.getByRole('tab', { name: 'Your library' }).click();
  await page.getByRole('button', { name: 'New effect' }).click();
  await page.getByRole('dialog').getByLabel('Name').fill(NAME);
  await page.getByRole('dialog').getByRole('button', { name: 'Make it' }).click();
  await expect(page.getByRole('heading', { name: `${NAME} 2`, level: 2 })).toBeVisible();
  await expect(page.getByTestId('name-taken')).toContainText(`There is already an effect called “${NAME}”`);
  expect(fs.readFileSync(path.join(workspace, 'effects', `${NAME}.txt`), 'utf8')).toBe(before);
  expect(fs.readFileSync(path.join(workspace, 'effects', `${NAME} 2.txt`), 'utf8')).toContain(`effect ${NAME} 2:`);
  await page.getByRole('button', { name: 'Delete…' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByRole('button', { name: `${NAME} 2` })).toHaveCount(0);
});

test('one board, or the selected boards: send an effect just to them', async () => {
  await page.getByRole('tab', { name: 'Boards' }).click();
  await page.getByRole('button', { name: 'Add a board' }).click().catch(() => {});
  await page.getByRole('button', { name: /Add a practice board/ }).click();
  const one = page.getByTestId('board-Practice board 1');
  const two = page.getByTestId('board-Practice board 2');
  await expect(two.getByTestId('script-badge')).toHaveText('No effect script', { timeout: 15_000 });
  // the selection: only board 2
  await page.getByLabel('Select Practice board 2').check();
  const bar = page.getByRole('region', { name: 'Selected boards' });
  await expect(bar).toContainText('1 selected');
  await bar.getByRole('button', { name: 'Send an effect…' }).click();
  await page.getByRole('dialog').getByRole('button', { name: /light up ghost/ }).click();
  await expect(two.getByTestId('script-badge')).toHaveText('“light up ghost”: up to date', { timeout: 10_000 });
  await expect(one.getByTestId('script-badge')).toHaveText(`“${NAME}”: up to date`);
  await bar.getByRole('button', { name: 'Clear selection' }).click();
  // one tile's own button
  await two.getByRole('button', { name: 'Send an effect…' }).click();
  await page.getByRole('dialog').getByRole('button', { name: NAME }).click();
  await expect(two.getByTestId('script-badge')).toHaveText(`“${NAME}”: up to date`, { timeout: 10_000 });
  await two.getByRole('button', { name: 'Open' }).click();
  await page.getByRole('button', { name: 'Remove from Studio' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Remove' }).click();
});

test('a board\'s effect script is edited on its page: send to this board, save to the library, or both', async () => {
  await page.getByRole('tab', { name: 'Boards' }).click();
  await page.getByRole('button', { name: 'Add a board' }).click().catch(() => {});
  await page.getByRole('button', { name: /Add a practice board/ }).click();
  const card = page.getByTestId('board-Practice board 2');
  await expect(card.getByTestId('script-badge')).toHaveText('No effect script', { timeout: 15_000 });
  await card.getByRole('button', { name: 'Open' }).click();
  // a wide window: the live tiles beside the script, which is the section shown first
  await expect(page.getByTestId('live-pane').getByTestId('input-TRIG1')).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Effect script' })).toHaveAttribute('aria-selected', 'true');
  const panel = page.getByTestId('board-script-panel');
  const actions = panel.getByTestId('board-script-actions');
  const badge = page.getByTestId('script-badge'); // the board page's own, beside the firmware
  const key = await keyOf('Practice board 2');
  const onBoard = async () => (await deviceLayer('rpc', { key, req: { op: 'get_script' } })).result.text as string;
  // the same editor as the library's: colours, blocks, the checker, go to line
  const editor = panel.getByTestId('text-editor');
  await editor.locator('.view-lines').click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.insertText('effect porch light:\n  wait for trig1\n  rly1 = 50%\n');
  const err = panel.getByTestId('check-error').filter({ hasText: 'rly1 can only be on or off' });
  await expect(err).toBeVisible({ timeout: 10_000 });
  // the effect language's colours: "effect" is not drawn as plain text
  await expect(editor.locator('.view-line span span', { hasText: /^effect$/ }).first()).not.toHaveClass(/\bmtk1\b/);
  await expect(actions.getByRole('button', { name: 'Send to this board only' })).toBeDisabled();
  await err.click();
  await expect(editor).toHaveAttribute('data-goto-line', '3');
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.insertText('effect porch light:\n  wait for trig1\n  out1 = on\n  sleep 1\n  out1 = off\n');
  await expect(panel.getByTestId('check')).toContainText('Looks good', { timeout: 10_000 });
  await expect(panel.getByTestId('blocks').getByText('porch light').first()).toBeVisible();
  await expect(actions).toContainText('Changed here, not sent yet.');
  // 1. this board only: on the board as typed, not in the library
  await actions.getByRole('button', { name: 'Send to this board only' }).click();
  await expect(page.getByText('The effect script is on Practice board 2 and running.')).toBeVisible({ timeout: 10_000 });
  await expect.poll(onBoard).toMatch(/^effect porch light:\n  wait for trig1\n  out1 = on\n  sleep 1\n  out1 = off\n\s*$/); // no header line
  await expect(badge).toHaveText('Effect script not in your library', { timeout: 10_000 });
  await expect(actions).not.toContainText('Changed here');
  // ... then kept in the library under a name: up to date
  await actions.getByRole('button', { name: 'Save it to Your library' }).click();
  await page.getByRole('dialog').getByLabel('Name').fill('porch light');
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
  await expect(badge).toHaveText('“porch light”: up to date', { timeout: 10_000 });
  expect(fs.readFileSync(path.join(workspace, 'effects', 'porch light.txt'), 'utf8')).toContain('out1 = on');
  // 2. both: saved and sent, still up to date, and the board's text names it
  await editor.locator('.view-lines').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.insertText('# brighter\n');
  await actions.getByRole('button', { name: 'Save and send' }).click();
  await expect(page.getByText('“porch light” is on Practice board 2 and running.')).toBeVisible({ timeout: 10_000 });
  await expect(badge).toHaveText('“porch light”: up to date', { timeout: 10_000 });
  expect(fs.readFileSync(path.join(workspace, 'effects', 'porch light.txt'), 'utf8')).toContain('# brighter');
  await expect.poll(onBoard).toMatch(/^# Specter Studio: porch light, saved .*# brighter\n\s*$/s);
  await expect(panel.getByTestId('board-script-header')).toContainText('Sent from Studio: “porch light”, saved ');
  // 3. the library only: the board keeps its version until it is sent (one click)
  await editor.locator('.view-lines').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.insertText('# library only\n');
  await actions.getByRole('button', { name: 'Save to library only' }).click();
  await expect(panel.getByTestId('board-script-message')).toContainText('Practice board 2 still runs its own version until you send it.');
  await expect(badge).toHaveText('“porch light”: newer version in your library', { timeout: 10_000 });
  expect(await onBoard()).not.toContain('# library only');
  await actions.getByRole('button', { name: 'Update to the newest “porch light”' }).click();
  await expect(badge).toHaveText('“porch light”: up to date', { timeout: 10_000 });
  await expect.poll(onBoard).toContain('# library only');
  // changed on the board only: compare the two side by side, then put the library's back
  await editor.locator('.view-lines').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.insertText('# only here\n');
  await actions.getByRole('button', { name: 'Send to this board only' }).click();
  await expect(badge).toHaveText('“porch light”: changed on the board', { timeout: 10_000 });
  await panel.getByRole('button', { name: 'Compare with Your library' }).click();
  const cmp = page.getByRole('dialog', { name: /“porch light”: Practice board 2 and Your library/ });
  await expect(cmp.getByTestId('script-diff')).toContainText('# only here', { timeout: 10_000 });
  await cmp.getByRole('button', { name: 'Send Your library\'s version to Practice board 2' }).click();
  await expect(badge).toHaveText('“porch light”: up to date', { timeout: 10_000 });
  expect(await onBoard()).not.toContain('# only here');
  // an unsent edit survives a look at another section
  await editor.locator('.view-lines').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.insertText('# not yet\n');
  await page.getByRole('tab', { name: 'Plot' }).last().click();
  await page.getByRole('tab', { name: 'Effect script' }).click();
  await expect(panel.getByTestId('text-editor').locator('.view-lines')).toContainText('# not yet');
  await actions.getByRole('button', { name: 'Undo changes' }).click();
  await expect(panel.getByTestId('text-editor').locator('.view-lines')).not.toContainText('# not yet');
  // a narrow window: the tiles go behind a Live tab, the script is a tab beside it
  await page.setViewportSize({ width: 1000, height: 900 });
  await expect(page.getByTestId('live-pane')).toHaveCount(0);
  await page.getByRole('tab', { name: 'Live' }).click();
  await expect(page.getByTestId('input-TRIG1')).toBeVisible();
  await page.getByRole('tab', { name: 'Effect script' }).click();
  await expect(panel.getByTestId('text-editor')).toBeVisible();
  await page.setViewportSize({ width: 1300, height: 900 });
});

test('one step each way between a board\'s script and its library copy', async () => {
  const heading = (n: string) => page.getByRole('heading', { name: n, level: 2 });
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  // from the board (its page header, whatever section is open): Open in Your library
  await page.getByRole('tab', { name: 'Settings' }).last().click();
  await page.getByTestId('open-board-script').click();
  await expect(page.getByTestId('open-board-script')).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Your library' })).toHaveAttribute('aria-selected', 'true');
  await expect(heading('porch light')).toBeVisible();
  await expect(page.getByTestId('text-editor').locator('.view-lines')).toContainText('# library only');
  // Back returns to the board, Forward to the effect
  await page.getByRole('button', { name: 'Go back' }).click();
  await expect(heading('Practice board 2')).toBeVisible();
  await page.getByRole('button', { name: 'Go forward' }).click();
  await expect(heading('porch light')).toBeVisible();
  // from the library: the boards running it, with the version each runs, one click to the board's script
  const running = page.getByTestId('boards-running');
  await expect(running.getByTestId('boards-running-toggle')).toHaveText(/Boards running this effect \(1\)/);
  await expect(running.getByTestId('boards-running-summary')).toHaveText('1 same');
  const row = running.getByTestId('running-Practice board 2');
  await expect(row).toContainText('Same version');
  // folds away and comes back, from the keyboard
  await running.getByTestId('boards-running-toggle').focus();
  await page.keyboard.press('Enter');
  await expect(row).toHaveCount(0);
  await expect(running.getByTestId('boards-running-toggle')).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press('Enter');
  await row.getByRole('button', { name: 'Open board Practice board 2' }).click();
  await expect(heading('Practice board 2')).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Effect script' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('board-script-panel').getByTestId('text-editor').locator('.view-lines')).toContainText('# library only');
  await page.getByRole('button', { name: 'Go back' }).click();
  await expect(heading('porch light')).toBeVisible();
  // the command palette, both ways
  await page.keyboard.press('ControlOrMeta+Shift+P');
  await page.keyboard.insertText('board running this script');
  await palette.getByRole('option', { name: /Open a board running this script: Practice board 2/ }).click();
  await expect(heading('Practice board 2')).toBeVisible();
  await page.keyboard.press('ControlOrMeta+Shift+P');
  await page.keyboard.insertText("this board's script");
  await palette.getByRole('option', { name: /Open this board's script/ }).click();
  await expect(heading('porch light')).toBeVisible();
  await page.getByRole('button', { name: 'Go back' }).click();
  await expect(heading('Practice board 2')).toBeVisible();

  // a script Your library does not have (put on the board by another program): saved there under a free name, then opened
  const key = await keyOf('Practice board 2');
  const text = 'effect porch light:\n  wait for trig2\n  out2 = on\n  sleep 1\n  out2 = off\n';
  expect((await deviceLayer('rpc', { key, req: { op: 'set_script', text, bytes: text.length } })).ok).toBe(true);
  await page.getByRole('tab', { name: 'Effect script' }).click(); // the board's page reads its script again
  await expect(page.getByTestId('script-badge')).toHaveText('Effect script not in your library', { timeout: 10_000 });
  await page.getByTestId('open-board-script').filter({ hasText: 'Save to Your library and open' }).click();
  await expect(heading('porch light 2')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('editor-message')).toContainText('Saved Practice board 2\'s effect script to Your library as “porch light 2”.');
  await expect(page.getByTestId('editor-message')).toContainText('Nothing was replaced.');
  expect(fs.readFileSync(path.join(workspace, 'effects', 'porch light 2.txt'), 'utf8')).toBe(text); // word for word
  expect(fs.readFileSync(path.join(workspace, 'effects', 'porch light.txt'), 'utf8')).toContain('# library only'); // untouched
  // the board now runs the library's “porch light 2”, the same version
  await expect(page.getByTestId('boards-running').getByTestId('running-Practice board 2')).toContainText('Same version', { timeout: 10_000 });
  await page.getByRole('button', { name: 'Go back' }).click();
  await expect(heading('Practice board 2')).toBeVisible();
  await expect(page.getByTestId('script-badge')).toHaveText('“porch light 2”: up to date', { timeout: 10_000 });
  await expect(page.getByTestId('open-board-script')).toHaveText('Open in Your library');
  await page.getByRole('button', { name: 'Remove from Studio' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Remove' }).click();
});

test('firmware updates come from the official releases without any setup', async () => {
  // the board's card has nothing to set up; Settings names the source and finds its newest release
  // (the bridge's GitHub is tests/fixtures/github-mock.mjs)
  await expect(page.getByTestId('board-Practice board 1').getByRole('button', { name: /set it up/ })).toHaveCount(0);
  await page.getByRole('tab', { name: 'Settings' }).first().click();
  await expect(page.getByTestId('release-source')).toHaveText('New firmware comes from the Specter Proptroller releases on GitHub.');
  await expect(page.getByText('Checking needs the internet.', { exact: false })).toBeVisible();
  await expect(page.getByLabel('Release list (web address or folder)')).toHaveCount(0); // changing it is under Advanced
  await page.getByRole('button', { name: 'Check now' }).click();
  await expect(page.getByText('Found firmware 0.1.9 (1 board type).')).toBeVisible();
  // Allow betas: off by default, saved with the other settings
  const betas = page.getByRole('checkbox', { name: 'Allow betas (test versions before they are released)' });
  await expect(betas).not.toBeChecked();
  await betas.check();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('specter-prefs') || '{}').betas)).toBe(true);
  await page.getByRole('tab', { name: 'Boards' }).click();
  await page.getByRole('tab', { name: 'Settings' }).first().click();
  await expect(betas).toBeChecked();
  await betas.uncheck();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('specter-prefs') || '{}').betas)).toBe(false);
  await page.getByRole('tab', { name: 'Boards' }).click();
});

test('firmware: out of date against a release folder, update it', async () => {
  fs.mkdirSync(releases, { recursive: true });
  const img = simImage('0.2.0');
  fs.writeFileSync(path.join(releases, 'sim.bin'), img);
  fs.writeFileSync(path.join(releases, 'proptroller-firmware.json'), JSON.stringify({ version: '0.2.0', images: [
    { fw: 'generic', impl: 'cpp', mcu: 'sim', file: 'sim.bin', bytes: img.length, sha256: createHash('sha256').update(img).digest('hex') }] }));
  await page.getByRole('tab', { name: 'Settings' }).first().click();
  await page.getByLabel('Advanced mode').check(); // another release source is an Advanced setting
  await page.getByLabel('Release list (web address or folder)').fill(releases);
  await page.getByRole('button', { name: 'Use it' }).click();
  await expect(page.getByText('Found firmware 0.2.0 (1 board type).')).toBeVisible();
  await expect(page.getByTestId('release-source')).toContainText(releases);
  await page.getByLabel('Advanced mode').uncheck();
  await page.getByRole('tab', { name: 'Boards' }).click();
  const card = page.getByTestId('board-Practice board 1');
  await expect(card.getByText('Firmware update available: 0.2.0')).toBeVisible({ timeout: 10_000 });
  await card.getByRole('button', { name: 'Update firmware' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Update' }).click();
  await expect(page.getByText('Practice board 1 now runs firmware 0.2.0.')).toBeVisible({ timeout: 60_000 });
  await expect(card.getByText('Firmware up to date')).toBeVisible({ timeout: 10_000 });
});

test('advanced mode shows the technical tools', async () => {
  await page.getByLabel('Advanced mode').check();
  await page.getByTestId('board-Practice board 1').getByRole('button', { name: 'Open' }).click();
  await page.getByRole('tab', { name: 'Protocol console' }).click();
  await page.getByRole('button', { name: 'Send request' }).click();
  await expect(page.getByLabel('Answer')).toContainText('"uptime_ms"');
  // turning Advanced off on the console tab shows Live, or on a wide window (no Live tab) the effect script
  // (bench run 2026-10-22: no tab selected, MUI errors)
  const errors: string[] = [];
  const onConsole = (m: any) => { if (m.type() === 'error') errors.push(m.text()); };
  page.on('console', onConsole);
  await page.getByLabel('Advanced mode').uncheck();
  await expect(page.getByRole('tab', { name: 'Protocol console' })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Effect script' })).toHaveAttribute('aria-selected', 'true');
  await page.waitForTimeout(300);
  page.off('console', onConsole);
  expect(errors.filter((e) => /Tabs component is invalid/.test(e))).toEqual([]);
});

test.afterAll(async () => {
  // this file's Studio page goes too: a page left open keeps talking to the shared device layer (and loading the
  // browser) through every later file
  await page?.context().close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('serial monitor and plotter', async () => {
  // a pseudo-terminal stands in for a board: it prints numbers and echoes what it gets
  const { spawn } = await import('node:child_process');
  const py = spawn('python3', ['-c', `
import os, sys, time, select
m, s = os.openpty()
import tty; tty.setraw(s)
print(os.ttyname(s), flush=True)
i = 0
while True:
    r, _, _ = select.select([m], [], [], 0.1)
    if r:
        os.write(m, b"echo: " + os.read(m, 100).strip() + b"\\r\\n")
    i += 1
    os.write(m, ("temp:%d hum:%d\\r\\n" % (20 + i % 5, 40 + i % 3)).encode())
`]);
  const ptyPath: string = await new Promise((res) => py.stdout.once('data', (d) => res(String(d).trim())));
  try {
    await page.getByLabel('Advanced mode').check();
    await page.getByRole('tab', { name: 'Serial monitor' }).click();
    await page.getByLabel('Port path').fill(ptyPath);
    await page.getByRole('button', { name: 'Connect' }).click();
    await expect(page.getByTestId('serial-output')).toContainText('temp:', { timeout: 5000 });
    await page.getByLabel('Send a line').fill('hello');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByTestId('serial-output')).toContainText('echo: hello', { timeout: 5000 });
    await page.getByRole('tab', { name: 'Plotter' }).click();
    await expect(page.getByRole('button', { name: 'temp' })).toBeVisible({ timeout: 5000 });
    await expect(page.getByRole('button', { name: 'hum' })).toBeVisible();
    await page.getByRole('tab', { name: 'Monitor', exact: true }).click();
    await page.getByRole('button', { name: 'Disconnect' }).click();
    await page.getByLabel('Advanced mode').uncheck();
  } finally {
    py.kill();
  }
});

test('plugins see boards only through the message API', async () => {
  // A press in the plugin's frame right after it appears can be lost: the frame is sandboxed (a process of its own in
  // Chrome), and a click that comes before Chrome can route input to it goes nowhere (traces: the button was there
  // and the click landed on it, but its handler never ran). So each press here is repeated until its result shows,
  // and only where pressing again changes nothing.
  const pressUntil = async (press: () => Promise<unknown>, done: () => Promise<unknown>, timeout = 30_000) => {
    await expect(async () => {
      await press();
      await done();
    }).toPass({ timeout });
  };
  await page.reload();
  await page.getByRole('tab', { name: 'Board list (example plugin)' }).click();
  const f = page.frameLocator('iframe[title="Board list (example plugin)"]');
  await expect(f.getByRole('heading', { name: 'Practice board 1' })).toBeVisible({ timeout: 15_000 });
  const up = f.getByRole('button', { name: /^Up \d+ s$/ });
  await pressUntil(async () => { if (!(await up.isVisible())) await f.getByRole('button', { name: /^Ask for its state$|^No answer/ }).click({ timeout: 2000 }); },
    () => expect(up).toBeVisible({ timeout: 5000 }));
  // board-changing work goes through Studio, which asks the person first in its own dialog, showing the plugin and
  // the whole script; a no holds the plugin off, a yes sends it
  const ask = page.getByRole('dialog', { name: /Board list \(example plugin\) \(board-list\) wants to replace the effect script on Practice board 1/ });
  await pressUntil(async () => { if (!(await ask.isVisible())) await f.getByRole('button', { name: /^Send a tiny test effect$|^Not sent: Studio is already asking/ }).click({ timeout: 2000 }); },
    () => expect(ask).toBeVisible({ timeout: 3000 }));
  await expect(ask.getByTestId('plugin-script')).toContainText('wait for trig2');
  await pressUntil(async () => { if (await ask.isVisible()) await ask.getByRole('button', { name: 'No' }).click({ timeout: 2000 }); },
    () => expect(ask).toBeHidden({ timeout: 3000 }));
  await expect(f.getByRole('button', { name: 'Not sent: the person said no' })).toBeVisible({ timeout: 15_000 });
  const later = f.getByRole('button', { name: 'Not sent: the person said no; ask again later' });
  await pressUntil(async () => { if (!(await later.isVisible())) await f.getByRole('button', { name: 'Not sent: the person said no' }).click({ timeout: 2000 }); },
    () => expect(later).toBeVisible({ timeout: 3000 }));
  await expect(ask).toBeHidden();
  // opened again (Studio started again, a new page of the plugin), it may ask again
  await page.reload();
  await page.getByRole('tab', { name: 'Board list (example plugin)' }).click();
  await expect(f.getByRole('heading', { name: 'Practice board 1' })).toBeVisible({ timeout: 15_000 });
  await pressUntil(async () => { if (!(await ask.isVisible())) await f.getByRole('button', { name: /Not sent|Send a tiny/ }).click({ timeout: 2000 }); },
    () => expect(ask).toBeVisible({ timeout: 3000 }));
  await pressUntil(async () => { if (await ask.isVisible()) await ask.getByRole('button', { name: 'Send this script' }).click({ timeout: 2000 }); },
    () => expect(ask).toBeHidden({ timeout: 3000 }));
  await expect(f.getByRole('button', { name: 'Test effect sent' })).toBeVisible({ timeout: 15_000 });
  await page.getByRole('tab', { name: 'Boards' }).click();
  await expect(page.getByTestId('board-Practice board 1').getByTestId('script-badge')).toHaveText('Effect script not in your library', { timeout: 10_000 });
  await page.getByTestId('board-Practice board 1').getByRole('button', { name: 'Send an effect…' }).click();
  await page.getByRole('dialog').getByRole('button', { name: NAME }).click();
  await expect(page.getByTestId('board-Practice board 1').getByTestId('script-badge')).toHaveText(`“${NAME}”: up to date`, { timeout: 10_000 });
});

test('your own firmware: new from the template, build it', async () => {
  await page.getByLabel('Advanced mode').check();
  await page.getByRole('tab', { name: 'Your library' }).click();
  await page.getByRole('button', { name: 'New firmware' }).click();
  await page.getByRole('dialog').getByLabel('Name').fill('ghost in the machine');
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('heading', { name: 'ghost in the machine', level: 2 })).toBeVisible();
  expect(fs.existsSync(path.join(workspace, 'firmware/ghost-in-the-machine/ghost-in-the-machine.ino'))).toBe(true);
  await expect(page.locator('.monaco-editor').first()).toContainText('prop.begin()');
  await page.getByRole('button', { name: 'Build only' }).click();
  await expect(page.getByText('Built ghost in the machine v1.')).toBeVisible({ timeout: 300_000 });
  await expect(page.getByText('version 1').first()).toBeVisible();
  // an unsaved edit survives going to another page and back (it was lost silently before)
  await page.locator('.monaco-editor').first().click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('// kept while away');
  await expect(page.getByRole('heading', { name: 'ghost in the machine (not saved)', level: 2 })).toBeVisible();
  await page.getByRole('tab', { name: 'Boards' }).click();
  await page.getByRole('tab', { name: 'Your library' }).click();
  await page.getByLabel('Firmware', { exact: true }).getByRole('button', { name: /ghost in the machine/ }).click();
  await expect(page.getByRole('heading', { name: 'ghost in the machine (not saved)', level: 2 })).toBeVisible();
  await expect(page.locator('.monaco-editor').first()).toContainText('// kept while away');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'ghost in the machine', level: 2, exact: true })).toBeVisible();
  expect(fs.readFileSync(path.join(workspace, 'firmware/ghost-in-the-machine/ghost-in-the-machine.ino'), 'utf8')).toContain('// kept while away');
  await page.getByLabel('Advanced mode').uncheck();
});

test('firmware as blocks: blocks make the sketch, it builds; a hand edit switches to text', async () => {
  await page.getByLabel('Advanced mode').check();
  await page.getByRole('tab', { name: 'Your library' }).click();
  await page.getByRole('button', { name: /ghost in the machine/ }).click();
  await page.getByRole('checkbox', { name: 'Blocks', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: 'Blocks', exact: true })).toBeChecked();
  await expect(page.getByTestId('cpp-blocks').getByText('is pressed').first()).toBeVisible();
  const sketch = page.getByTestId('sketch-text').locator('.view-lines');
  await expect(sketch).toContainText('playSound(1);');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const dir = path.join(workspace, 'firmware/ghost-in-the-machine');
  await expect(page.getByRole('heading', { name: 'ghost in the machine', level: 2, exact: true })).toBeVisible(); // saved: no "(not saved)"
  const ino = fs.readFileSync(path.join(dir, 'ghost-in-the-machine.ino'), 'utf8');
  expect(ino).toContain('Made with blocks in Specter Studio');
  expect(ino).toContain('prop.when(TRIG1).turnOn(OUT1, seconds(2)).then().playSound(1);');
  expect(fs.existsSync(path.join(dir, 'ghost-in-the-machine.blocks.json'))).toBe(true);
  await page.getByRole('button', { name: 'Build only' }).click();
  await expect(page.getByText('Built ghost in the machine v2.')).toBeVisible({ timeout: 300_000 });
  // edited by hand outside the blocks: it opens as text, with the reason
  fs.appendFileSync(path.join(dir, 'ghost-in-the-machine.ino'), '// my own line\n');
  await page.getByRole('button', { name: /light up ghost/ }).click();
  await page.getByRole('button', { name: /ghost in the machine/ }).click();
  await expect(page.getByText('This sketch was changed by hand, so it opens as text.', { exact: false })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Blocks', exact: true })).not.toBeChecked();
  await page.getByLabel('Advanced mode').uncheck();
});

test('wiring guides: from a terminal tile and from Help', async () => {
  test.skip(!process.env.SPECTER_GUIDES_DIR, 'set SPECTER_GUIDES_DIR to the wiring guides folder');
  await page.getByRole('tab', { name: 'Boards' }).click();
  await page.getByTestId('board-Practice board 1').getByRole('button', { name: 'Open' }).click();
  await page.getByTestId('output-OUT1').getByRole('button', { name: 'How do I wire this?' }).click();
  const frame = page.frameLocator('iframe[title="Wiring guide: OUT1"]');
  await expect(frame.locator('body')).toContainText(/lamp/i, { timeout: 10_000 });
  await page.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('tab', { name: 'Help' }).click();
  await expect(page.frameLocator('iframe[title="Wiring guides"]').locator('body')).toContainText(/TRIG1|button/i, { timeout: 10_000 });
});

test('a locked board asks for its page password (never stored unless asked)', async () => {
  await page.getByRole('tab', { name: 'Boards' }).click();
  await page.getByTestId('board-Practice board 1').getByRole('button', { name: 'Open' }).click();
  await page.getByRole('tab', { name: 'Settings' }).last().click();
  await page.getByLabel('Page password').fill('ghost123');
  await page.getByLabel('Page lock').check();
  // typed settings are kept on disk for a crash, never the password
  const unsavedFile = path.join(workspace, '.specter', 'unsaved.json');
  await expect.poll(() => (fs.existsSync(unsavedFile) ? fs.readFileSync(unsavedFile, 'utf8') : ''), { timeout: 5_000 }).toContain('"page_lock": true');
  expect(fs.readFileSync(unsavedFile, 'utf8')).not.toContain('ghost123');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByText(/^Saved/)).toBeVisible();
  await page.getByRole('tab', { name: 'Effect script' }).click();
  await page.getByRole('button', { name: 'Send another effect from Your library…' }).click();
  await page.getByRole('dialog').getByRole('button', { name: NAME }).click();
  const dlg = page.getByRole('dialog');
  await expect(dlg.getByText('Page password for Practice board 1')).toBeVisible();
  await expect(dlg.getByLabel(/Remember it/)).not.toBeChecked();
  await dlg.getByLabel('Page password').fill('wrong');
  await dlg.getByRole('button', { name: 'Unlock' }).click();
  await expect(page.getByRole('dialog').getByText('Page password for Practice board 1')).toBeVisible();
  await page.getByRole('dialog').getByLabel('Page password').fill('ghost123');
  await page.getByRole('dialog').getByRole('button', { name: 'Unlock' }).click();
  await expect(page.getByText(`“${NAME}” is on Practice board 1 and running.`)).toBeVisible({ timeout: 10_000 });
});

test('beginner mode never uses technical words', async () => {
  const words = /JSON|protocol|DSL|\bgit\b|partition|submodule|branch|platformio|MQTT|DMX|\bACKs?\b|checksum|hash|baud|\bms\b|trigger_repeat|sound_trigger|_/i;
  const visible = async (where: string) => {
    const t = await page.locator('main').innerText();
    expect(t, where).not.toMatch(words);
  };
  await page.getByRole('tab', { name: 'Boards' }).click();
  await visible('boards');
  await page.getByTestId('board-Practice board 1').getByRole('button', { name: 'Open' }).click();
  for (const tab of ['Live', 'Effect script', 'Plot', 'Settings', 'Backups', 'Activity']) {
    if (tab === 'Live') { await showLive(page); await expect(page.getByTestId('input-TRIG1')).toBeVisible(); } else await page.getByRole('tab', { name: tab }).last().click();
    // the plot leaves out values that never moved, and says so
    if (tab === 'Plot') await expect(page.getByText('Nothing has changed yet. Press an input or hold to test an output, and it shows up here.')).toBeVisible({ timeout: 5000 });
    await visible(`board ${tab}`);
  }
  // a status value that moves shows on the plot under its plain name (the series keeps the board's key inside)
  await page.getByRole('tab', { name: 'Plot' }).last().click();
  const key = await keyOf('Practice board 1');
  await deviceLayer('rpc', { key, req: { op: 'sim_input', input: 'TRIG1', active: true } });
  await expect(page.getByRole('button', { name: 'TRIG1' })).toBeVisible({ timeout: 10_000 });
  await deviceLayer('rpc', { key, req: { op: 'sim_input', input: 'TRIG1', active: false } });
  await expect(page.getByRole('button', { name: 'Run count' })).toBeVisible({ timeout: 10_000 });
  await visible('board Plot, a status value moved');
  await page.getByRole('tab', { name: 'Your library' }).click();
  await page.getByRole('button', { name: NAME }).click();
  // with the blocks drawn (their sound blocks say "play sound", not the script's words)
  await expect(page.getByTestId('blocks').getByText(/play\s+sound/).first()).toBeVisible({ timeout: 10_000 });
  await visible('effect');
  for (const tab of ['Settings', 'Help']) {
    await page.getByRole('tab', { name: tab, exact: true }).first().click();
    await visible(tab);
  }
});

test('accessibility: no serious problems on the main pages, in every theme', async () => {
  const { default: AxeBuilder } = await import('@axe-core/playwright');
  const problems: string[] = [];
  const scan = async (where: string) => {
    // the code editor and the blocks canvas are third-party widgets with their own accessibility modes
    const r = await new AxeBuilder({ page }).exclude('.monaco-editor').exclude('.blocklySvg').exclude('.blocklyToolboxDiv').exclude('.blocklyFlyout').exclude('iframe').analyze();
    for (const v of r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')) {
      problems.push(`${where}: ${v.id} (${v.nodes.length}) ${v.nodes[0]?.target}`);
    }
  };
  // a warning chip on screen (the library has a newer version of the board's effect)
  await page.getByRole('tab', { name: 'Your library' }).click();
  await page.getByRole('button', { name: NAME }).click();
  await page.getByTestId('text-editor').locator('.view-lines').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.insertText('# a11y\n');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('tab', { name: 'Boards' }).click();
  await expect(page.getByTestId('board-Practice board 1').getByTestId('script-badge')).toContainText('newer version', { timeout: 10_000 });
  for (const mode of ['Light', 'Dark', 'Gruvbox', 'Gruvbox light', 'Obsidian', 'Halloween']) {
    // the status bar's theme menu (Settings has the same list)
    await page.getByTestId('status-theme').click();
    await page.getByRole('menu', { name: 'Themes' }).getByRole('menuitem', { name: mode, exact: true }).click();
    await expect(page.getByTestId('status-theme')).toHaveText(mode);
    await page.getByRole('tab', { name: 'Boards' }).click();
    await scan(`${mode} boards`);
    await page.getByTestId('board-Practice board 1').getByRole('button', { name: 'Open' }).click();
    await scan(`${mode} board page`);
    await page.getByRole('tab', { name: 'Your library' }).click();
    await page.getByRole('button', { name: NAME }).click();
    await expect(page.getByTestId('check')).toContainText(/Looks good|line/, { timeout: 10_000 });
    await scan(`${mode} library`);
    await page.getByRole('tab', { name: 'Settings' }).first().click();
    await scan(`${mode} settings`);
  }
  expect(problems).toEqual([]);
});

test('STOP: one board, and every board from the top bar', async () => {
  await page.getByRole('tab', { name: 'Boards' }).click();
  const card = page.getByTestId('board-Practice board 1');
  // start the effect, then stop it: everything off, triggers ignored
  await card.getByRole('button', { name: 'Open Practice board 1' }).click();
  // Restart on a running board asks first, naming it
  await page.getByRole('button', { name: 'Restart', exact: true }).click();
  await expect(page.getByRole('dialog').getByText('Restart Practice board 1?')).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const press = page.getByTestId('input-TRIG1').getByRole('button', { name: 'Press' });
  await press.scrollIntoViewIfNeeded(); const box = (await press.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down(); await page.waitForTimeout(300); await page.mouse.up();
  await expect(page.getByTestId('output-OUT1').getByTestId('level')).toHaveText(/^on/, { timeout: 5000 });
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.getByTestId('output-OUT1').getByTestId('level')).toHaveText(/^off/, { timeout: 5000 });
  await expect(page.getByText('Stopped: triggers are ignored until you resume or restart it')).toBeVisible();
  await expect(page.getByTestId('input-TRIG1').getByTestId('input-status')).toHaveText('Ignored: the board is stopped');
  await page.getByRole('button', { name: 'Restart', exact: true }).click();
  await expect(page.getByText('Stopped: triggers are ignored until you resume or restart it')).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByTestId('input-TRIG1').getByTestId('input-status')).toHaveText('Ready', { timeout: 15_000 });
  await page.getByRole('button', { name: 'Stop all boards' }).click();
  await page.getByRole('tab', { name: 'Boards' }).click();
  await expect(card.getByText('Stopped: triggers are ignored')).toBeVisible({ timeout: 5000 });
  // one message for every board stopped, and one button that starts them all again from the Boards page
  const msg = page.getByTestId('action-message');
  await expect(msg).toContainText(/stopped: everything is off and triggers are ignored/);
  await msg.getByRole('button', { name: /Start them all again|Restart it now/ }).click();
  await expect(page.getByTestId('action-message')).toContainText(/restarting/);
  await expect(card.getByText('Stopped: triggers are ignored')).toHaveCount(0, { timeout: 15_000 });
  // and it says when they are back (Wi-Fi bench 2026-10-22: "is restarting" stayed for minutes)
  await expect(page.getByTestId('action-message')).toContainText(/are back|is back/, { timeout: 15_000 });
});

test('STOP on locked boards: tried without the password, then one question for the boards that still want it', async () => {
  await page.getByRole('tab', { name: 'Boards' }).click();
  const before = await page.locator('[data-testid^="board-Practice board"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')));
  await page.getByRole('button', { name: 'Add a board' }).click().catch(() => {});
  await page.getByRole('button', { name: /Add a practice board/ }).click();
  await expect.poll(async () => (await page.locator('[data-testid^="board-Practice board"]').count()), { timeout: 15_000 }).toBe(before.length + 1);
  const added = (await page.locator('[data-testid^="board-Practice board"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')))).find((t) => !before.includes(t))!;
  const name = added.replace('board-', '');
  const key = await keyOf(name);
  await deviceLayer('rpc', { key, req: { op: 'set_params', values: [{ key: 'pin', value: 'stoplock9' }, { key: 'page_lock', value: true }] } });
  await expect.poll(async () => (await deviceLayer('rpc', { key, req: { op: 'info' } })).result.capabilities.includes('pin'), { timeout: 5000 }).toBe(true);
  await page.getByRole('button', { name: 'Stop all boards' }).click();
  // newer firmware stops without a password; the pinned one asks once, naming only the board Studio has no password for
  const dlg = page.getByRole('dialog');
  const msg = page.getByTestId('action-message');
  const asked = dlg.getByText(/^Page password for/);
  await expect(asked.or(msg.filter({ hasText: /stopped: everything is off/ }))).toBeVisible({ timeout: 10_000 });
  if (await asked.isVisible()) {
    await expect(asked).toHaveText(`Page password for ${name}`);
    await dlg.getByLabel('Page password').fill('stoplock9');
    await dlg.getByRole('button', { name: 'Unlock' }).click();
  }
  await expect(msg).toContainText(/stopped: everything is off and triggers are ignored/, { timeout: 10_000 });
  await expect(msg).not.toContainText('did not stop');
  await expect(page.getByTestId(added).getByText('Stopped: triggers are ignored')).toBeVisible({ timeout: 5000 });
  await msg.getByRole('button', { name: /Start them all again|Restart it now/ }).click();
  // a restart is a change: on newer firmware (stopping needed no password) this is where the locked board asks
  if (await asked.isVisible({ timeout: 3000 }).catch(() => false) || await asked.waitFor({ timeout: 3000 }).then(() => true).catch(() => false)) {
    await dlg.getByLabel('Page password').fill('stoplock9');
    await dlg.getByRole('button', { name: 'Unlock' }).click();
  }
  await expect(page.getByTestId(added).getByText('Stopped: triggers are ignored')).toHaveCount(0, { timeout: 15_000 });
  await page.getByTestId(added).getByRole('button', { name: 'Open' }).click();
  await page.getByRole('button', { name: 'Remove from Studio' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByTestId(added)).toHaveCount(0, { timeout: 10_000 });
});

test('share with others: a read-only page shows a board going offline and online', async ({ browser }) => {
  await page.getByRole('tab', { name: 'Settings' }).first().click();
  await page.getByLabel('Share with others').click();
  await expect(page.getByTestId('share-url')).toBeVisible({ timeout: 10_000 });
  const url = (await page.getByTestId('share-url').textContent())!;
  expect(url).toMatch(/^http:\/\/.+:\d+\/$/);
  const viewer = await (await browser.newContext()).newPage();
  await viewer.goto(url);
  const card = viewer.locator('section[data-board="Practice board 1"]');
  await expect(card.locator('.state')).toContainText('Online', { timeout: 10_000 });
  await expect(card).toContainText(`“${NAME}”`);
  await expect(viewer.getByRole('button')).toHaveCount(0); // nothing to press
  // unplug the practice board: the shared page says so, then plug it back in
  await page.getByRole('tab', { name: 'Boards' }).click();
  await page.getByTestId('board-Practice board 1').getByRole('button', { name: 'Open' }).click();
  await page.getByRole('button', { name: 'Unplug (practice)' }).click();
  await expect(card.locator('.state')).toContainText('Offline', { timeout: 15_000 });
  await page.getByRole('button', { name: 'Plug in again' }).click();
  await expect(card.locator('.state')).toContainText('Online', { timeout: 15_000 });
  // like a real board it kept its effect script while unplugged
  await expect(card).toContainText(`“${NAME}”`, { timeout: 10_000 });
  await expect(page.getByText(`“${NAME}”: `).first()).toBeVisible({ timeout: 10_000 });
  await viewer.close();
  await page.getByRole('tab', { name: 'Settings' }).first().click();
  await page.getByLabel('Share with others').click();
  await expect(page.getByTestId('share-url')).toHaveCount(0);
});

test('device adapters: a made-up lamp protocol appears and acts like a board', async () => {
  // Studio's MQTT server on a test port
  await page.getByLabel('Advanced mode').check();
  await page.getByRole('tab', { name: 'Settings' }).first().click();
  // (already running on that port when dashboard.spec.ts ran first: the server stays up until the device layer stops)
  if (!(await deviceLayer('mqtt_status'))) {
    await page.getByLabel('Port').fill(MQTT_PORT);
    await page.getByRole('button', { name: 'Start' }).click();
  }
  await expect(page.getByText(/Running: boards report to/)).toBeVisible({ timeout: 10_000 });
  await page.getByLabel('Advanced mode').uncheck();
  // a fake lamp on that server (through a second connection to the device layer)
  const ws = new WebSocket(`ws://127.0.0.1:${process.env.E2E_BRIDGE_PORT || '18792'}/?token=${process.env.SPECTER_BRIDGE_TOKEN}`);
  await new Promise((r) => ws.addEventListener('open', r));
  let id = 0;
  const callDl = (cmd: string, args: any) => ws.send(JSON.stringify({ id: ++id, cmd, args }));
  const lamp = { name: 'Hall lamp', on: false, brightness: 80, fw: '1.2.0' };
  const commands: any[] = [];
  ws.addEventListener('message', (m) => {
    const v = JSON.parse(String(m.data));
    if (v.event?.kind === 'mqtt' && v.event.topic === 'demolamp/hall/cmd') {
      const c = JSON.parse(v.event.payload);
      commands.push(c);
      Object.assign(lamp, 'on' in c ? { on: c.on } : {}, 'brightness' in c ? { brightness: c.brightness } : {});
      callDl('mqtt_publish', { topic: 'demolamp/hall/status', payload: JSON.stringify(lamp) });
    }
  });
  // the lamp's topics passed on to this connection whatever else is watched (the server forwards only watched
  // topics once anything watches: the adapter does, when the server was already up as Studio started)
  callDl('mqtt_watch', { filter: 'demolamp/#' });
  let alive = true;
  const beat = setInterval(() => { if (alive) callDl('mqtt_publish', { topic: 'demolamp/hall/status', payload: JSON.stringify(lamp) }); }, 500);
  try {
    await page.getByRole('tab', { name: 'Boards' }).click();
    const card = page.getByTestId('board-Hall lamp');
    await expect(card).toContainText('Connected', { timeout: 10_000 });
    await expect(card).toContainText('Demo lamp');
    await expect(card).toContainText('No effect scripts on this device');
    await card.getByRole('button', { name: 'Open Hall lamp' }).click();
    // live tile, held
    const tile = page.getByTestId('output-LAMP');
    const hold = tile.getByRole('button', { name: 'Hold to test' });
    await hold.scrollIntoViewIfNeeded(); const hb = (await hold.boundingBox())!;
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
    await page.mouse.down();
    await expect(tile.getByTestId('level')).not.toHaveText(/^off/, { timeout: 5000 });
    await page.mouse.up();
    await expect(tile.getByTestId('level')).toHaveText(/^off/, { timeout: 5000 });
    // a setting with readback
    await page.getByRole('tab', { name: 'Settings' }).last().click();
    await page.getByLabel('Brightness').fill('40');
    await page.getByRole('button', { name: 'Save settings' }).click();
    await expect(page.getByText('Saved.')).toBeVisible({ timeout: 5000 });
    expect(lamp.brightness).toBe(40);
    // an action from the device's own list (under More: board actions are rarely needed)
    await page.getByRole('button', { name: 'More', exact: true }).click();
    await page.getByRole('menuitem', { name: /^Blink/ }).click();
    await expect.poll(() => commands.some((c) => c.blink)).toBe(true);
    // the lamp goes quiet: offline within its stale time, and its controls are off
    alive = false;
    await expect(page.getByText(/Not answering/)).toBeVisible({ timeout: 6000 });
    await showLive(page);
    await expect(page.getByTestId('output-LAMP').getByRole('button', { name: 'Hold to test' })).toBeDisabled();
  } finally {
    clearInterval(beat);
    callDl('mqtt_unwatch', { filter: 'demolamp/#' });
    ws.close();
  }
});

test('plugin MQTT: the allowlist, retained copies, consent and the activity log', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${process.env.E2E_BRIDGE_PORT || '18792'}/?token=${process.env.SPECTER_BRIDGE_TOKEN}`);
  await new Promise((r) => ws.addEventListener('open', r));
  const pub = (topic: string, payload: string) => ws.send(JSON.stringify({ id: Math.random(), cmd: 'mqtt_publish', args: { topic, payload } }));
  try {
    await page.getByRole('tab', { name: 'MQTT probe (test)' }).click();
    const consent = page.getByRole('dialog', { name: /Allow “MQTT probe/ });
    await expect(consent).toContainText('Read messages on: probe/+/status');
    await expect(consent).toContainText('Make devices act (each one is logged): probe/+/fire');
    await consent.getByRole('button', { name: 'Allow' }).click();
    const f = page.frameLocator('iframe[title="MQTT probe (test)"]');
    const log = f.getByLabel('Probe log');
    // a status the server keeps (published retained by a device before the plugin subscribed) arrives flagged retained
    await retainedPublish(Number(MQTT_PORT), 'probe/a2/status', 'stored');
    await f.getByRole('button', { name: 'Subscribe', exact: true }).click();
    await expect(log).toContainText('subscribe: ok');
    await expect(log).toContainText('message probe/a2/status stored retained=true');
    pub('probe/a1/status', 'armed');
    await expect(log).toContainText('message probe/a1/status armed retained=false');
    await f.getByRole('button', { name: 'Subscribe outside' }).click();
    await expect(log).toContainText("subscribe outside: refused (other/# is not in this plugin's topics)");
    await f.getByRole('button', { name: 'Publish get' }).click();
    await expect(log).toContainText('get: ok');
    await f.getByRole('button', { name: 'Publish outside' }).click();
    await expect(log).toContainText("outside: refused (probe/a1/restart is not in this plugin's topics)");
    await f.getByRole('button', { name: 'Publish fire' }).click();
    await expect(log).toContainText('fire: ok');
    await page.getByLabel('Advanced mode').check();
    await page.getByRole('tab', { name: 'Activity' }).click();
    await expect(page.getByRole('list', { name: 'All activity' })).toContainText('MQTT probe (test): probe/a1/fire = 1');
    await page.getByLabel('Advanced mode').uncheck();
  } finally { ws.close(); }
});

/** A device publishing one retained message (MQTT 3.1.1 by hand: CONNECT, PUBLISH retain, DISCONNECT). */
async function retainedPublish(port: number, topic: string, payload: string) {
  const net = await import('node:net');
  const str = (t: string) => { const b = Buffer.from(t); return Buffer.concat([Buffer.from([b.length >> 8, b.length & 255]), b]); };
  const packet = (head: number, body: Buffer) => Buffer.concat([Buffer.from([head, body.length]), body]);
  const connect = packet(0x10, Buffer.concat([str('MQTT'), Buffer.from([4, 2, 0, 60]), str('e2e-device')]));
  const publish = packet(0x31, Buffer.concat([str(topic), Buffer.from(payload)]));
  await new Promise<void>((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1', () => s.write(connect));
    s.once('data', () => { s.write(publish); s.write(Buffer.from([0xe0, 0])); setTimeout(() => { s.end(); resolve(); }, 300); });
    s.on('error', reject);
  });
}
