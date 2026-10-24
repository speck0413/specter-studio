// Script sources and extensions from git, end to end against local bare repositories (file:// addresses): add a
// source in Settings, Back up everything, Get latest, a conflict that needs a git client, and an extension added,
// listed and removed. The bridge runs git with a made-up identity (tests/fixtures/gitconfig).
import { test, expect, Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { allowedPlugins } from './consent';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'specter-scripts-repo-'));
const ws = path.join(root, 'My Props');
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: path.resolve('tests/fixtures/gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const LOCAL = 'effect local:\n  wait for trig1\n  out1 = on\n  sleep 1\n  out1 = off\n';
const PORCH = 'effect porch:\n  wait for trig1\n  out1 = on\n  sleep 1\n  out1 = off\n';

/** A bare repository called `name` with `files` pushed from a work clone; its file:// address and the clone. */
function remote(name: string, files: Record<string, string>) {
  const bare = path.join(root, `${name}.git`);
  fs.mkdirSync(bare, { recursive: true });
  git(bare, 'init', '-q', '--bare', '-b', 'main');
  const url = `file://${bare}`;
  const work = path.join(root, `${name}-work`);
  git(root, 'clone', '-q', url, work);
  commit(work, files);
  return { bare, url, work };
}
function commit(work: string, files: Record<string, string>) {
  try { git(work, 'pull', '-q', '--ff-only', 'origin', 'main'); } catch { /* an empty repository */ }
  for (const [f, t] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(work, f)), { recursive: true }); fs.writeFileSync(path.join(work, f), t); }
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'from another computer');
  git(work, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
}

test.describe.configure({ mode: 'serial' });
let page: Page;
const scripts = remote('scripts', { 'effects/porch.txt': PORCH });

test.beforeAll(async ({ browser }) => {
  fs.mkdirSync(path.join(ws, 'effects'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'effects', 'local.txt'), LOCAL);
  const ctx = await browser.newContext({ baseURL: `http://localhost:${process.env.E2E_APP_PORT || '14232'}/`, viewport: { width: 1300, height: 900 } });
  const pluginConsent = await allowedPlugins();
  await ctx.addInitScript(([w, c]) => { if (!localStorage.getItem('specter-prefs')) localStorage.setItem('specter-prefs', JSON.stringify({ firstRunDone: true, workspace: w, pluginConsent: c, theme: 'light' })); }, [ws, pluginConsent] as const);
  page = await ctx.newPage();
  await page.goto('/');
});

test.afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const dialog = () => page.getByRole('dialog');

test('add a script source, back up everything, get latest', async () => {
  await page.getByTestId('activity-settings').click();
  const section = page.getByTestId('scripts-repo');
  await section.getByLabel('Repository').fill(scripts.url);
  await section.getByRole('button', { name: 'Connect' }).click();
  // the expanded address and the folder are shown before anything is cloned
  await expect(dialog()).toContainText(scripts.url);
  await expect(dialog()).toContainText(path.join('sources', 'scripts'));
  await dialog().getByRole('button', { name: 'Add' }).click();
  // the library's own script can be copied in (never moved)
  await expect(dialog()).toContainText('Copy your 1 script into “scripts”?');
  await dialog().getByRole('button', { name: 'Copy them' }).click();
  await expect(page.getByTestId('source-status-scripts')).toContainText('1 change not backed up');
  expect(fs.existsSync(path.join(ws, 'effects', 'local.txt'))).toBe(true);
  await expect(page.getByTestId('status-scripts-repo')).toContainText('Scripts:');

  await section.getByRole('button', { name: 'Back up everything' }).click();
  await expect(section.getByRole('alert')).toContainText('Backed up');
  await expect(page.getByTestId('source-status-scripts')).toContainText('everything backed up');
  expect(git(scripts.bare, 'show', 'main:effects/local.txt') + '\n').toBe(LOCAL);
  expect(git(scripts.bare, 'log', '-1', '--format=%s', 'main')).toBe('Studio backup: 1 script changed');

  // another computer adds a script; Get latest in Your library brings it in, grouped under its source
  commit(scripts.work, { 'effects/from elsewhere.txt': PORCH.replace('porch', 'elsewhere') });
  await page.getByTestId('activity-library').click();
  await page.getByTestId('side-bar').getByTestId('scripts-repo-buttons').getByRole('button', { name: 'Get latest' }).click();
  const group = page.getByTestId('source-group-scripts');
  await expect(group).toContainText('from elsewhere');
  await expect(group).toContainText('porch');
  // the palette has the two commands
  await page.keyboard.press('ControlOrMeta+Shift+P');
  await page.keyboard.insertText('back up everything scripts');
  await expect(page.getByRole('option', { name: /Back up everything \(scripts\)/ })).toBeVisible();
  await page.keyboard.press('Escape');
});

