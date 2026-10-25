// Shows on the board: the list, the example show, links, the editor's "while held", delete / replace with a
// question first, and recording on the board ("Record over" / "Add to it", only on firmware that still has the
// board's own recorder: the `record` capability, gone since 0.1.0-rc.1 where Record effect replaces it). Runs
// against whatever simulator the bridge has, older or newer firmware. The tests check that an older board is
// told, never silently given something else.
import { test, expect, Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { allowedPlugins } from './consent';

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'specter-shows-'));
const BOARD = 'Shows board';

test.describe.configure({ mode: 'serial' });
let page: Page;
let bridge: WebSocket;
let key = '';
let newFw = false; // the board keeps until_release (and so has add_example and record add)
let hasRecord = false; // the board's own recorder (record_* ops)
let nextId = 0;
const waiting = new Map<number, (v: any) => void>();

function dl(cmd: string, args: any = {}): Promise<any> {
  const id = ++nextId;
  return new Promise((ok, fail) => {
    waiting.set(id, (v) => (v.ok ? ok(v.result) : fail(new Error(v.error))));
    bridge.send(JSON.stringify({ id, cmd, args }));
  });
}
const board = async (req: any) => (await dl('rpc', { key, req })).result;
const showNamed = async (name: string) => {
  const s = ((await board({ op: 'list_shows' })).shows || []).find((x: any) => x.name === name);
  return s ? (await board({ op: 'get_show', show: s.id })).data : null;
};
const panel = () => page.getByTestId('shows-panel');
const message = () => page.getByTestId('shows-message');

test.beforeAll(async ({ browser }) => {
  bridge = new WebSocket(`ws://127.0.0.1:${process.env.E2E_BRIDGE_PORT || '18792'}/?token=${process.env.SPECTER_BRIDGE_TOKEN}`);
  await new Promise((r) => bridge.addEventListener('open', r));
  bridge.addEventListener('message', (m) => { const v = JSON.parse(String(m.data)); if (v.id && waiting.has(v.id)) { waiting.get(v.id)!(v); waiting.delete(v.id); } });
  key = (await dl('sim_start', { name: BOARD })).key;
  // feature probe: does this firmware keep until_release? (a disabled show at a free id, removed again)
  const ids = ((await board({ op: 'list_shows' })).shows || []).map((s: any) => s.id);
  const probe = Math.max(0, ...ids) + 10;
  await board({ op: 'put_show', data: { id: probe, name: 'probe', enabled: false, triggers: [{ on: 'input', input: 'TRIG1', until_release: true }], tracks: [{ target: 'OUT1', cues: [{ at: 0, do: 'on' }] }], length_ms: 1000 } });
  newFw = (await board({ op: 'get_show', show: probe })).data?.triggers?.[0]?.until_release === true;
  await board({ op: 'delete_show', show: probe });
  hasRecord = ((await board({ op: 'info' })).capabilities || []).includes('record');
  const ctx = await browser.newContext({ baseURL: `http://localhost:${process.env.E2E_APP_PORT || '14232'}/`, viewport: { width: 1300, height: 900 } });
  const pluginConsent = await allowedPlugins();
  await ctx.addInitScript(([w, c]) => localStorage.setItem('specter-prefs', JSON.stringify({ firstRunDone: true, workspace: w, pluginConsent: c })), [ws, pluginConsent] as const);
  page = await ctx.newPage();
  await page.goto('/');
  await page.getByTestId(`board-${BOARD}`).getByRole('button', { name: 'Open' }).click();
  await page.getByRole('tab', { name: 'Effect script' }).click();
});

test.afterAll(async () => {
  // this file's Studio page goes too: a page left open keeps talking to the shared device layer (and loading the
  // browser) through every later file
  await page?.context().close();
  await dl('disconnect', { key }).catch(() => {}); // the practice board goes (the other specs count boards)
  bridge.close();
  fs.rmSync(ws, { recursive: true, force: true });
});

