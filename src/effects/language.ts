// The effect-script language for the Monaco editor: colours, completion and hover help. The board's own
// checker decides what is right (markersFromCheck turns its answer into editor squiggles).
import type * as Monaco from 'monaco-editor';
import { completionsAt, nameHover } from './completions';

export const LANG_ID = 'effect-script';

// TODO(words.js): the firmware is to get one shared word list for the show script, `firmware/web/words.js`
// (keywords, outputs, inputs, units, levels, settings and the dmxN rule), which the phone page's highlighter
// also uses. When it is on the firmware branch this submodule follows, import the lists below from
// '../../firmware/firmware/web/words.js', the way src/record/take.ts imports take.js, and delete these copies.
// It was not there yet on 2026-10-25 (firmware 91f77d9).

const KEYWORDS = ['effect', 'wait', 'for', 'sleep', 'fade', 'to', 'over', 'flicker', 'audio_single', 'audio_loop', 'audio_volume', 'audio_stop',
  // the advanced lines (the firmware's SHOW-SCRIPT.md)
  'limit', 'run', 'runs', 'per', 'pulse'];
// the settings a line may name for a time (wait, pulse, limit) or a count (limit): read when the line runs
const SETTINGS = ['out1_on_ms', 'out2_on_ms', 'out3_on_ms', 'recover_time_ms', 'cooldown_ms', 'trigger_out_pulse_ms', 'role_pulse_ms', 'runs_per_cooldown'];
const OUTPUTS = ['out1', 'out2', 'out3', 'out4', 'rly1', 'rly2', 'cc1', 'cc2'];
const INPUTS = ['trig1', 'trig2', 'user1', 'user2', 'user3'];
const UNITS = ['ms', 's', 'sec', 'secs', 'second', 'seconds', 'min', 'mins', 'minute', 'minutes'];
const LEVELS = ['on', 'off'];

const HELP: Record<string, string> = {
  effect: 'Starts an effect: `effect porch light:`. The lines below it belong to it until the next effect. Effects run at the same time, except two that use the same output: those take turns (a press while the other runs is remembered and runs after it, if the input is still held then). Every effect can also be started by its name from the phone, MQTT or serial, with the remote trigger on (or listed in remote_free_effects).',
  wait: '`wait 2` waits this long before the next line (`wait 200 ms`, `wait 3 min`, `wait for 2 s` too; a wait at the end works as a rest time). `wait for trig1` waits until an input is pressed and held for a moment (debounce), after it was released: `wait for trig1`. The first line of every effect (only sound lines may come before it). Settings trig1_wait / trig2_wait: "ready" (a press counts once the effect can run) or "return" (a press while the effect cannot run is remembered and runs when it can, if the input is still held then).',
  for: '`wait for <input>` waits for a press (`wait for 2 s` waits a time); `flicker <output> for <time>` flickers for that long.',
  sleep: '`sleep` still works; new scripts say `wait`: `wait 2.5`, `wait 200 ms`, `wait 3 min`.',
  fade: 'Changes a dimmable output smoothly: `fade out1 to 0% over 2`. Works on out1 to out4 and DMX channels.',
  to: 'The level a fade goes to: on, off or a percentage.',
  over: 'How long a fade takes.',
  flicker: 'Flickers a dimmable output at random like a failing bulb, then gives its level back: `flicker out1 for 3`.',
  audio_single: 'Plays a sound once by its number (1 to 99): `audio_single = 3` plays the one file in the card\'s folder 03 (03/001-<description>.mp3). One sound plays at a time: a new one replaces it.',
  audio_loop: 'The background sound: `audio_loop = 2` plays sound 2 over and over; a sound played with audio_single takes over and the loop comes back after it. Above the first "wait for" it starts at power-on and again each time the effect is back at its top. `audio_loop = off` ends it.',
  audio_stop: 'Stops the sound, and the background loop.',
  audio_volume: 'How loud the script\'s sounds play from this line on: `audio_volume = 60%` (0% to 100%, or `off`). Kept until the next audio_volume or a restart; the board\'s ambient and trigger volume settings stay as they are.',
  limit: 'At most N runs in a window that starts at the first run: `limit 3 runs per 3 min`. While it is used up, presses are ignored.',
  per: '`limit 3 runs per 3 min`: the window\'s length.',
  pulse: 'Turns an output on now and off after the time, while the effect goes on: `pulse cc1 for 200 ms`.',
  on: 'Full on (100 %).',
  off: 'Off (0 %).',
  trig1: 'Trigger jack 1 (a button, pressure mat or motion sensor).',
  trig2: 'Trigger jack 2.',
  user1: 'Button USER1 on the board: a trigger like TRIG1 (`wait for user1`). Boards with firmware before 0.1.0-rc.1 need the setting "buttons" set to triggers.',
  user2: 'Button USER2 on the board: a trigger like TRIG1 (`wait for user2`). Boards with firmware before 0.1.0-rc.1 need the setting "buttons" set to triggers.',
  user3: 'Button USER3 on the board: a trigger like TRIG1 (`wait for user3`). Boards with firmware before 0.1.0-rc.1 need the setting "buttons" set to triggers.',
  out1: '12 V output 1: lamps, LEDs, solenoids. Can dim (`out1 = 50%`) and fade.',
  out2: '12 V output 2. Can dim and fade.',
  out3: '12 V output 3. Can dim and fade.',
  out4: '12 V output 4. Can dim and fade.',
  rly1: 'Relay 1: a switch for another device (for example a battery prop\'s button). On or off only. Low-voltage buttons only (at most 30 V DC on rev A). Fog machines go on DMX (dmx1), never on a relay.',
  rly2: 'Relay 2: on or off only.',
  cc1: 'Contact 1: an isolated button press for another device. On or off only.',
  cc2: 'Contact 2: on or off only.',
  ms: 'Milliseconds (1000 ms = 1 second).',
  s: 'Seconds (times without a unit are seconds too).',
  min: 'Minutes.',
};

