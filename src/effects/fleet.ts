// The other boards a script's `tell` lines can name (SHOW-SCRIPT.md §11): the boards Studio knows, each by the
// network name the board link addresses it by, and the effects of its script when Studio has read it. The text
// editor's typeahead offers them after `tell` and after a board's name.
import type { Completion } from './completions';
import { effectName } from './cppgen';

export interface FleetBoard {
  /** the network name a tell line uses: `front-door` for a board named "Front Door" */
  label: string;
  /** the board's own name, shown beside it */
  name: string;
  /** the effects a tell line can start on it (as written in a tell line: spaces as `_`), or null when its script is not known */
  effects: string[] | null;
}

/**
 * The name a board answers to on the network, as the firmware makes it from the board's name (proto.cpp hostLabel):
 * every character that is not an ASCII letter or digit becomes `-`, lower case, runs of `-` made one and trimmed,
 * at most 40 characters; an empty result is `proptroller-` and the last four characters of the board's id.
 */
export function hostLabel(name: string, id = ''): string {
  let s = '';
  for (const ch of name) s += /^[A-Za-z0-9]$/.test(ch) ? ch.toLowerCase() : '-';
  s = s.split('-').filter(Boolean).join('-').slice(0, 40).replace(/-+$/, '');
  return s || `proptroller-${id.length >= 4 ? id.slice(-4) : id}`;
}

/** An effect's name as a tell line sends it (lower case, runs of spaces one `_`), or null when it cannot be sent. */
export function tellName(effect: string): string | null {
  const n = effect.trim().toLowerCase().replace(/ +/g, '_');
  return n && n.length <= 32 && !/[/+]/.test(n) ? n : null;
}

/** The effects of a script, as tell lines name them, in the script's order. */
export function scriptEffects(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r\n|\n|\r/)) {
    const line = raw.replace(/[\t  ]/g, ' ').replace(/#.*$/, '').trim();
    if (!/^effect/i.test(line)) continue;
    const n = tellName(effectName(line));
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
}

/** The boards from Studio's board list (devices from a device adapter are not boards), without `self`. */
export function fleetFrom(boards: Record<string, any>, self = ''): FleetBoard[] {
  const out: FleetBoard[] = [];
  for (const b of Object.values(boards || {})) {
    if (!b || b.adapter || b.key === self || !b.info?.name) continue;
    const label = hostLabel(String(b.info.name), String(b.info.id || ''));
    if (out.some((f) => f.label === label)) continue;
    out.push({ label, name: String(b.info.name), effects: typeof b.script?.text === 'string' ? scriptEffects(b.script.text) : null });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

let current: FleetBoard[] = [];
export const getFleet = () => current;
export const setFleet = (f: FleetBoard[]) => { current = f; };

const ALL_DETAIL = 'every other board of the group';

/** What fits after `tell` (a board) and after `tell <board>` (its effects), or null when `before` is not there. */
export function tellCompletions(before: string, fleet: FleetBoard[] = getFleet()): Completion[] | null {
  let m: RegExpExecArray | null;
  if (/^\s*tell\s+[^\s=:]*$/i.test(before)) {
    return [
      ...fleet.map((f): Completion => ({ label: f.label, insert: `${f.label} `, snippet: false, kind: 'word', retrigger: true, filter: `${f.label} ${f.name}`, detail: f.name === f.label ? 'a board' : `the board ${f.name}` })),
      { label: 'all', insert: 'all ', snippet: false, kind: 'word', retrigger: true, detail: ALL_DETAIL },
    ];
  }
  if ((m = /^\s*tell\s+([^\s=:]+)\s+[^=:]*$/i.exec(before))) {
    const to = m[1].toLowerCase();
    const has = to === 'all' ? fleet.filter((f) => f.effects) : fleet.filter((f) => f.label === to && f.effects);
    const names = [...new Set(has.flatMap((f) => f.effects!))];
    return names.map((n): Completion => {
      const on = has.filter((f) => f.effects!.includes(n)).map((f) => f.name);
      return { label: n, insert: n, snippet: false, kind: 'word', detail: `start the effect ${n} on ${to === 'all' ? `every board that has it (${on.join(', ')})` : on[0]}` };
    });
  }
  return null;
}
