import { describe, expect, it } from 'vitest';
import { boardLink, boardsRunning, libraryNameFor, runningVersion, sameScript, versionSummary } from './scriptLinks';

const LIB = 'effect porch light:\n  wait for trig1\n  out1 = on\n  sleep 1\n  out1 = off\n';
const board = (key: string, name: string, status: any, text = LIB) => ({ key, info: { name }, script: { text }, scriptStatus: status });

describe('which library script a board runs', () => {
  it('same, older, changed: the library has it, open it there', () => {
    expect(boardLink(board('a', 'A', { status: 'current', name: 'porch light' }))).toEqual({ kind: 'library', name: 'porch light', version: 'same' });
    expect(boardLink(board('a', 'A', { status: 'older', name: 'porch light' }))).toEqual({ kind: 'library', name: 'porch light', version: 'older' });
    expect(boardLink(board('a', 'A', { status: 'changed', name: 'shared/porch light' }))).toEqual({ kind: 'library', name: 'shared/porch light', version: 'changed' });
  });
  it('not in the library: save it there first', () => {
    expect(boardLink(board('a', 'A', { status: 'unknown', hash: 'x' }))).toEqual({ kind: 'not-in-library' });
    // a name from the header but no such file in the library any more
    expect(boardLink(board('a', 'A', { status: 'unknown', name: 'gone' }))).toEqual({ kind: 'not-in-library' });
  });
  it('no script, not known yet, or no scripts on this board: nothing to open', () => {
    expect(boardLink(board('a', 'A', { status: 'none' }, ''))).toEqual({ kind: 'none' });
    expect(boardLink(board('a', 'A', { status: 'unknown' }, '# only a comment\n'))).toEqual({ kind: 'none' });
    expect(boardLink(board('a', 'A', undefined))).toEqual({ kind: 'unknown' });
    expect(boardLink(board('a', 'A', { status: 'unsupported' }))).toEqual({ kind: 'unknown' });
    expect(boardLink(undefined)).toEqual({ kind: 'unknown' });
  });
});

describe('the boards running a library script', () => {
  it('by name, with the version each runs', () => {
    expect(runningVersion(board('a', 'A', { status: 'current', name: 'porch light' }), 'porch light', LIB)).toBe('same');
    expect(runningVersion(board('a', 'A', { status: 'older', name: 'porch light' }, 'effect porch light:\n  wait for trig1\n'), 'porch light', LIB)).toBe('older');
    expect(runningVersion(board('a', 'A', { status: 'changed', name: 'porch light' }, LIB + '# mine\n'), 'porch light', LIB)).toBe('changed');
    expect(runningVersion(board('a', 'A', { status: 'current', name: 'graveyard' }, 'effect g:\n'), 'porch light', LIB)).toBeNull();
  });
  it('by content: the same script word for word, header, line endings and trailing spaces aside', () => {
    const crlf = '# Specter Studio: something else, saved 2026-10-01 10:00\r\n' + LIB.replace(/\n/g, '  \r\n') + '\r\n\r\n';
    expect(sameScript(crlf, LIB)).toBe(true);
    expect(runningVersion(board('a', 'A', { status: 'unknown' }, crlf), 'porch light', LIB)).toBe('same');
    expect(runningVersion(board('a', 'A', { status: 'unknown' }, LIB + '  sleep 2\n'), 'porch light', LIB)).toBeNull();
    // without the library's text, only the name counts
    expect(runningVersion(board('a', 'A', { status: 'unknown' }), 'porch light')).toBeNull();
    // two empty scripts are not "running" anything
    expect(runningVersion(board('a', 'A', { status: 'none' }, ''), 'empty', '')).toBeNull();
  });
  it('lists them by board name and sums them up', () => {
    const list = boardsRunning({
      z: board('z', 'Zombie', { status: 'older', name: 'porch light' }, 'effect porch light:\n'),
      p: board('p', 'Practice board 1', { status: 'current', name: 'porch light' }),
      g: board('g', 'Graveyard', { status: 'unknown' }, 'effect g:\n  wait for trig1\n'),
      c: board('c', 'Crypt', { status: 'unknown' }),
    }, 'porch light', LIB);
    expect(list.map((r) => [r.board.info.name, r.version])).toEqual([['Crypt', 'same'], ['Practice board 1', 'same'], ['Zombie', 'older']]);
    expect(versionSummary(list)).toBe('2 same, 1 older');
    expect(versionSummary([{ version: 'changed' }])).toBe('1 changed on the board');
  });
});

describe('the name a board script gets in Your library', () => {
  it('the name Studio sent it with (without the source), else its first effect, else the board', () => {
    expect(libraryNameFor('# Specter Studio: shared/porch light, saved 2026-10-01 10:00\neffect x:\n', 'B')).toBe('porch light');
    expect(libraryNameFor('# my notes\neffect lamp and fog: lab/1\n  wait for trig1\n', 'B')).toBe('lamp and fog');
    expect(libraryNameFor('  wait for trig1\n', 'Crypt')).toBe('Crypt effect');
  });
});