test('a conflict stops with one plain message and the folder as it was', async () => {
  commit(scripts.work, { 'effects/porch.txt': PORCH.replace('sleep 1', 'sleep 3') });
  const mine = PORCH.replace('sleep 1', 'sleep 2');
  fs.writeFileSync(path.join(ws, 'sources', 'scripts', 'effects', 'porch.txt'), mine);
  await page.getByTestId('activity-settings').click();
  await page.getByTestId('scripts-repo').getByRole('button', { name: 'Back up everything' }).click();
  const msg = page.getByTestId('scripts-repo-message');
  await expect(msg).toContainText('Your scripts folder needs a git client to sort this out');
  await expect(msg).toContainText(`Folder: ${path.join(ws, 'sources', 'scripts')}`);
  await expect(dialog().getByRole('button', { name: 'Open folder' })).toBeVisible();
  await dialog().getByRole('button', { name: 'Open folder' }).click(); // SPECTER_NO_OPEN: nothing opens in tests
  await dialog().getByRole('button', { name: 'OK' }).click();
  expect(fs.readFileSync(path.join(ws, 'sources', 'scripts', 'effects', 'porch.txt'), 'utf8')).toBe(mine);
  expect(fs.existsSync(path.join(ws, 'sources', 'scripts', '.git', 'rebase-merge'))).toBe(false);
});

test('removing a source: changes not backed up keep it until "delete anyway" is ticked', async () => {
  await page.getByTestId('activity-settings').click();
  await page.getByTestId('source-scripts').getByRole('button', { name: 'Remove…' }).click();
  await expect(dialog()).toContainText('not backed up');
  await expect(dialog().getByRole('button', { name: 'Remove' })).toBeDisabled();
  await dialog().getByLabel('Delete anyway (those changes are lost)').check();
  await dialog().getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByTestId('source-scripts')).toHaveCount(0);
  expect(fs.existsSync(path.join(ws, 'sources', 'scripts'))).toBe(false);
  expect(fs.existsSync(path.join(ws, 'effects', 'local.txt'))).toBe(true);
});

test('an extension from git: added, listed with its source and commit, removed', async () => {
  const ext = remote('demo-glow', { 'studio-plugin/plugin.json': JSON.stringify({ id: 'demo-glow', name: 'Demo glow', entry: 'index.html' }), 'studio-plugin/index.html': '<p>demo</p>', 'README.md': 'demo' });
  await page.getByTestId('activity-settings').click();
  const section = page.getByTestId('git-extensions');
  await section.getByLabel('Extension repository').fill(ext.url);
  await section.getByRole('button', { name: 'Add' }).click();
  await expect(dialog()).toContainText(ext.url);
  await dialog().getByRole('button', { name: 'Add' }).click();
  await expect(page.getByTestId('extensions-message')).toContainText('Added “Demo glow”');
  const row = page.getByTestId('extension-demo-glow');
  await expect(row).toContainText(`From ${ext.url} (folder studio-plugin)`);
  await expect(row).toContainText(`at ${git(ext.work, 'rev-parse', '--short', 'HEAD')}`);
  await expect(page.getByTestId('activity-plugin:demo-glow')).toBeVisible();
  await section.getByRole('button', { name: 'Check all for updates' }).click();
  await expect(page.getByTestId('extensions-message')).toContainText('Every extension is up to date');
  await row.getByRole('button', { name: 'Remove…' }).click();
  await dialog().getByRole('button', { name: 'Remove' }).click();
  await expect(row).toHaveCount(0);
  await expect(page.getByTestId('activity-plugin:demo-glow')).toHaveCount(0);
});