test('the board\'s shows are listed, and never assumed to include show 1', async () => {
  await expect(panel()).toContainText('Shows on the board');
  if (newFw) await expect(panel()).toContainText('This board has no shows');
  else await expect(page.getByTestId('show-1')).toContainText('Example: door knock · starts on TRIG1');
});

test('Add an example show: added on newer firmware, the button goes away on older', async () => {
  await panel().getByRole('button', { name: 'Add an example show' }).click();
  if (newFw) {
    await expect(message()).toContainText('Added “Example show: door knock”: press TRIG1 to try it.');
    await expect(page.getByTestId('show-1')).toContainText('Example show: door knock');
  } else {
    await expect(message()).toContainText('firmware has no example show to add', { timeout: 20_000 }); // an older board's answer has no id: Studio waits for it
    await expect(panel().getByRole('button', { name: 'Add an example show' })).toHaveCount(0);
  }
});

// bench run 2026-10-22: no Run button and no Resume after Stop (the board's refusal says "press Resume")
test('Run a show from Studio; after Stop it is refused until Resume, then runs again', async () => {
  const first = ((await board({ op: 'list_shows' })).shows || [])[0];
  expect(first, 'a show from the step before').toBeTruthy();
  const row = page.getByTestId(`show-${first.id}`);
  await row.getByRole('button', { name: `Run ${first.name}` }).click();
  await expect(message()).toHaveText(`Started “${first.name}”.`);
  await expect(page.getByRole('tab', { name: 'Activity' })).toBeVisible();
  // STOP (unchanged: pause on + stop_all): Run is refused in the board's words, pointing at Resume
  await page.getByRole('button', { name: 'Stop', exact: true }).first().click();
  await expect(page.getByText('Stopped: triggers are ignored until you resume or restart it')).toBeVisible();
  await expect(page.getByTestId('paused-help')).toHaveText('Resume lets the shows start again (nothing turns back on by itself).');
  const msg = page.getByTestId('action-message');
  await expect(msg.getByRole('button', { name: 'Resume' })).toBeVisible();
  await expect(msg.getByRole('button', { name: 'Restart it now' })).toBeVisible();
  await row.getByRole('button', { name: `Run ${first.name}` }).click();
  await expect(message()).toContainText(`“${first.name}” did not start:`);
  await expect(message()).toContainText('Resume');
  // Resume: nothing turns back on, the chip goes, Run works again
  await page.getByRole('button', { name: 'Resume', exact: true }).first().click();
  await expect(page.getByText('Stopped: triggers are ignored until you resume or restart it')).toHaveCount(0, { timeout: 5000 });
  await expect(msg).toContainText('running again: shows start on their triggers. Nothing turned back on by itself.');
  expect((await board({ op: 'state' })).paused).toBe(false);
  await row.getByRole('button', { name: `Run ${first.name}` }).click();
  await expect(message()).toHaveText(`Started “${first.name}”.`);
});

test('a link: on for N seconds when pressed, and replacing one asks first', async () => {
  await panel().getByRole('button', { name: 'Link an input to outputs…' }).click();
  const d = page.getByRole('dialog', { name: 'Link an input to outputs' });
  await d.getByLabel('On for a few seconds when pressed').check();
  await d.getByLabel('For (seconds)').fill('2');
  await d.getByRole('button', { name: 'Make the link' }).click();
  await expect(message()).toContainText('Link: TRIG1 -> OUT1: each press of TRIG1 turns OUT1 on for 2 s.');
  const data = await showNamed('Link: TRIG1 -> OUT1');
  expect(data.id).toBe(2); // the lowest free id
  expect(data.triggers).toEqual([{ on: 'input', input: 'TRIG1' }]);
  expect(data.tracks).toEqual([{ target: 'OUT1', cues: [{ at: 0, do: 'pulse', ms: 2000 }] }]);
  // the same link again: a question, then it takes the old one's place
  await panel().getByRole('button', { name: 'Link an input to outputs…' }).click();
  await d.getByLabel('On for a few seconds when pressed').check();
  await d.getByLabel('For (seconds)').fill('3');
  await d.getByRole('button', { name: 'Make the link' }).click();
  const q = page.getByRole('dialog', { name: `Replace the show “Link: TRIG1 -> OUT1” on ${BOARD}?` });
  await q.getByRole('button', { name: 'Replace' }).click();
  await expect(message()).toContainText('for 3 s');
  const again = await showNamed('Link: TRIG1 -> OUT1');
  expect(again.id).toBe(2);
  expect(again.tracks[0].cues[0].ms).toBe(3000);
});

