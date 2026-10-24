// Plain words for what Studio knows about a board. Beginner mode shows only these.
import type { Board } from './store';
import { scriptTargets } from './shows/shows';

export type Tone = 'success' | 'warning' | 'info' | 'default' | 'error';
export interface Badge { label: string; tone: Tone; help: string }

export const supportsScripts = (b: Board) => !!b.info?.capabilities?.includes('script');

export function scriptBadge(b: Board): Badge {
  if (b.adapter && !supportsScripts(b)) return { label: 'No effect scripts on this device', tone: 'default', help: '' };
  if (!supportsScripts(b)) return { label: 'Effect scripts: needs a firmware update', tone: 'warning', help: "This board's firmware cannot run effect scripts. Update its firmware first." };
  const s = b.scriptStatus;
  if (!s) return { label: 'Effect script: checking…', tone: 'default', help: '' };
  const name = s.name ? `“${s.name}”` : '';
  switch (s.status) {
    case 'none': return { label: 'No effect script', tone: 'default', help: 'This board has no effect script. Send one from Your library.' };
    case 'current': return { label: `${name}: up to date`, tone: 'success', help: `The board runs the newest version of ${name} in your library.` };
    case 'older': return { label: `${name}: newer version in your library`, tone: 'warning', help: `Your library has a newer ${name} (saved ${s.library_saved}). Send it to update the board.` };
    case 'changed': return { label: `${name}: changed on the board`, tone: 'info', help: `The board's ${name} is not a version you saved. Save it to your library to keep it.` };
    case 'unsupported': return { label: 'Effect scripts: needs a firmware update', tone: 'warning', help: "This board's firmware cannot run effect scripts." };
    default: return { label: 'Effect script not in your library', tone: 'info', help: 'Save it to your library to keep it and to send it to other boards.' };
  }
}

export function firmwareBadge(b: Board): Badge {
  if (b.adapter) return { label: b.info?.fw_version ? `Firmware ${b.info.fw_version}` : 'Firmware: unknown', tone: 'default', help: '' };
  const f = b.firmware;
  if (!f) return { label: 'Firmware: checking…', tone: 'default', help: '' };
  const c = f.custom;
  if (c?.kind === 'custom') {
    if (c.status === 'current') return { label: `Your firmware “${c.name}” v${c.version}: up to date`, tone: 'success', help: 'The newest build of your own firmware.' };
    if (c.status === 'older') return { label: `Your firmware “${c.name}”: v${c.library_version} available`, tone: 'warning', help: `The board runs v${c.version}; your library has v${c.library_version}.` };
    return { label: `Firmware “${c.name}” v${c.version}`, tone: 'info', help: 'A custom firmware that is not in your library.' };
  }
  const p = f.plan;
  if (b.lastUpdate && p?.latest && b.lastUpdate.version === p.latest) return { label: `Update to ${p.latest} did not take`, tone: 'error', help: b.lastUpdate.result === 'rolled_back' ? 'The new firmware did not start, so the board went back to its old firmware. Nothing was lost. Studio will not offer this version again until you ask (board page).' : `The update stopped: ${b.lastUpdate.message || 'see Activity'}.` };
  if (!p) return { label: `Firmware ${b.info?.fw_version ?? ''}`, tone: 'default', help: 'Checking for firmware updates…' };
  if (p.none_yet) return { label: `Firmware ${b.info?.fw_version ?? ''}`, tone: 'default', help: 'No firmware release has been published yet. Studio looks again from time to time.' };
  if (p.error) return { label: `Firmware ${b.info?.fw_version ?? ''}`, tone: 'default', help: /needs the internet/.test(p.error) ? p.error : `Cannot check for firmware updates: ${p.error}` };
  // the offered version is a pre-release (a release candidate): Allow betas is on, or nothing full is out yet
  const beta = p.prerelease ? ' (beta)' : '';
  const test = p.prerelease ? ' It is a test version (beta), before the full release.' : '';
  if (p.out_of_date) return { label: `Firmware update available: ${p.latest}${beta}`, tone: 'warning', help: `The board runs ${p.current}.${test}` };
  // usb_reason: the board's package is not in the new image and its firmware cannot be sent one (core boardpkg.rs)
  if (p.usb_update && p.usb_reason) return { label: `Firmware ${p.latest}${beta} available (over USB)`, tone: 'info', help: `The board runs ${p.current}. Not over Wi-Fi: ${p.usb_reason}. Plug it in and use Add a board > Put firmware on a new board (USB), with its board package. Back it up first.${test}` };
  if (p.usb_update) return { label: `Firmware ${p.latest}${beta} available (over USB)`, tone: 'info', help: `The board runs ${p.current} and takes new firmware over USB only: plug it in and use Add a board > Put firmware on a new board (USB). Back it up first.${test}` };
  return { label: 'Firmware up to date', tone: 'success', help: `Version ${p.current}.` };
}

