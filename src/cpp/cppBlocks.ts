// The "building bricks" for your own firmware: Blockly blocks for the Proptroller library's beginner layer
// (Proptroller.h), generating a complete Arduino sketch. Blocks are the source: the sketch is made from them.
// A sketch edited by hand no longer matches its blocks, and the project then opens as text.
//
//   setup():  every "when ... is pressed" block becomes prop.when(TRIG1).turnOn(OUT1, seconds(2)).then()...;
//             in the library, steps in one chain start together; "wait" moves later steps on, "then" starts the
//             next step after the previous ones are done.
//   loop():   the "every loop" block: if an input was pressed, switch outputs, play sounds, print values for the
//             serial plotter (name:value lines), every N milliseconds.
import * as Blockly from 'blockly';

const INPUTS = ['TRIG1', 'TRIG2', 'USER1', 'USER2', 'USER3'].map((x) => [x, x]);
const OUTPUTS = ['OUT1', 'OUT2', 'OUT3', 'OUT4', 'RLY1', 'RLY2', 'CC1', 'CC2'].map((x) => [x, x]);
const DIMMABLE = ['OUT1', 'OUT2', 'OUT3', 'OUT4'].map((x) => [x, x]);
const C = { when: 30, step: 120, time: 260, sound: 330, loop: 200, value: 60 };
const step = { previousStatement: 'step', nextStatement: 'step' };
const stmt = { previousStatement: 'loop', nextStatement: 'loop' };
const num = (name: string, value: number, min = 0, max?: number, precision?: number) => ({ type: 'field_number', name, value, min, max, precision });

const DEFS: any[] = [
  { type: 'cpp_when', message0: 'when %1 is pressed', args0: [{ type: 'field_dropdown', name: 'IN', options: INPUTS }],
    message1: 'do %1', args1: [{ type: 'input_statement', name: 'STEPS', check: 'step' }], colour: C.when,
    tooltip: 'A sequence that runs each time the input is pressed (the board waits for it to be let go first).' },
  { type: 'cpp_on', message0: 'turn on %1', args0: [{ type: 'field_dropdown', name: 'OUT', options: OUTPUTS }], ...step, colour: C.step, tooltip: 'Switches the output on.' },
  { type: 'cpp_on_for', message0: 'turn on %1 for %2 seconds', args0: [{ type: 'field_dropdown', name: 'OUT', options: OUTPUTS }, num('S', 2, 0, undefined, 0.1)], ...step, colour: C.step,
    tooltip: 'Switches the output on, and off again after that long.' },
  { type: 'cpp_off', message0: 'turn off %1', args0: [{ type: 'field_dropdown', name: 'OUT', options: OUTPUTS }], ...step, colour: C.step, tooltip: 'Switches the output off.' },
  { type: 'cpp_dim', message0: 'dim %1 to %2 %%', args0: [{ type: 'field_dropdown', name: 'OUT', options: DIMMABLE }, num('P', 50, 0, 100)], ...step, colour: C.step, tooltip: 'OUT1-OUT4 can be dimmed.' },
  { type: 'cpp_fade', message0: 'fade %1 to %2 %% over %3 seconds', args0: [{ type: 'field_dropdown', name: 'OUT', options: DIMMABLE }, num('P', 0, 0, 100), num('S', 2, 0, undefined, 0.1)], ...step, colour: C.step,
    tooltip: 'Goes smoothly to a level.' },
  { type: 'cpp_blink', message0: 'blink %1 %2 times, on %3 s, off %4 s', args0: [{ type: 'field_dropdown', name: 'OUT', options: OUTPUTS }, num('N', 3, 1, 1000, 1), num('ON', 0.5, 0, undefined, 0.1), num('OFF', 0.5, 0, undefined, 0.1)], ...step, colour: C.step,
    tooltip: 'Flashes the output.' },
  { type: 'cpp_sound', message0: 'play sound %1', args0: [num('N', 1, 1, 255, 1)], ...step, colour: C.sound, tooltip: 'Plays sound N from the card (folder 02, file 00N).' },
  { type: 'cpp_stop_sound', message0: 'stop the sound', ...step, colour: C.sound, tooltip: 'Stops the sound.' },
  { type: 'cpp_wait', message0: 'wait %1 seconds', args0: [num('S', 1, 0, undefined, 0.1)], ...step, colour: C.time, tooltip: 'The next steps start this much later.' },
  { type: 'cpp_then', message0: 'then', ...step, colour: C.time, tooltip: 'The next steps start when everything before them is done.' },
  { type: 'cpp_cooldown', message0: 'rest %1 seconds before it can run again', args0: [num('S', 5, 0, undefined, 0.1)], ...step, colour: C.time, tooltip: 'Presses during the rest are ignored.' },

  { type: 'cpp_loop', message0: 'every loop', message1: 'do %1', args1: [{ type: 'input_statement', name: 'DO', check: 'loop' }], colour: C.loop,
    tooltip: 'Runs over and over (many times a second), alongside everything the board does by itself.' },
  { type: 'cpp_if_pressed', message0: 'if %1 was pressed', args0: [{ type: 'field_dropdown', name: 'IN', options: INPUTS }],
    message1: 'do %1', args1: [{ type: 'input_statement', name: 'DO', check: 'loop' }], ...stmt, colour: C.loop, tooltip: 'Once for each new press.' },
  { type: 'cpp_every', message0: 'every %1 milliseconds', args0: [num('MS', 500, 1, undefined, 1)],
    message1: 'do %1', args1: [{ type: 'input_statement', name: 'DO', check: 'loop' }], ...stmt, colour: C.loop, tooltip: 'Runs its blocks this often.' },
  { type: 'cpp_now_on', message0: 'switch %1 on', args0: [{ type: 'field_dropdown', name: 'OUT', options: OUTPUTS }], ...stmt, colour: C.step, tooltip: 'Switches the output on now (until you switch it off).' },
  { type: 'cpp_now_off', message0: 'switch %1 off', args0: [{ type: 'field_dropdown', name: 'OUT', options: OUTPUTS }], ...stmt, colour: C.step, tooltip: 'Switches the output off now.' },
  { type: 'cpp_now_sound', message0: 'play sound %1 now', args0: [num('N', 1, 1, 255, 1)], ...stmt, colour: C.sound, tooltip: 'Plays a sound now.' },
  { type: 'cpp_print', message0: 'print %1 : %2', args0: [{ type: 'field_input', name: 'NAME', text: 'value' }, { type: 'input_value', name: 'V', check: 'Number' }], inputsInline: true, ...stmt, colour: C.value,
    tooltip: 'Sends "name:value" to the serial monitor; the serial plotter draws it.' },
  { type: 'cpp_analog', message0: 'reading of pin %1', args0: [num('PIN', 34, 0, 48, 1)], output: 'Number', colour: C.value, tooltip: 'analogRead of an expansion pin (ESP32: 0-4095).' },
  { type: 'cpp_millis', message0: 'milliseconds since start', output: 'Number', colour: C.value, tooltip: 'How long the board has been running.' },
  { type: 'cpp_number', message0: '%1', args0: [num('N', 0, -1e9, 1e9)], output: 'Number', colour: C.value, tooltip: 'A number.' },
];

