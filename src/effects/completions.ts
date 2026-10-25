// Typeahead for the effect script text editor: what fits where the cursor is, from the line before it. After
// `out1 =` the levels (on, off and one "level %" that selects its number, so typing replaces it); after `rly1 =`
// only on and off; after `wait for` the inputs by their names; after a sound line the sounds; in a time the units
// and the settings that may stand for a time (SS-G6). The names come from terms.ts (the board, else the defaults).
import { getTerms, outputDims, shown, Term, Terms } from './terms';
import { NO_COLOUR, PIXEL_COLOURS, PIXEL_EFFECTS } from './words';
import { FleetBoard, getFleet, tellCompletions } from './fleet';

export interface Completion {
  label: string;
  insert: string;
  snippet: boolean;
  detail: string;
  /** what typing is matched against, when not the label */
  filter?: string;
  kind: 'line' | 'level' | 'terminal' | 'unit' | 'setting' | 'sound' | 'word' | 'colour';
  /** open the suggestions again after it is inserted (`out1 = ` goes on to the levels) */
  retrigger?: boolean;
}

/** The word a pause is written with (owner, 2026-10-24: `wait 2`; boards also take the older `sleep 2`). */
export const PAUSE = 'wait';

const line = (label: string, insert: string, detail: string, retrigger = false): Completion => ({ label, insert, snippet: insert.includes('$'), detail, kind: 'line', retrigger });

/** The kinds of line, as short snippets, offered at the start of a line. */
export function lineStarts(): Completion[] {
  return [
    line('effect', 'effect ${1:my effect}:\n  wait for ${2:trig1}\n  $0', 'a new effect'),
    line('wait for', 'wait for ${1:trig1}', 'wait for a press on an input'),
    line(PAUSE, `${PAUSE} \${1:2}`, 'wait this long (seconds; or 200 ms, 3 min)'),
    line('fade', 'fade ${1:out1} to ${2:0%} over ${3:2}', 'change a light smoothly'),
    line('flicker', 'flicker ${1:out1} for ${2:3}', 'flicker like a failing bulb'),
    line('pulse', 'pulse ${1:cc1} for ${2:200 ms}', 'on now, off after a time'),
    line('limit', 'limit ${1:3} runs per ${2:3 min}', 'at most this many runs in a time'),
    line('tell', 'tell ', 'tell another board to start an effect or use a setting', true),
    line('audio_single', 'audio_single = ', 'play a sound once', true),
    line('audio_loop', 'audio_loop = ', 'play a sound over and over', true),
    line('audio_loop = off', 'audio_loop = off', 'end the background sound'),
    line('audio_volume', 'audio_volume = ${1:60%}', 'how loud the script\'s sounds play (0% to 100%)'),
    line('audio_stop', 'audio_stop', 'stop the sound'),
    line('pixels', 'pixels = ', 'light the LED strip: an effect, then a colour', true),
  ];
}

const terminal = (t: Term, prefix = '', detail = ''): Completion => ({
  label: `${prefix}${shown(t)}`, insert: `${prefix}${t.id}`, snippet: false, kind: 'terminal',
  filter: `${prefix}${t.id}${t.name ? ` ${t.name}` : ''}`, detail: detail || (t.name ? `${t.name}: ${t.id}` : t.id),
});
const word = (w: string, detail: string): Completion => ({ label: w, insert: w, snippet: false, detail, kind: 'word' });
const setting = (t: Term, what: string): Completion => ({ label: t.name ? `${t.id} (${t.name})` : t.id, insert: t.id, snippet: false, kind: 'setting', filter: t.id, detail: `the setting ${t.name || t.id}: ${what} read when the line runs` });

/** The levels for an output: on, off, and for one that dims a single "level %" with its number selected. */
export function levels(terms: Terms, output: string): Completion[] {
  const out: Completion[] = [
    { label: 'on', insert: 'on', snippet: false, detail: 'full on', kind: 'level' },
    { label: 'off', insert: 'off', snippet: false, detail: 'off', kind: 'level' },
  ];
  if (outputDims(terms, output)) out.push({ label: 'level %', insert: '${1:50}%', snippet: true, detail: 'a level from 0 to 100 %: type the number', filter: 'level %', kind: 'level' });
  return out;
}

