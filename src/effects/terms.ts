// The names an effect script can use on the board it is written for: its inputs, outputs, sounds and the settings
// that may stand for a time or a count (SHOW-SCRIPT.md SS-N, SS-G6). The blocks' dropdowns and the text editor's
// typeahead both read them. They come from the board picked for checking (its terminals, the names given to them
// and its profile's aliases), else the default Proptroller terminal set.

export interface Term {
  /** the terminal or setting as the script writes it: trig1, out1, cooldown_ms, an alias */
  id: string;
  /** the name given to it (the wiring name or the profile's alias), shown beside the id */
  name?: string;
  /** an output that dims (out1-out4, DMX channels) */
  dims?: boolean;
}

export interface Sound { n: number; description: string }

/**
 * The sounds from a file name -> number map (the library's sounds.csv or a card's names): `02/001-scream.mp3` is
 * 2 · scream. The description is the name without its folder, number and extension.
 */
export function soundList(map: Record<string, unknown> | null | undefined): Sound[] {
  const out = new Map<number, Sound>();
  for (const [file, num] of Object.entries(map || {})) {
    const lead = /^(\d+)/.exec(file);
    const n = Number(num ?? lead?.[1]);
    if (!Number.isInteger(n) || n < 1 || n > 99 || out.has(n)) continue;
    out.set(n, { n, description: file.replace(/^\d+[\\/]/, '').replace(/^\d+[-_ ]*/, '').replace(/\.[a-z0-9]+$/i, '') });
  }
  return [...out.values()].sort((a, b) => a.n - b.n);
}

export interface Terms {
  inputs: Term[];
  outputs: Term[];
  /** the sounds by number (a script names a sound by its number: `audio_single = 2`), with a description from the
   * card's or folder's file name; empty when no list is known */
  sounds: Sound[];
  /** settings a line may name for a time (SS-G6), with the profile's aliases of them */
  timeSettings: Term[];
  /** settings a line may name for a count of runs */
  countSettings: Term[];
  /** true when the lists are a real board's (an unknown name is then "not on this board") */
  fromBoard: boolean;
}

export const INPUT_IDS = ['trig1', 'trig2', 'user1', 'user2', 'user3'];
export const OUTPUT_IDS = ['out1', 'out2', 'out3', 'out4', 'rly1', 'rly2', 'cc1', 'cc2'];
export const TIME_SETTINGS = ['out1_on_ms', 'out2_on_ms', 'out3_on_ms', 'recover_time_ms', 'cooldown_ms', 'trigger_out_pulse_ms', 'role_pulse_ms'];
export const COUNT_SETTINGS = ['runs_per_cooldown'];

/** out1-out4 and DMX channels dim; relays and contacts are on or off. */
export const dimsId = (id: string) => /^(out[1-4]|dmx\d+)$/i.test(id);

export function defaultTerms(): Terms {
  return {
    inputs: INPUT_IDS.map((id) => ({ id })),
    outputs: OUTPUT_IDS.map((id) => ({ id, dims: dimsId(id) })),
    sounds: [],
    timeSettings: TIME_SETTINGS.map((id) => ({ id })),
    countSettings: COUNT_SETTINGS.map((id) => ({ id })),
    fromBoard: false,
  };
}

/** A name works in a script when it is one word of letters, digits and _ starting with a letter (SS-N). */
const scriptName = (s: unknown): string | undefined => (typeof s === 'string' && /^[A-Za-z][A-Za-z0-9_]*$/.test(s.trim()) ? s.trim() : undefined);

/**
 * The lists for a board: `info` is its info answer (inputs, channels, terminals with label and alias), `profile` its
 * get_profile answer (key aliases), `sounds` the sounds known for it. A board with no info gives the defaults.
 */
export function termsFor(info: any, profile?: any, sounds: Sound[] = []): Terms {
  const d = defaultTerms();
  d.sounds = sounds;
  if (!info) return d;
  const terms: any[] = Array.isArray(info.terminals) ? info.terminals : [];
  const term = (id: string) => terms.find((t) => String(t.id).toLowerCase() === id.toLowerCase());
  const named = (id: string): Term => {
    const t = term(id);
    const name = scriptName(t?.alias) || (t?.label ? String(t.label).trim() : undefined);
    return name && name.toLowerCase() !== id ? { id, name } : { id };
  };
  const inputs = ((info.inputs as string[]) || terms.filter((t) => t.kind === 'input').map((t) => t.id) || []).map((i) => String(i).toLowerCase())
    .filter((i) => INPUT_IDS.includes(i) && term(i)?.shows !== false);
  const outputs = ((info.channels as string[]) || terms.filter((t) => t.kind === 'output').map((t) => t.id) || []).map((c) => String(c).toLowerCase())
    .filter((c) => term(c)?.shows !== false);
  const aliases: { alias: string; key: string }[] = (profile?.aliases || []).filter((a: any) => typeof a?.alias === 'string' && typeof a?.key === 'string');
  const withAliases = (keys: string[]): Term[] => [
    ...keys.map((id) => ({ id })),
    ...aliases.filter((a) => keys.includes(a.key)).map((a) => ({ id: a.alias, name: a.key })),
  ];
  return {
    inputs: (inputs.length ? inputs : INPUT_IDS).map(named),
    outputs: (outputs.length ? outputs : OUTPUT_IDS).map((id) => ({ ...named(id), dims: dimsId(id) })),
    sounds,
    timeSettings: withAliases(TIME_SETTINGS),
    countSettings: withAliases(COUNT_SETTINGS),
    fromBoard: true,
  };
}

const squash = (s: string) => s.replace(/[\s  ]/g, '').toLowerCase();

/** The term a written name means (its id, or the name given to it, any case), or null. */
export function findTerm(list: Term[], written: string): Term | null {
  const w = squash(written);
  if (!w) return null;
  return list.find((t) => t.id.toLowerCase() === w) || list.find((t) => t.name && squash(t.name) === w) || null;
}

/** How a terminal is shown: `bell (trig1)` with a name, else `trig1`. */
export const shown = (t: Term) => (t.name ? `${t.name} (${t.id})` : t.id);

/** Whether a written output dims: a known one by its terminal, a DMX channel, an unknown name (not ruled out) yes. */
export function outputDims(terms: Terms, written: string): boolean {
  if (/^\s*dmx\s*\d+\s*$/i.test(written)) return true;
  const t = findTerm(terms.outputs, written);
  return t ? !!t.dims : !/^(rly|cc)\d+$/i.test(squash(written));
}

// ---------------------------------------------------------------- the lists in use

let current: Terms = defaultTerms();
const listeners = new Set<() => void>();
export const getTerms = () => current;
export function setTerms(t: Terms) {
  current = t;
  for (const l of listeners) l();
}
/** Called after the lists change (the blocks redraw their labels). Returns the way to stop. */
export function onTermsChange(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