test('a link on while held: works on newer firmware, refused and explained on older', async () => {
  await panel().getByRole('button', { name: 'Link an input to outputs…' }).click();
  const d = page.getByRole('dialog', { name: 'Link an input to outputs' });
  await d.getByLabel('OUT1').uncheck();
  await d.getByLabel('OUT2').check();
  await d.getByLabel('At most (seconds)').fill('30');
  await d.getByRole('button', { name: 'Make the link' }).click();
  if (!newFw) {
    await expect(message()).toContainText('too old for “on only while held”');
    expect(await showNamed('Link: TRIG1 -> OUT2')).toBeNull();
    return;
  }
  await expect(message()).toContainText('OUT2 is on while TRIG1 is held (at most 30 s)');
  const data = await showNamed('Link: TRIG1 -> OUT2');
  expect(data).toMatchObject({ enabled: true, length_ms: 30000, triggers: [{ on: 'input', input: 'TRIG1', until_release: true }] });
  await board({ op: 'sim_input', input: 'TRIG1', active: true });
  await expect.poll(async () => (await board({ op: 'state' })).outputs.find((o: any) => o.channel === 'OUT2').level, { timeout: 5000 }).toBeGreaterThan(0);
  await board({ op: 'sim_input', input: 'TRIG1', active: false });
  await expect.poll(async () => (await board({ op: 'state' })).outputs.find((o: any) => o.channel === 'OUT2').level, { timeout: 5000 }).toBe(0);
});

test('the editor: "on only while held" round-trips, everything else goes back unchanged', async () => {
  const before = await showNamed('Link: TRIG1 -> OUT1');
  await page.getByTestId('show-2').getByRole('button', { name: 'Edit…' }).click();
  const d = page.getByRole('dialog', { name: 'Edit the show “Link: TRIG1 -> OUT1”' });
  await d.getByLabel('TRIG1: on only while held (stops when let go)').check();
  await d.getByRole('button', { name: 'Save' }).click();
  await page.getByRole('dialog', { name: /Change the show/ }).getByRole('button', { name: 'Change it' }).click();
  if (!newFw) {
    // this test's own answer (the one before said "too old" too): the show is back as it was
    await expect(message()).toContainText('too old for “on only while held”: it would keep the outputs on after you let go. Update its firmware, or use “on for a few seconds when pressed”. “Link: TRIG1 -> OUT1” is unchanged.');
    expect(await showNamed('Link: TRIG1 -> OUT1')).toEqual(before);
    return;
  }
  await expect(message()).toContainText('Changed “Link: TRIG1 -> OUT1”.');
  await expect(page.getByTestId('show-2')).toContainText('while held');
  const held = await showNamed('Link: TRIG1 -> OUT1');
  expect(held).toEqual({ ...before, triggers: [{ on: 'input', input: 'TRIG1', until_release: true }] });
  // off again: the key is left out, as the board writes it
  await page.getByTestId('show-2').getByRole('button', { name: 'Edit…' }).click();
  await d.getByLabel('TRIG1: on only while held (stops when let go)').uncheck();
  await d.getByRole('button', { name: 'Save' }).click();
  await page.getByRole('dialog', { name: /Change the show/ }).getByRole('button', { name: 'Change it' }).click();
  await expect(message()).toContainText('Changed');
  expect(await showNamed('Link: TRIG1 -> OUT1')).toEqual(before);
});

