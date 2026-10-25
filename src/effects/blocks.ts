// @ts-nocheck (a faithful port of tested JavaScript)
// Show-script blocks (SHOW-SCRIPT.md SS-E2, SS-E3): one block per line kind, an effect block holds its
// lines. Blocks are a view of the text: every block keeps its line exactly as written (and its line
// ending); a block whose fields were not changed gives that text back unchanged, so text → blocks → text
// is the identical text. A changed block writes its line in the plain form, keeping its indentation and
// its comment. The board's checker (the Rust crate, through the app) decides what is right; the blocks
// only sort lines into kinds.
// Ported from the earlier desktop app's script-blocks.js; the regexes keep their no-break-space characters.
/* eslint-disable */
import * as Blockly from 'blockly';
import { registerFields } from './fields';
import { splitPixels } from './words';

const COLOURS = { effect: 30, wait: 200, set: 120, time: 260, sound: 330, pixels: 290, tell: 175, note: '#6d6d6d' };
const defs = [
  { type: 'ps_effect', message0: 'effect %1 :', args0: [{ type: 'field_input', name: 'NAME', text: 'my effect' }],
    message1: '%1', args1: [{ type: 'input_statement', name: 'LINES' }], previousStatement: null, nextStatement: null, colour: COLOURS.effect,
    tooltip: 'An effect: its lines run top to bottom, then it starts again at its first "wait for".' },
  { type: 'ps_wait', message0: 'wait for %1', args0: [{ type: 'field_ps_choice', name: 'INPUT', kind: 'input', text: 'trig1' }], previousStatement: null, nextStatement: null, colour: COLOURS.wait,
    tooltip: 'Waits until the input is pressed (held for the debounce time), after it was released.' },
  { type: 'ps_set', message0: '%1 = %2', args0: [{ type: 'field_ps_choice', name: 'TARGET', kind: 'output', text: 'out1' }, { type: 'field_ps_choice', name: 'LEVEL', kind: 'level', text: 'on' }], previousStatement: null, nextStatement: null, colour: COLOURS.set,
    tooltip: 'Sets an output: on, off or a percentage (out1-out4 and dmx channels dim; rly and cc are on / off).' },
  { type: 'ps_sleep', message0: 'wait %1', args0: [{ type: 'field_ps_popup', name: 'TIME', kind: 'time', text: '1' }], previousStatement: null, nextStatement: null, colour: COLOURS.time,
    tooltip: 'Waits this long: seconds, or with a unit (200 ms, 3 min).' },
  { type: 'ps_fade', message0: 'fade %1 to %2 over %3', args0: [{ type: 'field_ps_choice', name: 'TARGET', kind: 'dimmable', text: 'out1' }, { type: 'field_ps_choice', name: 'LEVEL', kind: 'level', text: '0%' }, { type: 'field_ps_popup', name: 'TIME', kind: 'time', text: '2' }], previousStatement: null, nextStatement: null, colour: COLOURS.time,
    tooltip: 'Goes smoothly to a level.' },
  { type: 'ps_flicker', message0: 'flicker %1 for %2', args0: [{ type: 'field_ps_choice', name: 'TARGET', kind: 'dimmable', text: 'out1' }, { type: 'field_ps_popup', name: 'TIME', kind: 'time', text: '3' }], previousStatement: null, nextStatement: null, colour: COLOURS.time,
    tooltip: 'Flickers like a candle or a failing bulb, then gives the level back.' },
  { type: 'ps_pulse', message0: 'pulse %1 for %2', args0: [{ type: 'field_ps_choice', name: 'TARGET', kind: 'output', text: 'cc1' }, { type: 'field_ps_popup', name: 'TIME', kind: 'time', text: '0.2' }], previousStatement: null, nextStatement: null, colour: COLOURS.set,
    tooltip: 'Turns an output on now and off after the time; the next line does not wait.' },
  { type: 'ps_limit', message0: 'limit %1 runs per %2', args0: [{ type: 'field_ps_popup', name: 'RUNS', kind: 'runs', text: '3' }, { type: 'field_ps_popup', name: 'TIME', kind: 'time', text: '3 min' }], previousStatement: null, nextStatement: null, colour: COLOURS.wait,
    tooltip: 'At most this many runs in a window that starts at the first run.' },
  { type: 'ps_audio_single', message0: 'play sound %1 once', args0: [{ type: 'field_ps_choice', name: 'SOUND', kind: 'sound', text: '1' }], previousStatement: null, nextStatement: null, colour: COLOURS.sound,
    tooltip: 'Plays sound N once: the one file in the card\'s folder NN (NN/001-….mp3).' },
  { type: 'ps_audio_loop', message0: 'play sound %1 over and over', args0: [{ type: 'field_ps_choice', name: 'SOUND', kind: 'loop', text: '1' }], previousStatement: null, nextStatement: null, colour: COLOURS.sound,
    tooltip: 'Plays a sound over and over, until another sound line.' },
  { type: 'ps_audio_stop', message0: 'stop the sound', previousStatement: null, nextStatement: null, colour: COLOURS.sound, tooltip: 'Stops the sound.' },
  { type: 'ps_audio_volume', message0: 'sound volume %1', args0: [{ type: 'field_ps_choice', name: 'VOLUME', kind: 'volume', text: '60%' }], previousStatement: null, nextStatement: null, colour: COLOURS.sound,
    tooltip: 'How loud the script\'s sounds play from here on: 0% (silent) to 100%.' },
  { type: 'ps_pixels', message0: 'light the pixels %1 %2', args0: [{ type: 'field_ps_choice', name: 'EFFECT', kind: 'pixeleffect', text: 'rainbow' }, { type: 'field_ps_choice', name: 'COLOUR', kind: 'pixelcolour', text: '' }], previousStatement: null, nextStatement: null, colour: COLOURS.pixels,
    tooltip: 'Lights the LED strip with an effect and a colour until another pixels line. rainbow and fire have their own colours. To colour every light your own way, write an LED pattern in Your library.' },
  // tell <board> <effect> / tell <board> <setting> = <value> (SHOW-SCRIPT.md §11): the firmware's own block (web/blocks.js
  // ps_tell), plain text fields since the other board's effects and settings are checked there, not here
  { type: 'ps_tell', message0: 'tell %1 %2', args0: [{ type: 'field_input', name: 'BOARD', text: 'porch' }, { type: 'field_input', name: 'DO', text: 'blackout' }], previousStatement: null, nextStatement: null, colour: COLOURS.tell,
    tooltip: 'Tells another board (its network name, or all) to start one of its effects, or to use a setting: blackout, or pixel_speed = 150. The line does not wait.' },
  { type: 'ps_comment', message0: '# %1', args0: [{ type: 'field_input', name: 'TEXT', text: '' }], previousStatement: null, nextStatement: null, colour: COLOURS.note,
    tooltip: 'A comment or a blank line: the board skips it.' },
  { type: 'ps_raw', message0: 'line %1', args0: [{ type: 'field_input', name: 'TEXT', text: '' }], previousStatement: null, nextStatement: null, colour: 0,
    tooltip: 'A line the blocks do not know: Check says what is wrong with it.' },
];
const FIELDS = {
  ps_effect: ['NAME'], ps_wait: ['INPUT'], ps_set: ['TARGET', 'LEVEL'], ps_sleep: ['TIME'], ps_fade: ['TARGET', 'LEVEL', 'TIME'],
  ps_flicker: ['TARGET', 'TIME'], ps_pulse: ['TARGET', 'TIME'], ps_limit: ['RUNS', 'TIME'], ps_audio_single: ['SOUND'], ps_audio_loop: ['SOUND'], ps_audio_stop: [], ps_audio_volume: ['VOLUME'], ps_pixels: ['EFFECT', 'COLOUR'], ps_tell: ['BOARD', 'DO'], ps_comment: ['TEXT'], ps_raw: ['TEXT'],
};

