// An effect script's look: an icon and a colour for the whole script and for each effect, carried in ordinary
// comments so they travel with the script to the board and back (the board's checker skips comments).
//
//   # icon: skull            the script's defaults: in the lines above the first effect, apart from the
//   # color: purple          comments that sit directly on top of it (a blank line between them)
//
//   # icon: splat            an effect's own: the comments directly above its `effect …:` line
//   # color: #c00000
//   effect scare:
//
// An effect without its own takes the script's; a script without its own (the library list) takes its first
// effect's; an unknown or missing icon is `play` (icons.tsx). Also: the expected length of an effect's run, from
// its sleeps, fades, flickers and pulses (settings named as times read from the board), for the run bar.

export interface Look { icon?: string; color?: string }
export interface ScriptLook { script: Look; effects: { name: string; key: string; look: Look }[] }

const LOOK_LINE = /^\s*#\s*(icon|colou?r)\s*[:=]\s*(.*?)\s*$/i;
const COMMENT = /^\s*#/;
const BLANK = /^[\t   ]*$/;

/** The lines of a text with their endings kept apart ("\n", "\r\n", "\r", or "" for the last). */
function split(text: string): [string, string][] {
  const out: [string, string][] = [];
  const re = /\r\n|\n|\r/g;
  let at = 0, m: RegExpExecArray | null;
  while ((m = re.exec(text))) { out.push([text.slice(at, m.index), m[0]]); at = m.index + m[0].length; }
  if (at < text.length || !out.length) out.push([text.slice(at), '']);
  return out;
}

/** An effect header's name as the board's checker reads it (show-script-golden README): `effect porch light:` is
 * "porch light", `effect1:` is "effect1"; null for any other line. */
export function effectName(raw: string): string | null {
  const body = raw.split('#')[0].replace(/[\t  ]/g, ' ').trim();
  const m = /^effect(.*)$/i.exec(body);
  if (!m) return null;
  const r = m[1];
  const part = r === '' || r[0] === ' ' || r[0] === ':' ? r : body;
  const i = part.indexOf(':');
  return (i >= 0 ? part.slice(0, i) : part).trim();
}

/** An effect's name as the board reports it (lower case, spaces as one, `_` as a space), for matching. */
export const nameKey = (n: string) => String(n || '').toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ').trim();

/** The value of a look line: an icon name (lower case word) or a colour (a name, or #rgb / #rrggbb). */
function lookValue(kind: string, v: string): string | undefined {
  if (/^icon$/i.test(kind)) {
    const m = /^[A-Za-z0-9_-]+/.exec(v);
    return m ? m[0].toLowerCase() : undefined;
  }
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})\b/i.exec(v);
  if (hex) return `#${hex[1].toLowerCase()}`;
  const m = /^[A-Za-z]+/.exec(v);
  return m ? m[0].toLowerCase() : undefined;
}

const keyOf = (kind: string): keyof Look => (/^icon$/i.test(kind) ? 'icon' : 'color');

/** The comment lines directly above line `i` (no blank line between): their first index. */
function attachedStart(lines: [string, string][], i: number): number {
  let j = i;
  while (j > 0 && COMMENT.test(lines[j - 1][0])) j--;
  return j;
}

/** The look lines in lines[from, to): the first of each kind for the script, the last for an effect. */
function looksIn(lines: [string, string][], from: number, to: number, last: boolean): Look {
  const out: Look = {};
  for (let i = from; i < to; i++) {
    const m = LOOK_LINE.exec(lines[i][0]);
    if (!m) continue;
    const k = keyOf(m[1]);
    const v = lookValue(m[1], m[2]);
    if (v && (last || out[k] === undefined)) out[k] = v;
  }
  return out;
}

/** Every look a script sets: the script's own and each effect's own (nothing filled in from the other). */
export function parseLook(text: string): ScriptLook {
  const lines = split(text || '');
  const heads = lines.map(([raw], i) => [i, effectName(raw)] as const).filter(([, n]) => n !== null) as [number, string][];
  const first = heads.length ? heads[0][0] : lines.length;
  const scriptTo = heads.length ? attachedStart(lines, first) : lines.length;
  return {
    script: looksIn(lines, 0, scriptTo, false),
    effects: heads.map(([i, name]) => ({ name, key: nameKey(name), look: looksIn(lines, attachedStart(lines, i), i, true) })),
  };
}

/** An effect's look with the script's filling in what it does not set. `effect` null: the script's look (with its
 * first effect's filling in). Names may be unknown (icons.tsx falls back to `play`). */
export function lookOf(text: string | undefined, effect?: string | null): Look {
  const p = parseLook(text || '');
  if (effect === undefined || effect === null) {
    const f = p.effects[0]?.look || {};
    return { icon: p.script.icon ?? f.icon, color: p.script.color ?? f.color };
  }
  const e = p.effects.find((x) => x.key === nameKey(effect))?.look || {};
  return { icon: e.icon ?? p.script.icon, color: e.color ?? p.script.color };
}

/** The text with the script's (`effect` null) or one effect's look line of `key` set to `value` (null removes
 * it). Only that one comment line is added, changed or removed; every other line stays as written. */
