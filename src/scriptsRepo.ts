// Script sources (core/src/sources.rs, core/src/gitsync.rs) as the UI sees them: the status line's words, where a
// new script is saved, and what an answer from Get latest / Back up everything / auto save does to the screen.
// Pure functions plus one small shared state, so Settings, Your library, the status bar and the command palette
// all show the same thing.

export interface RepoProblem { kind: string; reason: string }
export interface SourceStatus {
  /** the source's folder under the library's sources/ (its scripts are named "<id>/<script>") */
  id: string;
  path?: string;
  connected: boolean;
  repo?: string;
  url?: string;
  branch?: string;
  /** files changed and not yet in the repository */
  changes?: number;
  /** last backup, seconds since 1970 */
  last_backup?: number | null;
  /** Studio cannot push there: Get latest only */
  read_only?: boolean;
  commit?: string;
  problem?: RepoProblem | null;
  message?: string | null;
}
export interface RepoAnswer { ok: boolean; message: string; changed?: boolean; problem?: RepoProblem | null }

/** What the person keeps per library (Prefs.scriptSources): where new scripts go, which sources auto save. */
export interface SourcePrefs { saveNew?: string; auto?: string[] }

/** Auto save waits this long after the last save (core/src/gitsync.rs AUTO_SAVE_QUIET), in words. */
export const AUTO_SAVE_QUIET_TEXT = '10 seconds';
/** The status line is read again this often (it is local: no network). */
export const STATUS_REFRESH_MS = 30_000;

const pad = (n: number) => String(n).padStart(2, '0');

