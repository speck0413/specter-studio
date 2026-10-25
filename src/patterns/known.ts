// The LED patterns a script can name (`pixels = pattern <name>`) and the buttons it can press (`pixels press
// <button>`): the patterns stored on the board being checked with (its list_patterns answer), and the library's
// own. The blocks' menus and the text editor's typeahead read them (as terms.ts and fleet.ts for the other names).

import { compilePattern } from './compile';

export interface KnownPattern {
  /** the name a script writes after `pixels = pattern` */
  name: string;
  /** its buttons (trigger controls) as `pixels press` takes them: Studio's label, lower case */
  buttons: string[];
  /** where it is known from */
  where: 'board' | 'library';
}

let current: KnownPattern[] = [];
export const getKnownPatterns = () => current;
export const setKnownPatterns = (p: KnownPattern[]) => { current = p; };
// the script being edited (its pattern lines say whose buttons a press may name)
let scriptText = '';
export const getScriptText = () => scriptText;
export const setScriptText = (t: string) => { scriptText = t; };

/** A pattern's or button's words as a board compares them: lower case, runs of spaces made one, trimmed. */
export const patternWords = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

/** The buttons of a pattern's source (none when it does not compile). */
export function buttonsOf(source: string): string[] {
  try {
    return compilePattern(source).controls.filter((c) => c.kind === 'trigger').map((c) => patternWords(c.label));
  } catch { return []; }
}

/** The patterns a board reports (list_patterns' `patterns`). */
export function boardPatterns(list: any[] | null | undefined): KnownPattern[] {
  if (!Array.isArray(list)) return [];
  return list.filter((p) => typeof p?.name === 'string').map((p) => ({ name: patternWords(p.name), buttons: Array.isArray(p.buttons) ? p.buttons.map(String) : [], where: 'board' as const }));
}

/** The board's first, then the library's that the board does not have. */
export function mergeKnown(board: KnownPattern[], library: KnownPattern[]): KnownPattern[] {
  const out = [...board];
  for (const p of library) if (!out.some((x) => x.name === p.name)) out.push(p);
  return out;
}

/** The buttons of the patterns a script's text shows (`pixels = pattern <name>` lines), when any are known. */
export function buttonsFor(text: string, known: KnownPattern[] = current): string[] {
  const names = new Set<string>();
  for (const raw of text.split(/\r\n|\n|\r/)) {
    const m = /^\s*pixels\s*[=:]\s*pattern\s+([^#]+)/i.exec(raw);
    if (m) names.add(patternWords(m[1]));
  }
  const pick = names.size ? known.filter((p) => names.has(p.name)) : known;
  return [...new Set(pick.flatMap((p) => p.buttons))];
}

/**
 * Why a board cannot keep a pattern under this name (null when it can): 1-32 letters, digits, spaces and - _ ( ),
 * the board's rule (its pattern_store.cpp).
 */
export function boardNameProblem(name: string): string | null {
  const n = name.trim().replace(/\s+/g, ' ');
  if (!n) return 'the pattern needs a name';
  if (n.length > 32) return `a board keeps a pattern's name of at most 32 characters (“${n}” has ${n.length}): rename the pattern in Your library`;
  if (!/^[A-Za-z0-9 _()-]+$/.test(n)) return `a board takes letters, digits, spaces and - _ ( ) in a pattern's name: rename “${n}” in Your library`;
  return null;
}