/** A time: seconds, milliseconds or minutes (as snippets with the number selected), and the time settings. */
function times(terms: Terms): Completion[] {
  return [
    { label: 'seconds', insert: '${1:2}', snippet: true, detail: 'a number of seconds: type it', kind: 'unit' },
    { label: 'ms', insert: '${1:200} ms', snippet: true, detail: 'milliseconds (1000 ms = 1 second)', filter: 'ms milliseconds', kind: 'unit' },
    { label: 'min', insert: '${1:1} min', snippet: true, detail: 'minutes', filter: 'min minutes', kind: 'unit' },
    ...terms.timeSettings.map((t) => setting(t, 'a time')),
  ];
}
const units = (): Completion[] => [
  { label: 's', insert: 's', snippet: false, detail: 'seconds (a time without a unit is seconds too)', kind: 'unit' },
  { label: 'ms', insert: 'ms', snippet: false, detail: 'milliseconds (1000 ms = 1 second)', kind: 'unit' },
  { label: 'min', insert: 'min', snippet: false, detail: 'minutes', kind: 'unit' },
];

const NUM = String.raw`(?:\d+(?:\.\d*)?|\.\d+)`;
const re = (s: string) => new RegExp(s, 'i');
// a time slot, the text typed in it so far in group 1
const TIME_SLOTS = [
  re(String.raw`^\s*(?:wait|sleep)\s+(?!for\b)(\S*)$`),
  re(String.raw`^\s*wait\s*for\s+(\S*)$`),
  re(String.raw`^\s*fade\s+\S+\s+to\s+\S+\s+over\s+(\S*)$`),
  re(String.raw`^\s*(?:flicker|pulse)\s+\S+\s+for\s+(\S*)$`),
  re(String.raw`^\s*limit\s+\S+\s+runs?\s+per\s+(\S*)$`),
];
const AFTER_NUMBER = re(String.raw`^\s*(?:(?:wait\s*for|wait|sleep)|fade\s+\S+\s+to\s+\S+\s+over|(?:flicker|pulse)\s+\S+\s+for|limit\s+\S+\s+runs?\s+per)\s+${NUM}\s+[a-z]*$`);

const EFFECT_DETAIL: Record<string, string> = {
  off: 'the strip dark', fill: 'the whole strip in one colour', chase: 'a few lit pixels running along', rainbow: 'a moving rainbow (its own colours)',
  flash: 'on and off', fade: 'in from dark, then stays', flicker: 'like a failing bulb', comet: 'a head with a fading tail',
  sparkle: 'random pixels flash and fade', breathe: 'slowly up and down', fire: 'red, orange and yellow flames (its own colours)',
};
/** The pixel effects (each going on to the colours, unless it has its own), then the colours alone (a fill). */
export function pixelEffects(): Completion[] {
  return PIXEL_EFFECTS.map((e) => ({ label: e, insert: NO_COLOUR.includes(e) ? e : `${e} `, snippet: false, detail: EFFECT_DETAIL[e] || 'a pixel effect', kind: 'word' as const, retrigger: !NO_COLOUR.includes(e) }));
}
/** The named colours and an exact one (0xRRGGBB, with its digits selected). */
export function pixelColours(): Completion[] {
  return [
    ...PIXEL_COLOURS.map(([n, hex]): Completion => ({ label: n, insert: n, snippet: false, detail: `#${hex}`, kind: 'colour' })),
    { label: 'exact colour', insert: '0x${1:ff8000}', snippet: true, detail: '0x and six hex digits (red, green, blue): 0xff8000 is orange', filter: 'exact colour 0x', kind: 'colour' },
  ];
}

