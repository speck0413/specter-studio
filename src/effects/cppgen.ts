// An effect script as C++ for the firmware's beginner layer (Proptroller.h): each effect becomes one
// `prop.when(TRIG1)...` sequence. Timing matches the script: steps start together unless a wait() moves the
// time on, so `wait T` (or the older `sleep T`) is `.wait(T)` and a fade (which takes its time in a script) is followed by `.wait(T)`.
// Lines the beginner layer has no step for (flicker, DMX, looping a named sound, a second wait for, the advanced
// lines: limit, pulse, a time kept as a setting, a sound line above the first wait for) become comments, so
// nothing is silently dropped.

const OUT = /^(out[1-4]|rly[12]|cc[12])$/;
const IN = /^(trig[12]|user[1-3])$/;

function norm(line: string) {
  return line
    .replace(/[\t  ]/g, ' ')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/#.*$/, '')
    .trimEnd()
    .replace(/\.$/, '')
    .trim();
}

/** "2.5", "200 ms", "3 min" -> a Duration expression, or null. */
export function duration(t: string): string | null {
  const m = t.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|second|seconds|min|mins|minute|minutes)?$/);
  if (!m) return null;
  const n = m[1];
  const u = m[2] || 's';
  if (u === 'ms') return `milliseconds(${Math.round(Number(n))})`;
  if (u.startsWith('min')) return `minutes(${n})`;
  return `seconds(${n})`;
}

export function percent(v: string): number | null {
  const s = v.trim().toLowerCase();
  if (s === 'on') return 100;
  if (s === 'off') return 0;
  const m = s.match(/^(\d+(?:\.\d+)?)\s*%$/);
  return m ? Number(m[1]) : null;
}

function step(line: string): string | null {
  const s = line.toLowerCase();
  let m: RegExpMatchArray | null;
  if ((m = s.match(/^sleep\s*(.+)$/)) || (m = s.match(/^wait\s*(?:for\s*)?(\d.*)$/))) {
    const d = duration(m[1]);
    return d && `.wait(${d})`;
  }
  if ((m = s.match(/^fade\s*([a-z]+\d+)\s*to\s*(.+?)\s*over\s*(.+)$/)) && OUT.test(m[1]) && m[1].startsWith('out')) {
    const p = percent(m[2]);
    const d = duration(m[3]);
    return p !== null && d ? `.fadeTo(${m[1].toUpperCase()}, percent(${p}), ${d}).wait(${d})` : null;
  }
  if ((m = line.match(/^audio_single\s*[=:]\s*["']?(\d+)/i))) return `.playSound(${Number(m[1])})`;
  if (/^audio_stop$/.test(s.replace(/ /g, ''))) return '.stopSound()';
  // audio_volume = N% / off: the player's 0-30, halves up (as the board maps it)
  if ((m = s.match(/^audio_volume\s*[=:]\s*(.+)$/))) {
    const p = m[1].trim() === '0' ? 0 : percent(m[1]);
    return p !== null && p <= 100 ? `.setVolume(${Math.floor((p * 30) / 100 + 0.5)})` : null;
  }
  if ((m = s.match(/^([a-z]+\d+)\s*[=:]\s*(.+)$/)) && OUT.test(m[1])) {
    const o = m[1].toUpperCase();
    const v = m[2].trim();
    if (v === 'on') return `.turnOn(${o})`;
    if (v === 'off') return `.turnOff(${o})`;
    const p = percent(v);
    return p !== null && m[1].startsWith('out') ? `.dim(${o}, percent(${p}))` : null;
  }
  return null;
}

/**
 * The name of an effect header as the board reads it (show-script-golden README, "The lines"): a line that
 * starts with "effect" is always a header; "effect porch light:" is named "porch light", "effect1:" is named
 * "effect1". Lower case, runs of spaces made one, as in the board's step table.
 */
export function effectName(line: string): string {
  const rest = line.slice(6);
  const part = rest === '' || rest[0] === ' ' || rest[0] === ':' ? rest : line;
  const i = part.indexOf(':');
  return (i >= 0 ? part.slice(0, i) : part).trim().toLowerCase().replace(/ +/g, ' ');
}

export function scriptToCpp(text: string): string {
  const out: string[] = [];
  let input: string | null = null;
  let chain: string[] = [];
  let name = '';
  const flush = () => {
    if (!name) return;
    out.push(`  // effect ${name}`);
    if (!input) out.push(`  // this effect has no "wait for" line, so it has no trigger here`);
    else {
      const end = chain.length && chain[chain.length - 1].startsWith('//') ? '\n      ;' : ';';
      out.push(`  prop.when(${input})${chain.length ? '\n      ' + chain.join('\n      ') : ''}${end}`);
    }
    out.push('');
  };
  for (const raw of text.split(/\r\n|\n|\r/)) {
    const line = norm(raw);
    if (!line) continue;
    if (/^effect/i.test(line)) {
      flush();
      name = effectName(line) || 'unnamed';
      input = null;
      chain = [];
      continue;
    }
    if (!name) continue;
    const w = line.toLowerCase().replace(/ /g, '').match(/^waitfor(.+)$/);
    if (w && !input && IN.test(w[1])) {
      input = w[1].toUpperCase();
      continue;
    }
    // a sound line above the first wait for runs at power-on and at each return to the top, not at the trigger
    if (!input) {
      chain.push(`// not available in the C++ beginner layer (above the first wait for): ${line}`);
      continue;
    }
    const st = step(line);
    if (st) chain.push(st);
    else chain.push(`// not available in the C++ beginner layer: ${line}`);
  }
  flush();
  return [
    '// Made by Specter Studio from an effect script, for the Proptroller beginner layer (Proptroller.h).',
    '// Steps start together unless a wait() moves the time on; a wait line is a wait(), a fade is followed by one.',
    '// Sounds: playSound(N) plays sound N, the one file in the card\'s folder NN, the same file as the script\'s audio_single = N.',
    '#include <Arduino.h>',
    '#include <Proptroller.h>',
    '',
    'Proptroller prop;',
    '',
    'void setup() {',
    '  prop.begin();',
    '',
    ...out,
    '}',
    '',
    'void loop() {',
    '  prop.update();',
    '}',
    '',
  ].join('\n');
}
