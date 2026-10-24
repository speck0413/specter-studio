// Which library script a board runs, and which boards run a library script: the two links between a board's page
// and an effect's page in Your library. The device layer's `library_identify` (core/src/library.rs) has already
// matched each board's script against the library (by Studio's header line or by its text); this adds the match by
// text against the script open in the editor, so a board that got the same script some other way counts too.
import type { Board } from './store';
import { scriptBody, scriptHeader } from './library';
import { titleOf } from './scriptsRepo';

/** How the board's copy compares with the library's: the same, an older version, or changed on the board. */
export type Version = 'same' | 'older' | 'changed';

export const VERSION_WORDS: Record<Version, string> = { same: 'Same version', older: 'Older version', changed: 'Changed on the board' };

/** What the board page offers for the board's script. */
export type BoardLink =
  | { kind: 'library'; name: string; version: Version } // Open in Your library
  | { kind: 'not-in-library' } // Save to Your library and open
  | { kind: 'none' } // no effect script on the board
  | { kind: 'unknown' }; // not known yet, or the board cannot run effect scripts: nothing to offer

/** A script as the library compares it: no header line, the same line endings, no spaces at line ends or at the end
 * (as `hash` in core/src/library.rs). */
export function normalScript(text: string): string {
  return scriptBody(text).replace(/\r\n?/g, '\n').split('\n').map((l) => l.trimEnd()).join('\n').trimEnd();
}

export const sameScript = (a: string, b: string) => normalScript(a) === normalScript(b);

/** Only comments and empty lines: no effect script (as the device layer counts it). */
export const emptyScript = (text: string) => text.split(/\r?\n/).every((l) => !l.trim() || l.trimStart().startsWith('#'));

const STATUS_VERSION: Record<string, Version> = { current: 'same', older: 'older', changed: 'changed' };

export function boardLink(b: Pick<Board, 'script' | 'scriptStatus'> | undefined): BoardLink {
  const s = b?.scriptStatus;
  if (!s) return { kind: 'unknown' };
  const v = STATUS_VERSION[s.status];
  if (v && s.name) return { kind: 'library', name: s.name, version: v };
  if (s.status === 'none') return { kind: 'none' };
  if (s.status === 'unknown') return b?.script?.text && !emptyScript(b.script.text) ? { kind: 'not-in-library' } : { kind: 'none' };
  return { kind: 'unknown' };
}

/** How `b` runs the library's `name` (whose text is `libraryText`, when known), or null when it runs something else.
 * By name: the device layer's match. By text: the board's script is this script word for word. */
export function runningVersion(b: Pick<Board, 'script' | 'scriptStatus'>, name: string, libraryText?: string): Version | null {
  const l = boardLink(b);
  if (l.kind === 'library' && l.name === name) return l.version;
  const text = b.script?.text;
  if (libraryText !== undefined && text && !emptyScript(text) && sameScript(text, libraryText)) return 'same';
  return null;
}

/** Every known board running the library's `name`, by board name. */
export function boardsRunning<B extends Pick<Board, 'key' | 'info' | 'script' | 'scriptStatus'>>(boards: Record<string, B> | B[], name: string, libraryText?: string): { board: B; version: Version }[] {
  const out: { board: B; version: Version }[] = [];
  for (const b of Array.isArray(boards) ? boards : Object.values(boards)) {
    const version = runningVersion(b, name, libraryText);
    if (version) out.push({ board: b, version });
  }
  return out.sort((a, c) => String(a.board.info?.name || a.board.key).localeCompare(String(c.board.info?.name || c.board.key)));
}

/** "2 same, 1 older" */
export function versionSummary(list: { version: Version }[]): string {
  const n = (v: Version) => list.filter((x) => x.version === v).length;
  return ([['same', 'same'], ['older', 'older'], ['changed', 'changed on the board']] as [Version, string][])
    .filter(([v]) => n(v) > 0).map(([v, w]) => `${n(v)} ${w}`).join(', ');
}

/** The name a board's script is saved under in Your library: the name Studio sent it with, else its first effect's
 * name, else "<board> effect". */
export function libraryNameFor(text: string, boardName: string): string {
  const h = scriptHeader(text);
  if (h?.name) return titleOf(h.name).trim();
  const m = /^\s*effect\s+([^:\n]+?)\s*:/m.exec(scriptBody(text));
  if (m) return m[1].replace(/[/\\:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim();
  return `${boardName} effect`;
}

// a note for the effect's page, left by whoever opened it: EffectEditor shows it, then drops it once shown (read and
// dropped in two steps, so a second run of the same effect, as React's development mode does, still finds it)
const notes = new Map<string, string>();
export const leaveNote = (name: string, text: string) => { notes.set(name, text); };
export const peekNote = (name: string) => notes.get(name);
export const dropNote = (name: string) => { notes.delete(name); };