let defined = false;
export function defineCppBlocks() {
  if (defined) return;
  defined = true;
  Blockly.defineBlocksWithJsonArray(DEFS);
}

export const CPP_TOOLBOX = {
  kind: 'categoryToolbox',
  contents: [
    { kind: 'category', name: 'When pressed', colour: String(C.when), contents: [{ kind: 'block', type: 'cpp_when' }] },
    { kind: 'category', name: 'Outputs', colour: String(C.step), contents: ['cpp_on', 'cpp_on_for', 'cpp_off', 'cpp_dim', 'cpp_fade', 'cpp_blink'].map((type) => ({ kind: 'block', type })) },
    { kind: 'category', name: 'Sound', colour: String(C.sound), contents: ['cpp_sound', 'cpp_stop_sound'].map((type) => ({ kind: 'block', type })) },
    { kind: 'category', name: 'Time', colour: String(C.time), contents: ['cpp_wait', 'cpp_then', 'cpp_cooldown'].map((type) => ({ kind: 'block', type })) },
    { kind: 'category', name: 'Every loop', colour: String(C.loop), contents: ['cpp_loop', 'cpp_if_pressed', 'cpp_every', 'cpp_now_on', 'cpp_now_off', 'cpp_now_sound'].map((type) => ({ kind: 'block', type })) },
    { kind: 'category', name: 'Values', colour: String(C.value), contents: ['cpp_print', 'cpp_analog', 'cpp_millis', 'cpp_number'].map((type) => ({ kind: 'block', type })) },
  ],
};

/** A first sketch in blocks: TRIG1 lights OUT1 for 2 s, then plays sound 1. */
export const STARTER = {
  blocks: { languageVersion: 0, blocks: [
    { type: 'cpp_when', x: 20, y: 20, fields: { IN: 'TRIG1' }, inputs: { STEPS: { block: {
      type: 'cpp_on_for', fields: { OUT: 'OUT1', S: 2 }, next: { block: { type: 'cpp_then', next: { block: { type: 'cpp_sound', fields: { N: 1 } } } } } } } } },
  ] },
};

// numbers as C++ writes them (no exponent, no trailing zeros)
const n = (v: unknown) => String(Number(v));
const secs = (v: unknown) => `seconds(${n(v)})`;