/** Plain-words help for a word under the cursor, or null. */
export function hoverFor(word: string): string | null {
  const w = word.toLowerCase();
  if (HELP[w]) return HELP[w];
  if (/^dmx\d+$/.test(w)) return `DMX channel ${w.slice(3)} (1 to 512), through the DMX add-on: on, off or a percentage. Needs the setting dmx_port = s4.`;
  if (['sec', 'secs', 'second', 'seconds'].includes(w)) return HELP.s;
  if (['mins', 'minute', 'minutes'].includes(w)) return HELP.min;
  if (['run', 'runs'].includes(w)) return HELP.limit;
  if (SETTINGS.includes(w)) return w === 'runs_per_cooldown'
    ? 'The setting runs_per_cooldown, a number of runs: `limit runs_per_cooldown runs per cooldown_ms`. Change it on the board and the next run uses it.'
    : `The setting ${w}, a time in milliseconds: \`wait ${w}\`. Change it on the board and the line uses the new time the next time it runs.`;
  return null;
}

export interface CheckLine { line: number; message: string }
export interface Check { ok?: boolean; errors: CheckLine[]; warnings: CheckLine[] }

/** The board checker's answer as editor markers (8 = Error, 4 = Warning in Monaco). Line 0 = the whole script. */
export function markersFromCheck(check: Check, model: { getLineCount(): number; getLineMaxColumn(line: number): number }): Monaco.editor.IMarkerData[] {
  const mk = (l: CheckLine, severity: number): Monaco.editor.IMarkerData => {
    const line = Math.min(Math.max(l.line, 1), Math.max(model.getLineCount(), 1));
    return { severity, message: l.message, startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: model.getLineMaxColumn(line) };
  };
  return [...(check.errors || []).map((e) => mk(e, 8)), ...(check.warnings || []).map((w) => mk(w, 4))];
}

/**
 * Typing a script line by line: Enter keeps the line's indent, and people then type the two spaces they read in the
 * examples, so lines walk to the right (a staircase). An effect has one indent level only, so a line is never
 * indented more than two spaces: returns the line with its indent fixed, or null when it is fine as it is.
 */
export function indentFix(line: string): string | null {
  const m = /^( {3,}|\t+ *)(.*)$/.exec(line);
  return m ? `  ${m[2]}` : null;
}