export function boardKind(info: any): string {
  // a device adapter's own words; a board's own answer carries kind "info" (the reply's name), not a kind of board
  if (info?.kind && info.kind !== 'info') return String(info.kind);
  switch (info?.mcu) {
    case 'esp32-devkit': return 'ESP32 board';
    case 'pico': return 'Raspberry Pi Pico (USB only)';
    case 'pico-w': case 'picow': return 'Raspberry Pi Pico W';
    case 'pico2-w': case 'pico2w': return 'Raspberry Pi Pico 2 W';
    case 'sim': return 'Practice board (on this computer)';
    default: return info?.mcu || 'Board';
  }
}

/** Output level words: relays and contacts are on/off, OUT1-4 dim. */
export function levelText(channel: string, level: number) {
  if (/^OUT/.test(channel)) return level === 0 ? 'off' : level >= 1000 ? 'on' : `${Math.round(level / 10)}%`;
  return level > 0 ? 'on' : 'off';
}

/** A show and the effect script started by the same input: one press runs both. `intended` when they drive
 * different things (the starter kit: its show does the pixels, its effect script the lamp, fan and sound), so
 * the overlap is explained calmly instead of warned about; a show that is off never counts. */
export interface Overlap { input: string; show: { id: number; name: string }; intended: boolean; shared: string[]; text: string }

export function overlaps(b: Board): Overlap[] {
  const text = b.script?.text || '';
  // as the board reads it: "#" to the end of a line is a comment, so a "# wait for trig2" starts nothing
  const code = text.split(/\r\n|\n|\r/).map((l) => l.split('#')[0]).join('\n');
  const used = new Set([...code.matchAll(/^[ \t\u00a0\u202f]*w[ \t]*a[ \t]*i[ \t]*t[ \t]*f[ \t]*o[ \t]*r[ \t]*(trig\d|user\d)[ \t.]*$/gim)].map((m) => m[1].toUpperCase()));
  const drives = scriptTargets(text);
  const out: Overlap[] = [];
  for (const s of b.shows || []) {
    if (!s.enabled) continue;
    for (const i of s.inputs) {
      if (!used.has(i)) continue;
      const targets = s.targets || [];
      const shared = targets.filter((t) => drives.includes(t));
      const intended = targets.length > 0 && shared.length === 0;
      const show = { id: s.id, name: s.name };
      out.push({ input: i, show, intended, shared, text: intended
        ? `${i} starts both the show “${s.name}” (${targets.join(', ')}) and the effect script (the rest), so one press runs both. That looks intended, as in the starter kit. Turn the show off if you did not mean it.`
        : `${i} starts both the show “${s.name}” and the effect script: one press runs both.${shared.length ? ` Both drive ${shared.join(', ')}.` : ''}` });
    }
  }
  return out;
}

/** The overlaps worth a warning (not the intended ones). */
export function conflicts(b: Board): string[] {
  return overlaps(b).filter((o) => !o.intended).map((o) => o.text);
}

