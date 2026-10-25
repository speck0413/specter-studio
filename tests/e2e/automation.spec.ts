// Automation: a "When a message arrives, send a web request" rule is made in Settings, tested with a sample
// message (and sent once), saved, and fires when a message arrives on Studio's MQTT server, into a web server on
// this computer. Also the ready-made examples. Nothing here leaves this computer.
import { test, expect, Page } from '@playwright/test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { allowedPlugins } from './consent';

// the device layer's MQTT server cannot be stopped: the same port as the other specs (E2E_MQTT_PORT)
const MQTT_PORT = Number(process.env.E2E_MQTT_PORT || '18834');

test.describe.configure({ mode: 'serial' });
let page: Page;
let bridge: WebSocket;
let nextId = 0;
const waiting = new Map<number, (v: any) => void>();
let web: http.Server;
let webPort = 0;
const received: { url: string; type: string; body: string }[] = [];
// answers 500 to this many requests (a server error after the row may have been added)
let failNext = 0;

function dl(cmd: string, args: any = {}): Promise<any> {
  const id = ++nextId;
  return new Promise((ok, fail) => {
    waiting.set(id, (v) => (v.ok ? ok(v.result) : fail(new Error(v.error))));
    bridge.send(JSON.stringify({ id, cmd, args }));
  });
}

test.beforeAll(async ({ browser }) => {
  // a web server on this computer standing in for a spreadsheet's web app
  web = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      received.push({ url: req.url || '', type: String(req.headers['content-type'] || ''), body });
      if (failNext > 0) { failNext -= 1; res.statusCode = 500; res.end('Internal'); } else res.end('ok');
    });
  });
  await new Promise<void>((r) => web.listen(0, '127.0.0.1', () => r()));
  webPort = (web.address() as AddressInfo).port;
  bridge = new WebSocket(`ws://127.0.0.1:${process.env.E2E_BRIDGE_PORT || '18792'}/?token=${process.env.SPECTER_BRIDGE_TOKEN}`);
  await new Promise((r) => bridge.addEventListener('open', r));
  bridge.addEventListener('message', (m) => { const v = JSON.parse(String(m.data)); if (v.id && waiting.has(v.id)) { waiting.get(v.id)!(v); waiting.delete(v.id); } });
  if (!(await dl('mqtt_status'))) await dl('mqtt_start', { port: MQTT_PORT });
  const ctx = await browser.newContext({ baseURL: `http://localhost:${process.env.E2E_APP_PORT || '14232'}/`, viewport: { width: 1300, height: 900 } });
  // the example extensions are agreed to already (their consent screens are tested in studio.spec.ts)
  const pluginConsent = await allowedPlugins();
  await ctx.addInitScript((c) => localStorage.setItem('specter-prefs', JSON.stringify({ firstRunDone: true, pluginConsent: c })), pluginConsent);
  page = await ctx.newPage();
  await page.goto('/');
  await page.getByRole('tab', { name: 'Settings' }).first().click();
  await expect(page.getByTestId('automation')).toBeVisible();
});

test.afterAll(async () => {
  // this file's Studio page goes too: a page left open keeps talking to the shared device layer (and loading the
  // browser) through every later file
  await page?.context().close();
  // the rules live in the device layer, which the later specs share: leave none behind
  await dl('automation_set', { rules: [] }).catch(() => {});
  bridge.close();
  web.close();
});