export function setLook(text: string, effect: string | null, key: keyof Look, value: string | null): string {
  const lines = split(text || '');
  const eol = lines.find(([, e]) => e)?.[1] || '\n';
  const kindOk = (raw: string) => { const m = LOOK_LINE.exec(raw); return !!m && keyOf(m[1]) === key; };
  const line = value ? `# ${key}: ${value}` : null;
  const heads = lines.map(([raw], i) => [i, effectName(raw)] as const).filter(([, n]) => n !== null) as [number, string][];
  let from: number, to: number, insertAt: number, pick: 'first' | 'last', separate = false;
  if (effect === null) {
    const first = heads.length ? heads[0][0] : lines.length;
    from = 0;
    to = heads.length ? attachedStart(lines, first) : lines.length;
    insertAt = 0;
    pick = 'first';
    // the first effect's own comments start at the top: the new line needs a blank line under it, or it would
    // count as that effect's
    separate = heads.length > 0 && to === 0;
  } else {
    const h = heads.find(([, n]) => nameKey(n) === nameKey(effect));
    if (!h) return text;
    to = h[0];
    from = attachedStart(lines, to);
    insertAt = to;
    pick = 'last';
  }
  let at = -1;
  for (let i = from; i < to; i++) if (kindOk(lines[i][0])) { if (pick === 'first') { at = i; break; } at = i; }
  const out = [...lines];
  if (at >= 0) {
    if (line === null) out.splice(at, 1);
    else out[at] = [line, out[at][1]];
  } else if (line !== null) {
    // a text whose last line has no ending gets one before anything is put after it
    if (insertAt > 0 && !out[insertAt - 1][1]) out[insertAt - 1] = [out[insertAt - 1][0], eol];
    const add: [string, string][] = [[line, eol]];
    if (separate) add.push(['', eol]);
    if (!text) return `${line}${eol}`;
    out.splice(insertAt, 0, ...add);
  } else return text;
  return out.map(([l, e], i) => l + (e || (i < out.length - 1 ? eol : ''))).join('');
}

// ---------------------------------------------------------------- how long a run takes

const UNITS: Record<string, number> = { ms: 1, s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000, min: 60000, mins: 60000, minute: 60000, minutes: 60000 };

/** A time as a line writes it (`2.5`, `200 ms`, `3 min`, or a setting named for a time, in ms), in ms; null
 * when it cannot be known (a setting the board did not give). */
export function timeMs(t: string, settings: Record<string, number> = {}): number | null {
  const s = t.trim().toLowerCase();
  const m = /^(\d+(?:\.\d+)?)\s*([a-z]*)$/.exec(s);
  if (m) {
    const unit = m[2] ? UNITS[m[2]] : 1000;
    return unit === undefined ? null : Number(m[1]) * unit;
  }
  if (/^[a-z_][a-z0-9_]*$/.test(s)) {
    const v = settings[s];
    return typeof v === 'number' && isFinite(v) ? v : null;
  }
  return null;
}

/** The board's settings as numbers by lower-case key (get_params `values`), for timeMs. */
export function settingsOf(values: { key: string; value: unknown }[] | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values || []) {
    const n = typeof v.value === 'number' ? v.value : typeof v.value === 'string' && /^-?\d+(\.\d+)?$/.test(v.value) ? Number(v.value) : NaN;
    if (isFinite(n)) out[String(v.key).toLowerCase()] = n;
  }
  return out;
}

/** The setting names an effect's times use (to know whether the board's settings are needed). */
export function settingNames(text: string): string[] {
  const out = new Set<string>();
  for (const [raw] of split(text || '')) {
    const b = raw.split('#')[0].trim().toLowerCase();
    const m = /^(?:sleep\s+|.*\bover\s+|(?:flicker|pulse)\s+\S+\s+for\s+)([a-z_][a-z0-9_]*)$/.exec(b);
    if (m && !UNITS[m[1]]) out.add(m[1]);
  }
  return [...out];
}

/** How long a run of the effect takes, in ms, from the line after its first `wait for` to its last line and on
 * through the lines above that `wait for` (they run again before it waits): the sleeps, fades and flickers one
 * after another, and a pulse that outlasts them. null when it cannot be known (another `wait for` part way, a
 * setting the board did not give, no such effect, an effect with no `wait for`: it goes round by itself). */
export function runLengthMs(text: string | undefined, effect: string, settings: Record<string, number> = {}): number | null {
  const lines = split(text || '');
  let inside = false, started = false, waited = false, t = 0, end = 0, above = 0, aboveEnd = 0;
  for (const [raw] of lines) {
    const n = effectName(raw);
    if (n !== null) {
      if (inside) break;
      inside = nameKey(n) === nameKey(effect);
      continue;
    }
    if (!inside) continue;
    started = true;
    const b = raw.split('#')[0].replace(/[\t  ]/g, ' ').trim().toLowerCase();
    if (!b) continue;
    let m: RegExpExecArray | null;
    if (/^wait\s*for\b/.test(b)) {
      if (waited) return null; // a press part way: how long it waits cannot be known
      waited = true;
      above = t; aboveEnd = end; // the lines above it, run again after the last line
      t = 0; end = 0; // the run starts when it leaves its first wait for
      continue;
    }
    let d: number | null = 0;
    if ((m = /^sleep\s+(.+)$/.exec(b))) d = timeMs(m[1], settings);
    else if ((m = /^fade\s+.+?\s+over\s+(.+)$/.exec(b))) d = timeMs(m[1], settings);
    else if ((m = /^flicker\s+\S+\s+for\s+(.+)$/.exec(b))) d = timeMs(m[1], settings);
    else if ((m = /^pulse\s+\S+\s+for\s+(.+)$/.exec(b))) {
      const p = timeMs(m[1], settings);
      if (p === null) return null;
      end = Math.max(end, t + p);
      continue;
    }
    if (d === null) return null;
    t += d;
  }
  if (!started || !waited) return null;
  return Math.max(t + above, end, t + aboveEnd);
}