test('recording on the board: Record over, and Add to it only where the board can add', async () => {
  const showId = 2;
  if (!hasRecord) {
    // no recorder on the board: no Record button (Record effect on the board page makes effects instead)
    await expect(page.getByTestId(`show-${showId}`)).toBeVisible();
    await expect(panel().getByRole('button', { name: /^Record/ })).toHaveCount(0);
    return;
  }
  await page.getByTestId(`show-${showId}`).getByRole('button', { name: 'Record…' }).click();
  const d = page.getByRole('dialog', { name: `Record on ${BOARD}` });
  await d.getByRole('button', { name: 'Add to it' }).click();
  if (!newFw) {
    await expect(d.getByTestId('record-problem')).toContainText('cannot add to a track yet');
    expect((await board({ op: 'state' })).recording ?? null).toBeNull();
  } else {
    await expect(d.getByTestId('recording-state')).toContainText('(adding to it)');
    await d.getByRole('button', { name: 'Cancel' }).click();
    await expect(message()).toContainText('Recording cancelled');
    await expect.poll(async () => (await board({ op: 'state' })).recording ?? null).toBeNull();
    await page.getByTestId(`show-${showId}`).getByRole('button', { name: 'Record…' }).click();
  }
  await d.getByRole('button', { name: 'Record over' }).click();
  await expect(d.getByTestId('recording-state')).toContainText('Recording OUT1 (recording over)');
  const tap = d.getByRole('button', { name: 'Tap (hold = on)' });
  const box = (await tap.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(400);
  await page.mouse.up();
  await expect(d.getByTestId('recording-state')).toContainText(/[1-9]\d* cues/, { timeout: 5000 });
  await d.getByRole('button', { name: 'Finish' }).click();
  await expect(message()).toContainText('Saved the show');
  const data = await showNamed('Link: TRIG1 -> OUT1');
  expect(data.tracks.find((t: any) => t.target === 'OUT1').cues.length).toBeGreaterThan(0);
});

test('delete asks first, naming the show and the board', async () => {
  await page.getByTestId('show-2').getByRole('button', { name: 'Delete' }).click();
  const q = page.getByRole('dialog', { name: `Delete the show “Link: TRIG1 -> OUT1” from ${BOARD}?` });
  await q.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByTestId('show-2')).toBeVisible();
  await page.getByTestId('show-2').getByRole('button', { name: 'Delete' }).click();
  await q.getByRole('button', { name: 'Delete' }).click();
  await expect(message()).toContainText('Deleted “Link: TRIG1 -> OUT1”.');
  await expect(page.getByTestId('show-2')).toHaveCount(0);
  expect(await showNamed('Link: TRIG1 -> OUT1')).toBeNull();
});

// bench run 2026-10-22: an unwired input that floats "pressed" was offered for Record effect without a word
test('Record effect warns when the chosen trigger reads pressed right now', async () => {
  await board({ op: 'sim_input', input: 'TRIG1', active: true });
  try {
    await expect.poll(async () => (await board({ op: 'state' })).inputs.find((i: any) => i.input === 'TRIG1')?.active, { timeout: 5000 }).toBe(true);
    const live = page.getByRole('tab', { name: 'Live' }); // narrow windows only; wide ones show the tiles beside
    if (await live.count()) await live.click();
    await expect(page.getByTestId('input-TRIG1')).toContainText('pressed', { timeout: 5000 }); // Studio has seen it
    await page.getByRole('button', { name: 'Make it do something…' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Record effect' }).click();
    const rec = page.getByTestId('record-effect');
    await expect(rec).toBeVisible();
    // the first input that is free and let go is picked; choosing the held one says why it would not start
    await expect(rec.getByTestId('record-trigger-held')).toHaveCount(0);
    await rec.getByLabel('What starts it').click();
    await page.getByRole('option', { name: /TRIG1.*reads pressed right now/ }).click();
    await expect(rec.getByTestId('record-trigger-held')).toContainText('TRIG1 reads “pressed” right now. If nothing is wired to it, it can float like this');
    await rec.getByRole('button', { name: 'Cancel' }).click();
  } finally {
    await board({ op: 'sim_input', input: 'TRIG1', active: false });
  }
});
