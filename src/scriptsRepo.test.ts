import { afterEach, describe, expect, it } from 'vitest';
import {
  applyAnswer, asksDestination, changesText, chooseCopyDestination, chooseDestination, defaultDestination, destinations, EMPTY, lastBackupText,
  qualify, setDestinationChooser, setRepoState, SourceStatus, sourceLine, sourceOf, statusLine, titleOf,
} from './scriptsRepo';
import { folderIn } from './components/ScriptsRepo';

const at = (y: number, m: number, d: number, h: number, mi: number) => new Date(y, m - 1, d, h, mi);
const secs = (d: Date) => Math.floor(d.getTime() / 1000);
const now = at(2026, 10, 24, 15, 0);
const mine: SourceStatus = { id: 'my-scripts', repo: 'you/my-scripts', connected: true, changes: 2, last_backup: secs(at(2026, 10, 24, 14, 2)) };
const team: SourceStatus = { id: 'scripts', repo: 'our-team/scripts', connected: true, changes: 1, last_backup: secs(at(2026, 10, 23, 9, 5)) };
const friend: SourceStatus = { id: 'specterscripts', repo: 'friend/specterscripts', connected: true, read_only: true, changes: 4 };

afterEach(() => { setDestinationChooser(null); setRepoState(() => EMPTY); });

describe('script source status', () => {
  it('says when the last backup was, in local time', () => {
    expect(lastBackupText(null, now)).toBe('never');
    expect(lastBackupText(secs(at(2026, 10, 24, 14, 2)), now)).toBe('today 14:02');
    expect(lastBackupText(secs(at(2026, 10, 23, 9, 5)), now)).toBe('yesterday 09:05');
    expect(lastBackupText(secs(at(2026, 10, 1, 9, 5)), now)).toBe('2026-10-01 09:05');
  });

  it('counts changes not backed up', () => {
    expect(changesText(0)).toBe('everything backed up');
    expect(changesText(1)).toBe('1 change not backed up');
    expect(changesText(3)).toBe('3 changes not backed up');
  });

  it('one source: its name, last backup and changes; read-only says so', () => {
    expect(statusLine([mine], now)).toBe('you/my-scripts · backed up today 14:02 · 2 changes not backed up');
    expect(sourceLine(friend, now)).toBe('friend/specterscripts · read-only (Get latest only)');
    expect(sourceLine({ ...mine, problem: { kind: 'git_client', reason: 'detached HEAD' } })).toBe('you/my-scripts: needs attention');
    expect(statusLine([])).toBe('');
  });

  it('several sources: the newest backup and the changes of the writable ones together', () => {
    expect(statusLine([mine, team, friend], now)).toBe('3 sources · backed up today 14:02 · 3 changes not backed up');
    expect(statusLine([mine, { ...team, problem: { kind: 'offline', reason: 'x' } }], now)).toBe('2 sources: one needs attention');
  });
});

describe('where a new script goes', () => {
  it('the marked source, else the only writable one, else the library itself', () => {
    expect(defaultDestination([], {})).toBe('');
    expect(defaultDestination([mine, friend], {})).toBe('my-scripts');
    expect(defaultDestination([mine, team], {})).toBe('');
    expect(defaultDestination([mine, team], { saveNew: 'scripts' })).toBe('scripts');
    // a marked source that turned read-only is not used
    expect(defaultDestination([mine, { ...team, read_only: true }], { saveNew: 'scripts' })).toBe('my-scripts');
  });

  it('asks only with two or more writable sources; read-only sources are never offered', () => {
    expect(asksDestination([mine, friend])).toBe(false);
    expect(asksDestination([mine, team, friend])).toBe(true);
    expect(destinations([mine, team, friend]).map((d) => d.id)).toEqual(['my-scripts', 'scripts', '']);
    expect(destinations([mine, team], 'my-scripts').map((d) => d.id)).toEqual(['scripts', '']);
  });

  it('chooseDestination: no question with one writable source, the person picks with two, closing keeps the default', async () => {
    const asked: string[] = [];
    setRepoState((s) => ({ ...s, sources: [mine, friend] }));
    setDestinationChooser(async (title) => { asked.push(title); return 'scripts'; }, { saveNew: 'my-scripts' });
    expect(await chooseDestination('porch')).toBe('my-scripts');
    expect(asked).toEqual([]);
    setRepoState((s) => ({ ...s, sources: [mine, team, friend] }));
    expect(await chooseDestination('porch')).toBe('scripts');
    expect(asked).toEqual(['Where should “porch” be saved?']);
    // scripts Studio keeps by itself never ask
    expect(await chooseDestination('kept from porch', false)).toBe('my-scripts');
    setDestinationChooser(async () => null, { saveNew: 'my-scripts' });
    expect(await chooseDestination('porch')).toBe('my-scripts');
  });

  it('Save a copy to… offers your own sources and the library, not the script\'s own source', async () => {
    let offered: string[] = [];
    setRepoState((s) => ({ ...s, sources: [mine, team, friend] }));
    setDestinationChooser(async (_t, choices, dflt) => { offered = choices.map((c) => c.id); return dflt; }, { saveNew: 'scripts' });
    expect(await chooseCopyDestination('specterscripts/fog')).toBe('scripts');
    expect(offered).toEqual(['my-scripts', 'scripts', '']);
    expect(await chooseCopyDestination('scripts/fog')).toBe('my-scripts');
  });

  it('full names', () => {
    expect(qualify('my-scripts', 'porch')).toBe('my-scripts/porch');
    expect(qualify('', 'porch')).toBe('porch');
    expect(sourceOf('my-scripts/porch')).toBe('my-scripts');
    expect(sourceOf('porch')).toBe('');
    expect(titleOf('my-scripts/porch')).toBe('porch');
  });
});

describe('what an answer does to the screen', () => {
  const fail = { ok: false, message: 'Your scripts folder needs a git client to sort this out: x. Folder: /p/sources/my-scripts.', problem: { kind: 'git_client', reason: 'x' } };

  it('a button that did not work shows one dialog, with the source folder to open', () => {
    const s = applyAnswer(EMPTY, fail, false);
    expect(s.dialog?.message).toContain('needs a git client');
    expect(s.note).toBe('');
    expect(folderIn(s.dialog!.message)).toBe('/p/sources/my-scripts');
  });

  it('auto save that did not work leaves only a quiet note, and a later success clears it', () => {
    const s = applyAnswer(EMPTY, fail, true);
    expect(s.dialog).toBeNull();
    expect(s.note).toMatch(/Auto save did not work/);
    expect(applyAnswer(s, fail, true).dialog).toBeNull();
    const ok = applyAnswer(s, { ok: true, message: 'Backed up to you/my-scripts: 1 script changed.' }, true);
    expect(ok.note).toBe('');
    expect(ok.last).toBeNull();
    expect(ok.done).toMatch(/Backed up/);
  });

  it('a source found read-only is a plain note, not a problem to keep showing', () => {
    const s = applyAnswer(EMPTY, { ok: false, message: 'Studio cannot back up to this source…', problem: { kind: 'no_write', reason: '' } }, false);
    expect(s.dialog?.kind).toBe('no_write');
    expect(s.last).toBeNull();
  });
});