let registered = false;
/** Keeps every line of an effect editor at one indent level as it is typed or pasted (see indentFix). */
export function keepOneIndent(editor: Monaco.editor.IStandaloneCodeEditor, current: () => string) {
  let fixing = false;
  const pending = new Set<number>();
  // the fix is applied just after the change (an edit made inside Monaco's own change event can be lost)
  const apply = () => {
    const model = editor.getModel();
    const lines = [...pending];
    pending.clear();
    if (!model) return;
    const edits = lines.filter((l) => l >= 1 && l <= model.getLineCount()).flatMap((l) => {
      const text = model.getLineContent(l);
      const fixed = indentFix(text);
      return fixed === null ? [] : [{ range: { startLineNumber: l, startColumn: 1, endLineNumber: l, endColumn: text.length + 1 }, text: fixed }];
    });
    if (!edits.length) return;
    fixing = true;
    try { editor.executeEdits('one-indent', edits); } finally { fixing = false; }
  };
  return editor.onDidChangeModelContent((e) => {
    const model = editor.getModel();
    if (fixing || e.isUndoing || e.isRedoing || !model) return;
    // a text set from outside (a file opened, the blocks rewriting it) is left as it is: only what is typed or pasted
    if (model.getValue() === current()) return;
    for (const c of e.changes) {
      const end = c.range.startLineNumber + c.text.split('\n').length - 1;
      for (let l = c.range.startLineNumber; l <= end; l++) pending.add(l);
    }
    if (pending.size) setTimeout(apply, 0);
  });
}

export function registerEffectLanguage(monaco: typeof Monaco) {
  if (registered) return;
  registered = true;
  monaco.languages.register({ id: LANG_ID, extensions: ['.specter'], aliases: ['Effect script'] });
  monaco.languages.setLanguageConfiguration(LANG_ID, {
    comments: { lineComment: '#' },
    // after "effect name:" the next line is indented (the effect's body); other lines keep their indent
    onEnterRules: [{ beforeText: /^\s*effect\b.*:\s*$/i, action: { indentAction: monaco.languages.IndentAction.Indent } }],
  });
  monaco.languages.setMonarchTokensProvider(LANG_ID, {
    ignoreCase: true,
    keywords: KEYWORDS,
    outputs: OUTPUTS,
    inputs: INPUTS,
    units: UNITS,
    levels: LEVELS,
    settings: SETTINGS,
    tokenizer: {
      root: [
        [/#.*$/, 'comment'],
        [/^\s*effect\b/, 'keyword', '@effectName'],
        [/dmx\d+/, 'variable'],
        [/\d+(\.\d+)?\s*%/, 'number'],
        [/\d+(\.\d+)?/, 'number'],
        [/[a-z_][a-z0-9_]*/, { cases: { '@keywords': 'keyword', '@outputs': 'variable', '@inputs': 'type', '@units': 'number', '@levels': 'constant', '@settings': 'number', '@default': 'identifier' } }],
        [/[=:]/, 'delimiter'],
        [/["'][^"']*["']/, 'string'],
      ],
      effectName: [
        [/#.*$/, 'comment', '@pop'],
        [/[^:#]+/, 'string'],
        [/:/, 'delimiter', '@pop'],
        [/$/, '', '@pop'],
      ],
    },
  } as any);
  monaco.languages.registerCompletionItemProvider(LANG_ID, {
    // a space or "=" opens the suggestions that fit there (the levels after "out1 = ", the inputs after "wait for ")
    triggerCharacters: [' ', '='],
    provideCompletionItems(model, position) {
      const before = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
      const w = model.getWordUntilPosition(position);
      const range = { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: w.startColumn, endColumn: w.endColumn };
      const K = monaco.languages.CompletionItemKind;
      const kind = { line: K.Snippet, level: K.Value, terminal: K.Variable, unit: K.Unit, setting: K.Property, sound: K.File, word: K.Keyword };
      return {
        suggestions: completionsAt(before).map((c, i) => ({
          label: c.label,
          kind: kind[c.kind],
          insertText: c.insert,
          insertTextRules: c.snippet ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
          detail: c.detail,
          filterText: c.filter,
          sortText: String(i).padStart(3, '0'),
          command: c.retrigger ? { id: 'editor.action.triggerSuggest', title: 'Suggest' } : undefined,
          range,
        })),
      };
    },
  });
  monaco.languages.registerHoverProvider(LANG_ID, {
    provideHover(model, position) {
      const w = model.getWordAtPosition(position);
      const h = w && (hoverFor(w.word) ?? nameHover(w.word));
      if (!w || !h) return null;
      return { range: new monaco.Range(position.lineNumber, w.startColumn, position.lineNumber, w.endColumn), contents: [{ value: h }] };
    },
  });
}