/** What fits after `before` (the line up to the cursor). */
export function completionsAt(before: string, terms: Terms = getTerms(), fleet: FleetBoard[] = getFleet()): Completion[] {
  const b = before.replace(/[\t  ]/g, ' ');
  if (b.includes('#')) return [];
  let m: RegExpExecArray | null;

  // tell <board> <effect>: the boards Studio knows and all, then that board's effects (fleet.ts)
  const tell = tellCompletions(b, fleet);
  if (tell) return tell;
  // sounds
  if ((m = /^\s*audio_(single|loop)\s*[=:]\s*(\S*)$/i.exec(b))) {
    const loop = m[1].toLowerCase() === 'loop';
    // a sound is its number (`audio_single = 2` plays 02/001-….mp3); the description is the hint
    const list: Completion[] = terms.sounds.map((s) => ({ label: String(s.n), insert: String(s.n), snippet: false, detail: s.description || `sound ${s.n}`, filter: `${s.n} ${s.description}`, kind: 'sound' }));
    if (!list.length) list.push({ label: 'sound number', insert: '${1:1}', snippet: true, detail: 'the sound\'s number, 1 to 99 (folder 02 is 2): type it', kind: 'sound' });
    if (loop) list.push(word('off', 'end the background sound'));
    return list;
  }
  // pixels = <effect> <colour>: first the effects (and the colours, which fill the strip), then the colours
  if ((m = /^\s*pixels\s*[=:]\s*(.*)$/i.exec(b))) {
    const typed = m[1];
    const w = /^(\S+)\s+(\S*)$/.exec(typed);
    if (w) {
      const e = w[1].toLowerCase();
      if (!PIXEL_EFFECTS.includes(e) || NO_COLOUR.includes(e)) return [];
      return pixelColours();
    }
    if (/\s/.test(typed.trim())) return [];
    return [...pixelEffects(), ...pixelColours()];
  }
  // a number in a time: its unit
  if (AFTER_NUMBER.test(b)) return units();
  // wait for: an input, or a time (`wait for 2` pauses too)
  if ((m = /^\s*wait\s*for\s+(\S*)$/i.exec(b))) {
    if (new RegExp(`^${NUM}$`).test(m[1])) return [];
    return [...terms.inputs.map((t) => terminal(t, '', `wait for a press on ${shown(t)}`)), ...times(terms)];
  }
  // wait: `for` and an input, or a time
  if ((m = TIME_SLOTS[0].exec(b))) {
    if (new RegExp(`^${NUM}$`).test(m[1])) return [];
    const inputs = /^sleep/i.test(b.trim()) ? [] : terms.inputs.map((t) => terminal(t, 'for ', `wait for a press on ${shown(t)}`));
    return [...inputs, ...times(terms)];
  }
  for (const slot of TIME_SLOTS.slice(2)) {
    if ((m = slot.exec(b))) return new RegExp(`^${NUM}$`).test(m[1]) ? [] : times(terms);
  }
  // limit: a number of runs, or a count setting
  if (/^\s*limit\s+\S*$/i.test(b)) return [{ label: 'runs', insert: '${1:3} runs per ${2:3 min}', snippet: true, detail: 'at most this many runs in a time', kind: 'word' }, ...terms.countSettings.map((t) => setting(t, 'a number of runs,'))];
  // the output of fade, flicker (dimmable only) and pulse (any)
  if ((m = /^\s*(fade|flicker|pulse)\s+(\S*)$/i.exec(b))) {
    const dimOnly = m[1].toLowerCase() !== 'pulse';
    return terms.outputs.filter((o) => !dimOnly || o.dims).map((o) => terminal(o));
  }
  if ((m = /^\s*fade\s+(\S+)\s+to\s+(\S*)$/i.exec(b))) return numberLevel(terms, m[1], m[2]) ?? levels(terms, m[1]);
  if (/^\s*fade\s+\S+\s+to\s+\S+\s+\S*$/i.test(b)) return [word('over', 'how long the fade takes')];
  if (/^\s*(flicker|pulse)\s+\S+\s+\S*$/i.test(b)) return [word('for', 'how long')];
  // <output> = level
  if ((m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*[=:]\s*(\S*)$/.exec(b)) && !/^(wait|effect|sleep|limit|pixels)$/i.test(m[1]) && !/^(wait|effect|sleep|limit)/i.test(m[1])) return numberLevel(terms, m[1], m[2]) ?? levels(terms, m[1]);
  // the start of a line: its kinds, and setting an output
  if (/^\s*[A-Za-z_]*$/.test(b)) {
    const sets: Completion[] = terms.outputs.map((o) => ({
      label: `${shown(o)} =`, insert: `${o.id} = `, snippet: false, kind: 'terminal', retrigger: true, filter: `${o.id}${o.name ? ` ${o.name}` : ''}`,
      detail: o.dims ? 'set it: on, off or a level' : 'set it: on or off',
    }));
    return [...lineStarts(), ...sets];
  }
  return [];
}

/** A number typed after `=` or `to`: its percent sign, for an output that dims; null when nothing is typed yet. */
function numberLevel(terms: Terms, output: string, typed: string): Completion[] | null {
  if (!typed) return null;
  if (!/^\d+(\.\d+)?$/.test(typed)) return null;
  if (!outputDims(terms, output)) return [];
  return [{ label: `${typed}%`, insert: `${typed}%`, snippet: false, detail: `${typed} percent`, kind: 'level' }];
}


/** Hover help for a name given to a terminal or a setting (`lamp`, `valve_time`), or null. */
export function nameHover(word: string, terms: Terms = getTerms()): string | null {
  const w = word.toLowerCase();
  const out = terms.outputs.find((t) => t.name?.toLowerCase() === w);
  if (out) return `${out.name} is the name given to ${out.id}: \`${w} = on\` works like \`${out.id} = on\`.`;
  const inp = terms.inputs.find((t) => t.name?.toLowerCase() === w);
  if (inp) return `${inp.name} is the name given to ${inp.id}: \`wait for ${w}\` works like \`wait for ${inp.id}\`.`;
  const set = [...terms.timeSettings, ...terms.countSettings].find((t) => t.name && t.id.toLowerCase() === w);
  if (set) return `${set.id} is this board's name for the setting ${set.name}.`;
  return null;
}
