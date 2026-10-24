// Saving a NEW effect never replaces one that is already in the library: a name that is taken (the same file name,
// ignoring case and spaces at the ends, as Windows and macOS do) gets " 2", " 3"... and the effect's own
// "effect <name>:" line follows it when it carried the old name.
import { call, nowLocal } from './api';
import { chooseDestination, qualify } from './scriptsRepo';

const key = (n: string) => n.trim().toLowerCase();

/** The name itself when it is free, else the first free "name 2", "name 3"... */
export function freeName(taken: string[], name: string): string {
  const used = new Set(taken.map(key));
  const base = name.trim();
  if (!used.has(key(base))) return base;
  for (let i = 2; ; i++) if (!used.has(key(`${base} ${i}`))) return `${base} ${i}`;
}

/** The text with its "effect <from>:" line(s) renamed to "effect <to>:". */
export function renameEffectLine(text: string, from: string, to: string): string {
  const esc = from.trim().replace(/:/g, '').slice(0, 32).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`^(\\s*effect\\s+)${esc}(\\s*:)`, 'gim'), `$1${to.replace(/:/g, '').slice(0, 32)}$2`);
}

/** Saves a new effect under a free name; says which name it got and whether that differs from the one asked for.
 * With script sources (scriptsRepo.ts) it goes to the chosen source (`dest`), else the default one, asking when
 * there are two or more it could go to; `ask: false` never asks (scripts Studio keeps by itself); `keepText` never
 * renames the effect line. */
export async function saveNewEffect(folder: string, name: string, text: string, opts: { dest?: string; ask?: boolean; keepText?: boolean } = {}): Promise<{ name: string; text: string; renamed: boolean }> {
  const dest = opts.dest ?? (await chooseDestination(name.trim(), opts.ask !== false));
  // the library must be read: guessing it is empty could put the new effect over one already there
  const list: { name: string; source?: string | null; title?: string }[] = await call('library_list', { folder });
  const free = freeName(list.filter((e) => (e.source || '') === dest).map((e) => e.title ?? e.name), name);
  const renamed = free !== name.trim();
  // `keepText`: a board's script is kept word for word, so the board still counts as running it
  const body = renamed && !opts.keepText ? renameEffectLine(text, name, free) : text;
  await call('library_save', { folder, name: qualify(dest, free), text: body, now: nowLocal() });
  return { name: qualify(dest, free), text: body, renamed };
}

export const takenNote = (asked: string, got: string) =>
  `There is already an effect called “${asked.trim()}” in your library, so this one is called “${got}”. Nothing was replaced.`;

// Studio's header line on a board's script (core/src/library.rs): `# Specter Studio: <name>, saved <time>`
const HEADER = '# Specter Studio: ';

/** The script without Studio's header line: what the library keeps and what a person edits. */
export function scriptBody(text: string): string {
  if (!text.startsWith(HEADER)) return text;
  const i = text.indexOf('\n');
  return i < 0 ? '' : text.slice(i + 1);
}

/** Name and save time from Studio's header line, if the script has one. */
export function scriptHeader(text: string): { name: string; saved: string } | null {
  if (!text.startsWith(HEADER)) return null;
  const first = text.slice(HEADER.length).split(/\r?\n/)[0].trimEnd();
  const at = first.lastIndexOf(', saved ');
  return at < 0 ? null : { name: first.slice(0, at), saved: first.slice(at + ', saved '.length) };
}