// ---------------------------------------------------------------- one line → kind and fields

// the settings a line may name for a time (SHOW-SCRIPT.md SS-G6)
const TIME_SETTINGS = ['out1_on_ms', 'out2_on_ms', 'out3_on_ms', 'recover_time_ms', 'cooldown_ms', 'trigger_out_pulse_ms', 'role_pulse_ms'];
const INPUTS = ['trig1', 'trig2', 'user1', 'user2', 'user3'];
const isTime = (v) => /^[0-9.]/.test(v) || TIME_SETTINGS.includes(v.toLowerCase());

// a keyword at the start, case and spaces inside it ignored (as the board reads it)
function kw(s, word) {
  let i = 0;
  for (const ch of word) {
    while (s[i] === ' ') i++;
    if ((s[i] || '').toLowerCase() !== ch) return null;
    i++;
  }
  return s.slice(i);
}
// splits a line into its indentation, its body and its comment (with the spaces before it)
function parts(raw) {
  const norm = raw.replace(/[\t  ]/g, ' ');
  const ind = norm.match(/^ */)[0].length;
  const hash = raw.indexOf('#');
  let body = hash >= 0 ? raw.slice(ind, hash) : raw.slice(ind);
  let comment = '';
  if (hash >= 0) {
    const b = body.replace(/[ \t  ]+$/, '');
    comment = raw.slice(ind + b.length);
    body = b;
  } else {
    const b = body.replace(/[ \t  ]+$/, '');
    comment = body.slice(b.length); // trailing spaces
    body = b;
  }
  return { indent: raw.slice(0, ind), body, comment };
}
export function parse(raw) {
  const p = parts(raw);
  const s = p.body.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
  const low = s.replace(/[\t  ]/g, ' ');
  let r;
  if (!low.trim()) return { type: 'ps_comment', f: { TEXT: (p.comment.trim().replace(/^#\s?/, '')) }, p };
  if ((r = kw(low, 'effect')) !== null) {
    const plain = r === '' || r[0] === ' ' || r[0] === ':';
    const part = plain ? r : low;
    const i = part.indexOf(':');
    return { type: 'ps_effect', f: { NAME: (i >= 0 ? part.slice(0, i) : part).trim() }, p, colon: i >= 0, tail: i >= 0 ? part.slice(i + 1) : '' };
  }
  // tell <board> <effect> / tell <board> <setting> = <value>: before the output line (it may hold "="), as web/blocks.js
  if ((r = kw(low, 'tell')) !== null) {
    const m = r.match(/^ +([^ =:]+) +(\S.*)$/);
    if (m) return { type: 'ps_tell', f: { BOARD: m[1], DO: m[2].trim() }, p };
    // the board reads any line that starts with the word tell as a tell line (M-tellform), never an output
    if (r === '' || /^[ =:]/.test(r)) return { type: 'ps_raw', f: { TEXT: s }, p };
  }
  // wait <time> and wait for <time> are a time block, wait for <input> an input block (after wait for, a time
  // starts with a digit or is a time setting; after a bare wait, any word but an input; the board decides names)
  if ((r = kw(low, 'wait')) !== null) {
    const rest = kw(r, 'for');
    const v = (rest !== null ? rest : r).trim();
    if (isTime(v) || (rest === null && v && !INPUTS.includes(v.toLowerCase()))) return { type: 'ps_sleep', f: { TIME: v }, p };
    if (rest !== null) return { type: 'ps_wait', f: { INPUT: v }, p };
  }
  if ((r = kw(low, 'audio_stop')) !== null && !r.trim()) return { type: 'ps_audio_stop', f: {}, p };
  for (const [w, type] of [['audio_single', 'ps_audio_single'], ['audio_loop', 'ps_audio_loop']]) {
    if ((r = kw(low, w)) !== null) {
      const v = r.trim();
      if (v === '' || v[0] === '=' || v[0] === ':') return { type, f: { SOUND: v.slice(1).trim() }, p };
    }
  }
  if ((r = kw(low, 'audio_volume')) !== null) {
    const v = r.trim();
    if (v === '' || v[0] === '=' || v[0] === ':') return { type: 'ps_audio_volume', f: { VOLUME: v.slice(1).trim() }, p };
  }
  // pixels = <effect> <colour> (SHOW-SCRIPT.md SS-X1); `pixels red` without "=" is left for Check to explain
  if ((r = kw(low, 'pixels')) !== null) {
    const v = r.trim();
    if (v === '' || v[0] === '=' || v[0] === ':') {
      const x = splitPixels(v.slice(1));
      return { type: 'ps_pixels', f: { EFFECT: x.effect, COLOUR: x.colour }, p };
    }
  }
  if ((r = kw(low, 'sleep')) !== null) return { type: 'ps_sleep', f: { TIME: r.trim() }, p };
  if ((r = kw(low, 'fade')) !== null) {
    const m = r.match(/^\s*([A-Za-z_]+\d*)\s*[Tt][Oo]\s*(.*?)\s*[Oo][Vv][Ee][Rr]\s*(.*)$/);
    if (m && m[1] && m[2] && m[3]) return { type: 'ps_fade', f: { TARGET: m[1], LEVEL: m[2], TIME: m[3].trim() }, p };
  }
  if ((r = kw(low, 'flicker')) !== null) {
    const m = r.match(/^\s*([A-Za-z_]+\d*)\s*[Ff][Oo][Rr]\s*(.+)$/);
    if (m) return { type: 'ps_flicker', f: { TARGET: m[1], TIME: m[2].trim() }, p };
  }
  if ((r = kw(low, 'pulse')) !== null) {
    const m = r.match(/^\s*([A-Za-z_]+\d*)\s*[Ff][Oo][Rr]\s*(.+)$/);
    if (m) return { type: 'ps_pulse', f: { TARGET: m[1], TIME: m[2].trim() }, p };
  }
  if ((r = kw(low, 'limit')) !== null) {
    const m = r.match(/^\s*(\S+)\s+[Rr][Uu][Nn][Ss]?\s+[Pp][Ee][Rr]\s+(.+)$/);
    if (m) return { type: 'ps_limit', f: { RUNS: m[1], TIME: m[2].trim() }, p };
  }
  const eq = low.search(/[=:]/);
  if (eq > 0 && /^[A-Za-z_]+\d*$/.test(low.slice(0, eq).replace(/ /g, '')) && !/^\s*wait/i.test(low)) {
    return { type: 'ps_set', f: { TARGET: low.slice(0, eq).trim(), LEVEL: low.slice(eq + 1).trim() }, p };
  }
  return { type: 'ps_raw', f: { TEXT: s }, p };
}

// the plain form of a line from its fields (only for a block that was changed or added)
function lineOf(type, f) {
  switch (type) {
    case 'ps_effect': return `effect ${f.NAME}:`;
    case 'ps_wait': return `wait for ${f.INPUT}`;
    case 'ps_set': return `${f.TARGET} = ${f.LEVEL}`;
    case 'ps_sleep': return `wait ${f.TIME}`;
    case 'ps_fade': return `fade ${f.TARGET} to ${f.LEVEL} over ${f.TIME}`;
    case 'ps_flicker': return `flicker ${f.TARGET} for ${f.TIME}`;
    case 'ps_pulse': return `pulse ${f.TARGET} for ${f.TIME}`;
    case 'ps_limit': return `limit ${f.RUNS} ${f.RUNS === '1' ? 'run' : 'runs'} per ${f.TIME}`;
    case 'ps_audio_single': return `audio_single = ${f.SOUND}`;
    case 'ps_audio_loop': return `audio_loop = ${f.SOUND}`;
    case 'ps_audio_stop': return 'audio_stop';
    case 'ps_audio_volume': return `audio_volume = ${f.VOLUME}`;
    case 'ps_pixels': return `pixels = ${[f.EFFECT, f.COLOUR].map((x) => (x || '').trim()).filter(Boolean).join(' ')}`.trimEnd();
    case 'ps_tell': return `tell ${(f.BOARD || '').trim()} ${(f.DO || '').trim()}`.trimEnd();
    case 'ps_comment': return f.TEXT ? `# ${f.TEXT}` : '';
    default: return f.TEXT || '';
  }
}

// ---------------------------------------------------------------- text ⇄ blocks

// lines with their own endings ("\n", "\r\n", "\r" or "" for the last)
function splitLines(text) {
  const out = [];
  const re = /\r\n|\n|\r/g;
  let at = 0, m;
  while ((m = re.exec(text))) { out.push([text.slice(at, m.index), m[0]]); at = m.index + m[0].length; }
  if (at < text.length) out.push([text.slice(at), '']);
  return out;
}

let lastEol = '\n';
function fieldsOf(b) {
  const f = {};
  for (const k of FIELDS[b.type]) f[k] = b.getFieldValue(k);
  return f;
}
// a chain of block states, each one's `next` the following
function chain(states) {
  for (let i = states.length - 2; i >= 0; i--) states[i].next = { block: states[i + 1] };
  return states[0];
}

export function textToBlocks(ws, text) {
  const lines = splitLines(text);
  lastEol = lines.find(([, e]) => e)?.[1] || '\n';
  const tops = [];
  let effect = null;
  // blank lines get no block: each one rides along with the block before it (or, at the very top, the
  // block after it) and is written back with that block, so the text still comes back unchanged
  let prev = null, before = [];
  const isBlank = (raw) => !raw.replace(/[\t \u00a0\u202f]/g, '');
  const all = [];
  const anyText = lines.some(([r]) => !isBlank(r));
  for (const [raw, eol] of lines) {
    if (isBlank(raw) && anyText) {
      if (prev) prev.after.push([raw, eol]); else before.push([raw, eol]);
      continue;
    }
    const x = parse(raw);
    const d = { raw, eol, f: x.f, before, after: [] };
    before = [];
    const st = { type: x.type, fields: x.f };
    all.push([st, d]);
    prev = d;
    if (x.type === 'ps_effect') { effect = { st, lines: [] }; tops.push(effect); }
    else if (effect) effect.lines.push(st);
    else tops.push({ st, lines: null });
  }
  for (const [st, d] of all) {
    if (!d.before.length) delete d.before;
    if (!d.after.length) delete d.after;
    st.data = JSON.stringify(d);
  }
  const states = tops.map((t) => {
    if (t.lines && t.lines.length) t.st.inputs = { LINES: { block: chain(t.lines) } };
    return t.st;
  });
  const top = states.length ? chain(states) : null;
  if (top) { top.x = 16; top.y = 16; }
  Blockly.Events.disable();
  try {
    ws.clear();
    Blockly.serialization.workspaces.load(top ? { blocks: { languageVersion: 0, blocks: [top] } } : {}, ws);
  } finally {
    Blockly.Events.enable();
  }
}

function emit(b, inside, out) {
  let d = null;
  try { d = b.data ? JSON.parse(b.data) : null; } catch { d = null; }
  const f = fieldsOf(b);
  const same = d && Object.keys(f).every((k) => f[k] === d.f[k]);
  let line;
  if (same) line = d.raw;
  else {
    const p = d ? parts(d.raw) : { indent: inside && b.type !== 'ps_effect' ? '  ' : '', comment: '' };
    const body = lineOf(b.type, f);
    const keepComment = b.type !== 'ps_comment' && p.comment.trim().startsWith('#') ? p.comment : '';
    line = (body || keepComment ? (b.type === 'ps_effect' ? '' : (p.indent || (inside ? '  ' : ''))) : '') + body + keepComment;
  }
  for (const x of d?.before || []) out.push(x);
  out.push([line, d ? d.eol : lastEol]);
  for (const x of d?.after || []) out.push(x);
}

export function blocksToText(ws) {
  const out = [];
  const tops = ws.getTopBlocks(true);
  for (const t of tops) {
    for (let b = t; b; b = b.getNextBlock()) {
      emit(b, false, out);
      if (b.type === 'ps_effect') {
        for (let c = b.getInputTargetBlock('LINES'); c; c = c.getNextBlock()) emit(c, true, out);
      }
    }
  }
  // every line ends as it did; a line that had no ending (the last) gets one when lines follow it
  let s = '';
  out.forEach(([line, eol], i) => { s += line + (eol || (i < out.length - 1 ? lastEol : '')); });
  return s;
}

// The block that holds a 1-based line of the text blocksToText writes (a blank line belongs to the block it rides
// with): the blocks view selects it when a checker message is clicked. null when no block holds that line.
export function blockIdForLine(ws, line) {
  let n = 0;
  let found = null;
  const visit = (b) => {
    if (found) return;
    let d = null;
    try { d = b.data ? JSON.parse(b.data) : null; } catch { d = null; }
    const own = n + (d?.before?.length || 0) + 1;
    n = own + (d?.after?.length || 0);
    if (line >= own - (d?.before?.length || 0) && line <= n) found = b.id;
  };
  for (const t of ws.getTopBlocks(true)) {
    for (let b = t; b && !found; b = b.getNextBlock()) {
      visit(b);
      if (b.type === 'ps_effect') {
        for (let c = b.getInputTargetBlock('LINES'); c && !found; c = c.getNextBlock()) visit(c);
      }
    }
  }
  return found;
}

export const TOOLBOX = {
  kind: 'flyoutToolbox',
  contents: [
    { kind: 'block', type: 'ps_effect' },
    { kind: 'block', type: 'ps_wait' },
    { kind: 'block', type: 'ps_set' },
    { kind: 'block', type: 'ps_sleep' },
    { kind: 'block', type: 'ps_fade' },
    { kind: 'block', type: 'ps_flicker' },
    { kind: 'block', type: 'ps_pulse' },
    { kind: 'block', type: 'ps_limit' },
    { kind: 'block', type: 'ps_audio_single' },
    { kind: 'block', type: 'ps_audio_loop' },
    { kind: 'block', type: 'ps_audio_stop' },
    { kind: 'block', type: 'ps_audio_volume' },
    { kind: 'block', type: 'ps_pixels' },
    { kind: 'block', type: 'ps_tell' },
    { kind: 'block', type: 'ps_comment' },
  ],
};

let defined = false;
export function defineBlocks() {
  if (defined) return;
  defined = true;
  registerFields();
  Blockly.defineBlocksWithJsonArray(defs);
}