function chainOf(b: Blockly.Block | null): string {
  let out = '';
  for (; b; b = b.getNextBlock()) {
    const f = (k: string) => b!.getFieldValue(k);
    switch (b.type) {
      case 'cpp_on': out += `.turnOn(${f('OUT')})`; break;
      case 'cpp_on_for': out += `.turnOn(${f('OUT')}, ${secs(f('S'))})`; break;
      case 'cpp_off': out += `.turnOff(${f('OUT')})`; break;
      case 'cpp_dim': out += `.dim(${f('OUT')}, percent(${n(f('P'))}))`; break;
      case 'cpp_fade': out += `.fadeTo(${f('OUT')}, percent(${n(f('P'))}), ${secs(f('S'))})`; break;
      case 'cpp_blink': out += `.blink(${f('OUT')}, ${n(f('N'))}, ${secs(f('ON'))}, ${secs(f('OFF'))})`; break;
      case 'cpp_sound': out += `.playSound(${n(f('N'))})`; break;
      case 'cpp_stop_sound': out += '.stopSound()'; break;
      case 'cpp_wait': out += `.wait(${secs(f('S'))})`; break;
      case 'cpp_then': out += '.then()'; break;
      case 'cpp_cooldown': out += `.cooldown(${secs(f('S'))})`; break;
    }
  }
  return out;
}

function valueOf(b: Blockly.Block | null): string {
  if (!b) return '0';
  switch (b.type) {
    case 'cpp_analog': return `analogRead(${n(b.getFieldValue('PIN'))})`;
    case 'cpp_millis': return 'millis()';
    case 'cpp_number': return n(b.getFieldValue('N'));
    default: return '0';
  }
}

function loopOf(b: Blockly.Block | null, ind: string, timers: { n: number }): string {
  let out = '';
  for (; b; b = b.getNextBlock()) {
    const f = (k: string) => b!.getFieldValue(k);
    switch (b.type) {
      case 'cpp_if_pressed':
        out += `${ind}if (prop.wasPressed(${f('IN')})) {\n${loopOf(b.getInputTargetBlock('DO'), ind + '  ', timers)}${ind}}\n`;
        break;
      case 'cpp_every': {
        const t = `every${++timers.n}`;
        out += `${ind}static unsigned long ${t} = 0;\n${ind}if (millis() - ${t} >= ${n(f('MS'))}) {\n${ind}  ${t} = millis();\n${loopOf(b.getInputTargetBlock('DO'), ind + '  ', timers)}${ind}}\n`;
        break;
      }
      case 'cpp_now_on': out += `${ind}prop.turnOn(${f('OUT')});\n`; break;
      case 'cpp_now_off': out += `${ind}prop.turnOff(${f('OUT')});\n`; break;
      case 'cpp_now_sound': out += `${ind}prop.playSound(${n(f('N'))});\n`; break;
      case 'cpp_print': {
        const name = String(f('NAME')).replace(/[^A-Za-z0-9_ ]/g, '').trim() || 'value';
        out += `${ind}Serial.print("${name}:");\n${ind}Serial.println(${valueOf(b.getInputTargetBlock('V'))});\n`;
        break;
      }
    }
  }
  return out;
}

export const HEADER = '// Made with blocks in Specter Studio. Edit the blocks; a change made here by hand switches the project to text.';

/** The whole sketch from a workspace (top blocks in their order on the page). */
export function generateSketch(ws: Blockly.Workspace): string {
  const tops = ws.getTopBlocks(true);
  const whens = tops.filter((b) => b.type === 'cpp_when' && b.isEnabled());
  const loops = tops.filter((b) => b.type === 'cpp_loop' && b.isEnabled());
  let setup = '';
  for (const w of whens) {
    const chain = chainOf(w.getInputTargetBlock('STEPS'));
    setup += `  prop.when(${w.getFieldValue('IN')})${chain};\n`;
  }
  const timers = { n: 0 };
  let loop = '';
  for (const l of loops) loop += loopOf(l.getInputTargetBlock('DO'), '  ', timers);
  return `${HEADER}
#include <Arduino.h>
#include <Proptroller.h>

Proptroller prop;

void setup() {
  prop.begin();
${setup}}

void loop() {
  prop.update();
${loop}}
`;
}

/** The sketch a saved blocks file makes (headless), or null when the file is not a blocks workspace. */
export function sketchFromSaved(saved: unknown): string | null {
  try {
    defineCppBlocks();
    const ws = new Blockly.Workspace();
    Blockly.serialization.workspaces.load(saved as any, ws);
    const code = generateSketch(ws);
    ws.dispose();
    return code;
  } catch {
    return null;
  }
}