test('a rule is made, tested, sent once, and fires on a message', async () => {
  const section = page.getByTestId('automation');
  await section.getByRole('button', { name: 'New rule' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name', { exact: true }).fill('Check-in complete');
  await expect(dialog.getByLabel('When a message arrives on')).toHaveValue('checkin/*/{roomName}/complete');
  await dialog.getByLabel('Web request to (address)').fill(`http://127.0.0.1:${webPort}/log?room={roomName}`);
  await expect(dialog.getByTestId('rule-check')).toContainText('Listens on checkin/+/+/complete; keeps {roomName}.');
  await expect(dialog.getByText(/starts with http:\/\/, so the request crosses the network unencrypted/)).toBeVisible();

  // a mistake is caught while typing, in plain words
  await dialog.getByLabel('What to send').fill('{room},complete,{timestamp}');
  await expect(dialog.getByTestId('rule-check')).toContainText('{room} is not in the topic pattern');
  await expect(dialog.getByRole('button', { name: 'Save' })).toBeDisabled();
  await dialog.getByLabel('What to send').fill('{roomName},complete,{timestamp}');
  await expect(dialog.getByTestId('rule-check')).toContainText('Listens on');

  // "Test this rule": the matched values and the exact request; nothing is sent
  await expect(dialog.getByLabel('Sample topic')).toHaveValue('checkin/desk/library/complete');
  await dialog.getByRole('button', { name: 'Test', exact: true }).click();
  const result = dialog.getByTestId('rule-test');
  await expect(result).toContainText('Matched: roomName = library');
  await expect(result).toContainText(`POST http://127.0.0.1:${webPort}/log?room=library`);
  await expect(result).toContainText('Content-Type: text/csv');
  await expect(result).toContainText(/library,complete,\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d/);
  expect(received).toHaveLength(0);
  // then once for real
  await dialog.getByRole('button', { name: 'Send it once' }).click();
  await expect(result).toContainText('Sent: sent (200)');
  expect(received).toHaveLength(1);
  expect(received[0]).toMatchObject({ url: '/log?room=library', type: 'text/csv; charset=utf-8' });

  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const card = section.getByTestId('rule-Check-in complete');
  await expect(card).toContainText(`When a message arrives on checkin/*/{roomName}/complete, send a POST request to 127.0.0.1:${webPort}.`);

  // a message arrives on Studio's MQTT server: the rule sends its request
  await dl('mqtt_publish', { topic: 'checkin/front/attic/complete', payload: 'done' });
  await expect.poll(() => received.length, { timeout: 10_000 }).toBe(2);
  expect(received[1].url).toBe('/log?room=attic');
  expect(received[1].body).toMatch(/^attic,complete,\d{4}-/);
  // other topics do not
  await dl('mqtt_publish', { topic: 'checkin/front/attic/start', payload: '' });
  await expect(card).toContainText('Sent 1', { timeout: 10_000 });
  await card.getByRole('button', { name: 'Activity' }).click();
  await expect(card.getByTestId('rule-log')).toContainText('sent (200)');
  expect(received).toHaveLength(2);

  // switched off, it stays quiet
  await card.getByLabel('Check-in complete on').click();
  await expect(card.getByLabel('Check-in complete on')).not.toBeChecked();
  await dl('mqtt_publish', { topic: 'checkin/front/attic/complete', payload: '' });
  await page.waitForTimeout(1000);
  expect(received).toHaveLength(2);
});

test('the ready-made examples add a start and a finish rule, switched off', async () => {
  const section = page.getByTestId('automation');
  await section.getByRole('button', { name: 'New from example' }).click();
  await page.getByRole('menuitem', { name: /Maze: many people inside at once/ }).click();
  await expect(section.getByText(/Added “Maze: many people inside at once” \(2 rules, switched off\)/)).toBeVisible();
  const enter = section.getByTestId('rule-Maze: people enter');
  await expect(enter).toContainText('When a message arrives on checkin/*/{roomName}/start');
  await expect(enter).toContainText('Counts up inside for each roomName');
  await expect(enter.getByLabel('Maze: people enter on')).not.toBeChecked();
  // try it: the count goes into the line
  await enter.getByRole('button', { name: 'Edit and test' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Sample topic').fill('checkin/gate/maze/start');
  await dialog.getByLabel('Sample message').fill('{"people": 3}');
  await dialog.getByRole('button', { name: 'Test', exact: true }).click();
  await expect(dialog.getByTestId('rule-test')).toContainText(/maze,entered,\d{4}-[^,]+,3/);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  // export leaves secrets out and lists the rules
  await section.getByRole('button', { name: 'Export rules' }).click();
  await expect(page.getByRole('dialog').getByLabel('Rules as text')).toHaveValue(/"Maze: people leave"/);
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();
});

test('a server error is marked "may have been sent" and Send again repeats it with the same event id', async () => {
  const section = page.getByTestId('automation');
  await section.getByRole('button', { name: 'New rule' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name', { exact: true }).fill('Desk log');
  await dialog.getByLabel('When a message arrives on').fill('desk/{roomName}/done');
  await dialog.getByLabel('Web request to (address)').fill(`http://127.0.0.1:${webPort}/desk`);
  await dialog.getByLabel('What to send').fill('{event_id},{roomName}');
  await expect(dialog.getByTestId('rule-check')).toContainText('Listens on desk/+/done');
  await dialog.getByRole('button', { name: 'Save' }).click();
  const card = section.getByTestId('rule-Desk log');
  await expect(card).toBeVisible();

  const before = received.length;
  failNext = 1;
  await dl('mqtt_publish', { topic: 'desk/library/done', payload: '' });
  await expect.poll(() => received.length, { timeout: 10_000 }).toBe(before + 1);
  const first = received[before];
  expect(first.url).toBe('/desk');
  expect(first.body).toMatch(/^[0-9a-f]{16},library$/);
  await expect(card).toContainText('1 may have been sent (check the sheet)', { timeout: 10_000 });
  // not tried again by itself
  await page.waitForTimeout(3000);
  expect(received).toHaveLength(before + 1);
  await card.getByRole('button', { name: 'Activity' }).click();
  const log = card.getByTestId('rule-log');
  await expect(log).toContainText('may have been sent: check the sheet (the server answered 500: Internal)');
  await log.getByRole('button', { name: 'Send again' }).click();
  await expect.poll(() => received.length, { timeout: 10_000 }).toBe(before + 2);
  expect(received[before + 1].body).toBe(first.body);
  await expect(log).toContainText('sent (200)');
  await expect(log).toContainText('(sent again)');
  await expect(log.getByRole('button', { name: 'Send again' })).toHaveCount(0);
});
