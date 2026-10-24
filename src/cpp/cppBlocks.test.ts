import { describe, expect, it } from 'vitest';
import * as Blockly from 'blockly';
import { defineCppBlocks, generateSketch, HEADER, sketchFromSaved, STARTER } from './cppBlocks';

function load(state: any) {
  defineCppBlocks();
  const ws = new Blockly.Workspace();
  Blockly.serialization.workspaces.load(state, ws);
  return ws;
}
const chain = (...blocks: any[]) => {
  for (let i = blocks.length - 2; i >= 0; i--) blocks[i].next = { block: blocks[i + 1] };
  return blocks[0];
};

describe('C++ blocks', () => {
  it('make the starter sketch', () => {
    const code = generateSketch(load(STARTER));
    expect(code).toContain('  prop.begin();\n  prop.when(TRIG1).turnOn(OUT1, seconds(2)).then().playSound(1);\n}');
    expect(code.startsWith(HEADER)).toBe(true);
    expect(code).toContain('void loop() {\n  prop.update();\n}');
  });

  it('write every step of the beginner layer', () => {
    const steps = chain(
      { type: 'cpp_on', fields: { OUT: 'RLY1' } }, { type: 'cpp_dim', fields: { OUT: 'OUT2', P: 25 } },
      { type: 'cpp_fade', fields: { OUT: 'OUT2', P: 0, S: 1.5 } }, { type: 'cpp_blink', fields: { OUT: 'OUT3', N: 4, ON: 0.2, OFF: 0.3 } },
      { type: 'cpp_wait', fields: { S: 3 } }, { type: 'cpp_off', fields: { OUT: 'RLY1' } }, { type: 'cpp_stop_sound' },
      { type: 'cpp_cooldown', fields: { S: 10 } });
    const code = generateSketch(load({ blocks: { languageVersion: 0, blocks: [{ type: 'cpp_when', fields: { IN: 'TRIG2' }, inputs: { STEPS: { block: steps } } }] } }));
    expect(code).toContain('prop.when(TRIG2).turnOn(RLY1).dim(OUT2, percent(25)).fadeTo(OUT2, percent(0), seconds(1.5)).blink(OUT3, 4, seconds(0.2), seconds(0.3)).wait(seconds(3)).turnOff(RLY1).stopSound().cooldown(seconds(10));');
  });

  it('write the loop: presses, timers, plotter lines', () => {
    const inner = chain({ type: 'cpp_print', fields: { NAME: 'light' }, inputs: { V: { block: { type: 'cpp_analog', fields: { PIN: 34 } } } } },
      { type: 'cpp_print', fields: { NAME: 'up"time' }, inputs: { V: { block: { type: 'cpp_millis' } } } });
    const body = chain(
      { type: 'cpp_if_pressed', fields: { IN: 'USER1' }, inputs: { DO: { block: chain({ type: 'cpp_now_on', fields: { OUT: 'OUT4' } }, { type: 'cpp_now_sound', fields: { N: 2 } }) } } },
      { type: 'cpp_every', fields: { MS: 250 }, inputs: { DO: { block: inner } } });
    const code = generateSketch(load({ blocks: { languageVersion: 0, blocks: [{ type: 'cpp_loop', inputs: { DO: { block: body } } }] } }));
    expect(code).toContain(`void loop() {
  prop.update();
  if (prop.wasPressed(USER1)) {
    prop.turnOn(OUT4);
    prop.playSound(2);
  }
  static unsigned long every1 = 0;
  if (millis() - every1 >= 250) {
    every1 = millis();
    Serial.print("light:");
    Serial.println(analogRead(34));
    Serial.print("uptime:");
    Serial.println(millis());
  }
}`);
  });

  it('give the same sketch from the saved blocks (a hand edit does not match)', () => {
    const ws = load(STARTER);
    const code = generateSketch(ws);
    const saved = Blockly.serialization.workspaces.save(ws);
    expect(sketchFromSaved(JSON.parse(JSON.stringify(saved)))).toBe(code);
    expect(sketchFromSaved(saved)).not.toBe(code.replace('seconds(2)', 'seconds(3)'));
    expect(sketchFromSaved({ blocks: { blocks: [{ type: 'nope' }] } })).toBeNull();
  });
});