/** "today 14:02", "yesterday 09:15", "2026-10-21 14:02", or "never". */
export function lastBackupText(secs: number | null | undefined, now = new Date()): string {
  if (!secs) return 'never';
  const d = new Date(secs * 1000);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const day = (x: Date) => `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;
  if (day(d) === day(now)) return `today ${hm}`;
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (day(d) === day(y)) return `yesterday ${hm}`;
  return `${day(d)} ${hm}`;
}

export function changesText(n: number | undefined): string {
  if (!n) return 'everything backed up';
  return `${n} change${n === 1 ? '' : 's'} not backed up`;
}

/** One source's line: "you/my-props · backed up today 14:02 · 2 changes not backed up". */
export function sourceLine(s: SourceStatus, now = new Date()): string {
  if (s.problem && s.problem.kind !== 'not_connected') return `${s.repo || s.id}: needs attention`;
  if (s.read_only) return `${s.repo || s.id} · read-only (Get latest only)`;
  return `${s.repo || s.id} · backed up ${lastBackupText(s.last_backup, now)} · ${changesText(s.changes)}`;
}

/** The status bar's line for all sources together (read-only ones have nothing to back up). */
export function statusLine(list: SourceStatus[], now = new Date()): string {
  if (!list.length) return '';
  if (list.length === 1) return sourceLine(list[0], now);
  if (list.some((s) => s.problem && s.problem.kind !== 'not_connected')) return `${list.length} sources: one needs attention`;
  const mine = list.filter((s) => !s.read_only);
  const last = Math.max(0, ...mine.map((s) => s.last_backup || 0));
  const changes = mine.reduce((n, s) => n + (s.changes || 0), 0);
  return `${list.length} sources · backed up ${lastBackupText(last || null, now)} · ${changesText(changes)}`;
}

/** Where a new script can go: the sources Studio can push to. */
export function writable(list: SourceStatus[]): SourceStatus[] {
  return list.filter((s) => s.connected && !s.read_only);
}

/** The default destination for a new script: the source marked "Save new scripts here" (while it can be
 * written), else the only writable source, else the library itself (''). */
export function defaultDestination(list: SourceStatus[], prefs: SourcePrefs | undefined): string {
  const w = writable(list);
  if (prefs?.saveNew && w.some((s) => s.id === prefs.saveNew)) return prefs.saveNew;
  return w.length === 1 ? w[0].id : '';
}

/** A new script asks where it goes only when there is a real choice: two or more writable sources. */
export function asksDestination(list: SourceStatus[]): boolean {
  return writable(list).length >= 2;
}

/** "<source>/<name>" (or the plain name for the library itself). */
export const qualify = (dest: string, name: string) => (dest ? `${dest}/${name}` : name);
/** The source of a full script name ('' for the library's own). */
export const sourceOf = (name: string) => (name.includes('/') ? name.slice(0, name.indexOf('/')) : '');
/** The script's own name without its source. */
export const titleOf = (name: string) => (name.includes('/') ? name.slice(name.indexOf('/') + 1) : name);

export interface RepoState {
  sources: SourceStatus[];
  /** what is running ('' = nothing): "add", "get:<id>" / "backup:<id>" ("*" = all sources) */
  busy: string;
  /** the quiet note in the status bar (auto save did not work) */
  note: string;
  /** the one message shown in a dialog (a button press that did not work, or a click on the note) */
  dialog: { message: string; kind: string } | null;
  /** the last problem, kept so a click on the note can show it */
  last: { message: string; kind: string } | null;
  /** the last thing that worked, in words (Settings shows it) */
  done: string;
}

export const EMPTY: RepoState = { sources: [], busy: '', note: '', dialog: null, last: null, done: '' };

/** What an answer does to the screen. A button the person pressed shows a failure in a dialog; auto save only
 * leaves a quiet note in the status bar (never a dialog, never again and again). A source found read-only is
 * a plain note, not an error. */
export function applyAnswer(s: RepoState, a: RepoAnswer, auto: boolean): RepoState {
  if (a.ok) return { ...s, note: auto ? '' : s.note, last: auto ? null : s.last, done: a.message };
  const p = { message: a.message, kind: a.problem?.kind || 'error' };
  if (auto) return { ...s, note: 'Auto save did not work: click for details', last: p };
  if (p.kind === 'no_write') return { ...s, done: '', dialog: p };
  return { ...s, dialog: p, last: p, done: '' };
}

// ---- the shared state
let state: RepoState = EMPTY;
const subs = new Set<(s: RepoState) => void>();
export function getRepoState() { return state; }
export function setRepoState(f: (s: RepoState) => RepoState) {
  state = f(state);
  subs.forEach((l) => l(state));
}
export function subscribeRepo(fn: (s: RepoState) => void): () => void {
  subs.add(fn);
  return () => subs.delete(fn);
}

// ---- where a new script goes: asked by a dialog that components/ScriptsRepo.tsx puts up (none: the default)
export interface Destination { id: string; label: string }
export const LIBRARY_ONLY: Destination = { id: '', label: 'Your library on this computer (not in a source)' };
type Chooser = (title: string, choices: Destination[], dflt: string) => Promise<string | null>;
let chooser: Chooser | null = null;
let prefsNow: SourcePrefs | undefined;
export function setDestinationChooser(c: Chooser | null, prefs?: SourcePrefs) { chooser = c; prefsNow = prefs; }

/** The places a script can be saved: every writable source, then the library itself. */
export function destinations(list: SourceStatus[], except?: string): Destination[] {
  return [...writable(list).map((s) => ({ id: s.id, label: s.repo && s.repo !== s.id ? `${s.id} (${s.repo})` : s.id })), LIBRARY_ONLY].filter((d) => d.id !== except);
}

/** The destination for a new script called `name`: asked when there are two or more writable sources (closing
 * the question keeps the default). `ask: false` (scripts Studio keeps by itself): the default, never a question. */
export async function chooseDestination(name: string, ask = true): Promise<string> {
  const list = state.sources;
  const dflt = defaultDestination(list, prefsNow);
  if (!ask || !asksDestination(list) || !chooser) return dflt;
  const d = await chooser(`Where should “${name}” be saved?`, destinations(list), dflt);
  return d ?? dflt;
}

/** "Save a copy to…": always asks (null: cancelled). */
export async function chooseCopyDestination(name: string): Promise<string | null> {
  const choices = destinations(state.sources, sourceOf(name) || undefined);
  if (!chooser) return null;
  const dflt = defaultDestination(state.sources, prefsNow);
  return chooser(`Save a copy of “${titleOf(name)}” to…`, choices, choices.some((c) => c.id === dflt) ? dflt : choices[0]?.id ?? '');
}