// Fog machines are run over DMX (the socket labelled DMX IN), never through a wired remote on a relay: many of
// those remotes carry mains (the firmware's SHOW-SCRIPT.md 7.2 and 7.3).
const FOG = /^(fog|fogger|smoke|haze|mist)$/;
const FOG_DMX = 'Fog machines go on DMX (dmx1), never on a relay: the DMX add-on goes in the socket labelled DMX IN (never REMOTE); turn the add-on on in the board\'s settings (More settings, DMX port), then the script says dmx1 = on.';
// Everyday words people write for a thing they wired, and where that thing usually goes.
const USUAL: [RegExp, string][] = [
  [/^(lamps?|lights?|leds?|strips?|bulbs?|eyes?|glow|candles?|lighting)$/, 'Lights usually go on out1 to out4 (they can dim). If yours is on OUT1, write out1.'],
  [FOG, `${FOG_DMX} Never wire a fog machine's remote to a relay: many carry wall power.`],
  [/^(fan|pump|motor|blaster|air|compressor|solenoid|valve)$/, 'Air valves, air blasters, pumps, fans and motors (12 V) usually go on out1 to out4. If yours is on OUT2, write out2.'],
  [/^(mains|wall|outlet|plug)$/, 'Wall power (mains) needs care: read the board\'s notes on AC before wiring anything to a relay.'],
  [/^(sound|sounds|audio|music|scream|mp3|speaker)$/, 'Sounds are not wired to an output. To play sound 1, write: audio_single = 1'],
  [/^(button|buttons|switch|mat|motion|sensor|pir|beam|door|step)$/, 'Buttons, mats and motion sensors go on an input. If yours is on TRIG1, write: wait for trig1'],
];

/**
 * One more plain line under the checker's "there is no lamp on this board": the board's own names first ("Your
 * lamp is on OUT1"), then where that kind of thing is usually wired. null when there is nothing to add.
 */
export function missingHint(message: string, terminals: { id: string; label?: string }[] = []): string | null {
  const m = /there is no ["“]?([^"”\s.]+)["”]? on this board/i.exec(message);
  if (!m) return null;
  const word = m[1].toLowerCase();
  const named = terminals.find((t) => t.label && t.label.toLowerCase().split(/[^a-z0-9]+/).includes(word));
  if (named) {
    const fogOnRelay = FOG.test(word) && /^rly/i.test(named.id) ? ` ${FOG_DMX} A fog machine's wired remote on a relay is not supported.` : '';
    return `Your ${named.label} is on ${named.id.toUpperCase()}: write ${named.id.toLowerCase()} instead of ${word}.${fogOnRelay}`;
  }
  const usual = USUAL.find(([re]) => re.test(word));
  return usual ? usual[1] : null;
}

/**
 * A plain way forward for the lines people naturally write that the checker does not take, from the line itself:
 * "pause 2 seconds" (a pause is "wait 2"; "wait for trig1" waits for an input), "out1 flicker", "out1 = flicker",
 * "out1 fade", "out1 on", "turn on out1". Null when there is nothing to add.
 */
/**
 * The plain line shown under a checker message: the board's own names first (missingHint), else a way forward
 * from the line (lineHint), but only when the board's message does not already say how to write it (newer
 * firmware's checker suggests "wait 3", "audio_single = 1"...: the two must never disagree or repeat).
 */
export function checkHint(message: string, line: string | undefined, terminals: { id: string; label?: string }[] = []): string | null {
  const own = missingHint(message, terminals);
  if (own) return own;
  // checkers before `wait <time>` answered "wait 3" with only 'write it as "wait for trig1"': that one gets a hint
  const onlyWaitFor = /write it as "wait for trig1"\.$/.test(message.trim());
  if (/write (it as )?"|to (play a sound|wait a time)|say which sound/i.test(message) && !onlyWaitFor) return null;
  return lineHint(line);
}

export function lineHint(line: string | undefined): string | null {
  if (!line) return null;
  const l = line.replace(/#.*/, '').trim().toLowerCase();
  const out = /\b(out[1-4]|rly[12]|cc[12])\b/.exec(l)?.[1] || 'out1';
  let m: RegExpExecArray | null;
  if ((m = /^(?:wait|pause|delay)\s+(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|seconds?|min|mins|minutes?)?$/.exec(l))) {
    const unit = !m[2] || /^s/.test(m[2]) ? '' : /^ms/.test(m[2]) ? ' ms' : ' min';
    if (l.startsWith('wait')) return `This board's firmware is older and pauses with "sleep ${m[1]}${unit}": write that, or update the firmware.`;
    return `To pause, write "wait ${m[1]}${unit}". ("wait for trig1" waits for an input to be pressed.)`;
  }
  if (/\bflicker\b/.test(l) && !/^flicker\s+\S+\s+for\s+\S+/.test(l)) return `To flicker, write "flicker ${out} for 3" (3 seconds).`;
  if (/\bfade\b/.test(l) && !/^fade\s+\S+\s+to\s+\S+\s+over\s+\S+/.test(l)) return `To fade, write "fade ${out} to 0% over 2" (to off over 2 seconds).`;
  if ((m = /^(?:turn\s+|switch\s+)?(on|off)\s+(out[1-4]|rly[12]|cc[12])$/.exec(l)) || (m = /^(?:turn\s+|switch\s+)?(out[1-4]|rly[12]|cc[12])\s+(on|off)$/.exec(l))) {
    const [a, b] = /^(on|off)$/.test(m[1]) ? [m[2], m[1]] : [m[1], m[2]];
    return `Write "${a} = ${b}".`;
  }
  return null;
}

/**
 * One plain status line for an input tile: what the input is used for when it has a job (the on-board record
 * buttons, the pause switch), else whether it would start something now.
 */
export function inputStatus(input: { armed?: boolean; raw?: boolean; active?: boolean }, role: string | undefined, paused: boolean): string {
  switch (role) {
    case 'REC': return 'Record button: hold it to record on the board';
    case 'SELECT': return 'Record mode: picks the output to record';
    case 'TAP': return 'Record mode: tap the timing here';
    case 'pause': return 'Pause switch: the board rests while it is closed';
  }
  if (paused) return 'Ignored: the board is stopped';
  if (input.armed === false && !(input.raw || input.active)) return 'Resting: not ready to start again yet';
  return 'Ready';
}

/** One more line under an input's "Ready" when Studio has not seen it pressed: an unplugged switch or sensor looks
 * exactly like an idle one, so say how to tell (press it once and watch the tile). */
/** Under an input held with Hold to test while the board's remote start is off: the press shows, nothing starts. */
export const TEST_PRESS_SHOWN_ONLY = 'Shown only, nothing starts: turn on network start (Settings, Effect: Remote trigger) to let a test press start effects.';
export const NOT_SEEN_PRESSED = 'Not pressed yet. Press it once: if this tile does not say pressed, the board does not see it (check the wiring).';

// What a board-supplied action button does: the board's own `help` when it sends one, else a plain line
// for the actions the firmware is known to offer (PROTOCOL.md "Info" actions; generic firmware: `save`
// writes the pending changes to flash now instead of after its 2-second save delay).
const ACTION_HELP: Record<string, string> = {
  save: 'Writes the board\'s latest changes to its memory right now. The board also does this by itself about 2 seconds after each change, so you only need it if you will unplug the board straight away.',
};
export function actionHelp(action: { key: string; help?: string }): string {
  return action.help || ACTION_HELP[action.key] || '';
}

// What a terminal is usually used for, as a word in a wiring guide's file name: any OUT is wired like the lamp guide
// (not the air-valve or motor ones that also say "out"), a CC starts another board (the chaining guide).
const GUIDE_FOR: [RegExp, string][] = [[/^out\d/, 'lamp-on-out'], [/^cc\d/, 'chaining'], [/^(spk|sound|speaker)/, 'speaker'], [/^pixel/, 'pixel'], [/^dmx/, 'dmx'],
  // no relay guide yet (the fog-remote one is gone: fog goes over DMX): a relay page when there is one, else the
  // tour of the board's terminals, with relayNote() above it
  [/^rly\d/, 'relay'], [/^rly\d/, 'meet-your-board']];
/** The guide page for a terminal (OUT1, TRIG1...): its own guide, else the guide for that kind of terminal, else the index. */
export function guidePage(pages: string[], topic: string): string {
  const t = topic.toLowerCase();
  const has = (w: string) => pages.find((p) => p.toLowerCase().includes(w));
  const kind = GUIDE_FOR.filter(([re]) => re.test(t)).map(([, w]) => has(w)).find(Boolean);
  return has(t) || kind || has(t.replace(/\d+$/, '')) || 'index.html';
}

/** A plain note for a relay's "How do I wire this?" while the guides have no relay page of their own. */
export function relayNote(pages: string[], topic: string): string | null {
  if (!/^rly\d/i.test(topic) || pages.some((p) => /relay/i.test(p))) return null;
  return `${topic.toUpperCase()} is a relay: a switch the board closes, with its own two screw terminals and nothing powered from the board. `
    + 'Use it for low-voltage buttons and switches (a prop\'s own button input; at most 30 V DC on rev A). Never put wall power (mains) or a fog machine\'s wired remote on it: fog machines go on DMX (dmx1), never on a relay. '
    + 'There is no wiring guide for the relays yet; the page below shows where every terminal is.';
}

// An output with a job of its own (its role, which the board names in its state): what that job does, in plain words.
const DRIVER_WORDS: Record<string, string> = {
  trigger_repeat: 'pulses on each trigger (to start the next board)',
  sound_trigger: 'pulses when a sound starts',
};
export function driverText(driver: string | undefined): string {
  if (!driver) return '';
  return DRIVER_WORDS[driver.trim().toLowerCase().replace(/[\s-]+/g, '_')] || driver;
}

// A firmware status line in plain words, as the phone page shows it: the profile's label when it gives one, else the
// key without underscores ("Remote trigger by"); a time ("_ms" or unit "ms") in seconds or m:ss; yes / no; "none".
export function statusText({ key, value, label, alias, unit }: { key: string; value: unknown; label?: string; alias?: string; unit?: string }): [string, string] {
  const ms = (/_ms$/.test(key) || unit === 'ms') && typeof value === 'number';
  let k = label || alias || key.replace(/_ms$/, '').replace(/_/g, ' ');
  k = k.charAt(0).toUpperCase() + k.slice(1);
  const clock = (n: number) => { const t = Math.round(n / 1000); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
  const v = ms ? ((value as number) >= 60000 ? clock(value as number) : `${((value as number) / 1000).toFixed(1)} s`)
    : value === true ? 'yes' : value === false ? 'no' : value === '' || value == null ? 'none' : String(value);
  return [k, v];
}

/**
 * Plain words for a choice setting's options, from the board's own help for it ("switch: switch, button or relay
 * contact (closes to ground). sensor_high: powered sensor ...", "cycle = ...; timed = ..."), as the phone page does.
 * An option the help does not describe keeps its value as its words.
 */
export function optionWords(p: { options?: any[]; help?: string }): Record<string, string> {
  const out: Record<string, string> = {};
  for (const o of p.options || []) {
    if (typeof o !== 'string') continue;
    const esc = o.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = (p.help || '').match(new RegExp(`(?:^|[.;]\\s*)${esc}\\s*[:=]\\s*([^.;]+)`));
    if (!m) continue;
    let w = m[1].trim();
    if (w.length > 55) { const c = w.lastIndexOf(',', 55); if (c > 10) w = w.slice(0, c); }
    out[o] = w.charAt(0).toUpperCase() + w.slice(1);
  }
  return out;
}

/** "Add" by address failed: what to try next, in plain words (the device layer's message otherwise). */
export function connectError(message: string, address: string): string {
  if (!/no board answers|cannot connect|refused|timed out|not found/i.test(message)) return message;
  const spaces = /\s/.test(address.trim()) ? 'A board address has no spaces (for example 192.168.1.50 or front-door.local). ' : '';
  return `${spaces}No board answered at “${address.trim()}”. Check that the board is on and on the same Wi-Fi as this computer, then try “Find boards on my network”. `
    + 'A board that is not on your Wi-Fi yet: join its own Wi-Fi (Proptroller-…, always there) and press “Connect through the board\'s own Wi-Fi”.';
}

/** The next practice board's name: the first "Practice board N" no board has, so a removed one leaves no clash. */
export function practiceName(names: string[]): string {
  for (let n = 1; ; n++) if (!names.includes(`Practice board ${n}`)) return `Practice board ${n}`;
}

/** A board's empty activity log: what shows up there, and what it means when a press never does (wiring). */
export const ACTIVITY_EMPTY = 'Nothing yet. Every press of an input and every effect that starts shows up here. '
  + 'If you press a button or walk past a sensor and nothing appears here or on its tile on the Live tab, the board does not see it: '
  + 'check its wiring with "How do I wire this?" on the Live tab.';
