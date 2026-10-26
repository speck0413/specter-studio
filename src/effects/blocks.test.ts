/// <reference types="node" />
// Text -> blocks -> text gives the identical text (every block keeps its line as written).
import { describe, expect, it } from 'vitest';
import * as Blockly from 'blockly';
import fs from 'node:fs';
import path from 'node:path';
import { blockIdForLine, blocksToText, defineBlocks, parse, textToBlocks } from './blocks';

const ROOT = path.resolve(__dirname, '../..');
defineBlocks();

function scripts(): [string, string][] {
  const out: [string, string][] = [];
  const g = path.join(ROOT, 'firmware/firmware/show-script-golden/cases');
  for (const d of fs.readdirSync(g).sort()) out.push([d, fs.readFileSync(path.join(g, d, 'script.txt'), 'utf8')]);
  const ex = path.join(ROOT, 'firmware/firmware/show-script-examples');
  for (const f of fs.readdirSync(ex).filter((f) => f.endsWith('.txt')).sort()) out.push([f, fs.readFileSync(path.join(ex, f), 'utf8')]);
  out.push(['mixed line endings', 'effect a:\r\n  wait for trig1\n  out1 = on\r  sleep 1\n']);
  out.push(['no final newline', 'effect a:\n  wait for trig1\n  out1 = on']);
  out.push(['empty', '']);
  out.push(['icon and colour comments', '# The prop.\n# icon: splat\n# color: red\neffect fire:\n  wait for trig1\n  sleep 1\n\n# icon: drop\n# color: #1e88e5\neffect prime:  # the pump\n  wait for trig2\n']);
  out.push(['script look apart', '# icon: skull\n\n# icon: ghost\neffect a:\n  wait for trig1\n']);
  return out;
}

describe('effect script blocks', () => {
  const list = scripts();
  it('reads every golden case and example', () => expect(list.length).toBeGreaterThan(80));
  it.each(list)('round trip: %s', (_name, text) => {
    const ws = new Blockly.Workspace();
    textToBlocks(ws, text);
    expect(blocksToText(ws)).toBe(text);
    ws.dispose();
  });

  it('a changed block rewrites only its line (indentation and comment kept)', () => {
    const ws = new Blockly.Workspace();
    textToBlocks(ws, 'effect knock:   # the porch\n  wait for trig2\n  rly1 = on    # the prop button\n  sleep 3.\n  rly1 = off\n');
    ws.getAllBlocks(false).find((b) => b.type === 'ps_sleep')!.setFieldValue('5', 'TIME');
    ws.getAllBlocks(false).find((b) => b.type === 'ps_set')!.setFieldValue('50%', 'LEVEL');
    expect(blocksToText(ws)).toBe('effect knock:   # the porch\n  wait for trig2\n  rly1 = 50%    # the prop button\n  wait 5\n  rly1 = off\n');
    ws.dispose();
  });

  it('sorts lines into kinds', () => {
    expect(parse('  fade out1 to 0% over 3').type).toBe('ps_fade');
    expect(parse('OUT1 =ON').type).toBe('ps_set');
    expect(parse('waitfor trig1').type).toBe('ps_wait');
    expect(parse('hello there').type).toBe('ps_raw');
    // the advanced lines (the firmware's SHOW-SCRIPT.md), as the board's phone page reads them (web/blocks.js)
    expect(parse('  pulse cc1 for 200 ms').f).toEqual({ TARGET: 'cc1', TIME: '200 ms' });
    expect(parse('limit 3 runs per 3 min').f).toEqual({ RUNS: '3', TIME: '3 min' });
    expect(parse('audio_loop = off').type).toBe('ps_audio_loop');
  });

  it('a new advanced block writes its plain form', () => {
    const ws = new Blockly.Workspace();
    textToBlocks(ws, 'effect a:\n  wait for trig1\n  limit 3 runs per 60\n');
    ws.getAllBlocks(false).find((b) => b.type === 'ps_limit')!.setFieldValue('1', 'RUNS');
    expect(blocksToText(ws)).toBe('effect a:\n  wait for trig1\n  limit 1 run per 60\n');
    ws.dispose();
  });
});

describe('the tell block (SHOW-SCRIPT.md §11, the firmware\'s ps_tell)', () => {
  it('reads a tell line as the board does: the board, then an effect or a setting', () => {
    expect(parse('  tell porch blackout').f).toEqual({ BOARD: 'porch', DO: 'blackout' });
    expect(parse('  TELL  Front-Door   Porch Light  # its name has a space').f).toEqual({ BOARD: 'Front-Door', DO: 'Porch Light' });
    expect(parse('tell all pixel_speed = 150').f).toEqual({ BOARD: 'all', DO: 'pixel_speed = 150' });
    expect(parse('tell porch title: Hello Porch').type).toBe('ps_tell');
    // a line the board refuses in its form is a plain line (Check says why)
    expect(parse('tell porch=blackout').type).toBe('ps_raw');
    expect(parse('tell porch').type).toBe('ps_raw');
    expect(parse('tell').type).toBe('ps_raw');
  });
  it('a changed tell block writes its plain form; an unchanged one keeps its line', () => {
    const ws = new Blockly.Workspace();
    const text = 'effect a:\n  wait for trig1\n  tell  porch   blackout   # dark\n  tell all pixel_speed=150\n';
    textToBlocks(ws, text);
    expect(blocksToText(ws)).toBe(text);
    const tells = ws.getAllBlocks(true).filter((b) => b.type === 'ps_tell');
    expect(tells.map((b) => b.toString())).toEqual(['tell porch blackout', 'tell all pixel_speed=150']);
    tells[0].setFieldValue('bright', 'DO');
    tells[1].setFieldValue('front-door', 'BOARD');
    expect(blocksToText(ws)).toBe('effect a:\n  wait for trig1\n  tell porch bright   # dark\n  tell front-door pixel_speed=150\n');
    ws.dispose();
  });
  it('a new tell block from the toolbox writes a line the board takes', () => {
    const ws = new Blockly.Workspace();
    textToBlocks(ws, 'effect a:\n  wait for trig1\n');
    const effect = ws.getAllBlocks(false).find((b) => b.type === 'ps_effect')!;
    const wait = effect.getInputTargetBlock('LINES')!;
    const tell = ws.newBlock('ps_tell');
    wait.nextConnection!.connect(tell.previousConnection!);
    expect(blocksToText(ws)).toBe('effect a:\n  wait for trig1\n  tell porch blackout\n');
    ws.dispose();
  });
});

describe('blank lines in the blocks view', () => {
  const text = '\n\neffect a:\n  wait for trig1\n\n  out1 = on\n  \n\n  # note\n  sleep 1\n\n';
  it('makes no block for a blank line', () => {
    const ws = new Blockly.Workspace();
    textToBlocks(ws, text);
    const types = ws.getAllBlocks(true).map((b) => b.type);
    expect(types).toEqual(['ps_effect', 'ps_wait', 'ps_set', 'ps_comment', 'ps_sleep']);
    ws.dispose();
  });
  it('keeps the text unchanged, also after a block is changed', () => {
    const ws = new Blockly.Workspace();
    textToBlocks(ws, text);
    expect(blocksToText(ws)).toBe(text);
    ws.getAllBlocks(false).find((b) => b.type === 'ps_set')!.setFieldValue('50%', 'LEVEL');
    expect(blocksToText(ws)).toBe(text.replace('out1 = on', 'out1 = 50%'));
    ws.dispose();
  });
  it('a script of only blank lines still comes back', () => {
    const ws = new Blockly.Workspace();
    textToBlocks(ws, '\n \n');
    expect(blocksToText(ws)).toBe('\n \n');
    ws.dispose();
  });
});

describe('sound blocks in plain words', () => {
  it('say "play sound" and "stop the sound", and still write the script words', () => {
    const ws = new Blockly.Workspace();
    const text = 'effect a:\n  audio_single = 1\n  audio_loop = 2\n  audio_stop\n';
    textToBlocks(ws, text);
    const shown = ws.getAllBlocks(true).map((b) => b.toString()).join(' | ');
    expect(shown).toContain('play sound 1 once');
    expect(shown).toContain('play sound 2 over and over');
    expect(shown).toContain('stop the sound');
    expect(shown).not.toMatch(/audio_/);
    expect(blocksToText(ws)).toBe(text);
  });
});

describe('the block for a line (a clicked checker message)', () => {
  it('finds the block that holds each line, blank lines with the block before them', () => {
    const ws = new Blockly.Workspace();
    textToBlocks(ws, '# top\neffect a:\n  wait for trig1\n\n  out1 = on\n  rly1 = 50%\n');
    const text = (line: number) => { const id = blockIdForLine(ws, line); return id ? ws.getBlockById(id)!.type : null; };
    expect(text(1)).toBe('ps_comment');
    expect(text(2)).toBe('ps_effect');
    expect(text(3)).toBe('ps_wait');
    expect(text(4)).toBe('ps_wait');
    expect(text(5)).toBe('ps_set');
    expect(blockIdForLine(ws, 6)).not.toBe(blockIdForLine(ws, 5));
    expect(blockIdForLine(ws, 99)).toBeNull();
  });
});

// An effect may start with any line (SHOW-SCRIPT.md SS-R1): lines above its first "wait for" (a background sound),
// several "wait for" lines, or none at all (it goes round by itself). The blocks hold any of them.
describe('effects that do not start with a wait for', () => {
  const AMBIENT = 'effect haunt:\n  audio_loop = 1\n  out1 = 15%\n  wait for trig1\n  audio_single = 2\n  out1 = on\n  wait 5\n\neffect candle:\n  out2 = 40%\n  flicker out2 for 3\n  wait 1\n';
  it('the ambient example goes text -> blocks -> text unchanged, its lines in order', () => {
    const ws = new Blockly.Workspace();
    textToBlocks(ws, AMBIENT);
    expect(ws.getAllBlocks(true).map((b) => b.type)).toEqual(['ps_effect', 'ps_audio_loop', 'ps_set', 'ps_wait', 'ps_audio_single', 'ps_set', 'ps_sleep',
      'ps_effect', 'ps_set', 'ps_flicker', 'ps_sleep']);
    expect(blocksToText(ws)).toBe(AMBIENT);
    ws.dispose();
  });
  it('an effect built from blocks needs no wait for block', () => {
    const ws = new Blockly.Workspace();
    const e = ws.newBlock('ps_effect');
    e.setFieldValue('candle', 'NAME');
    const set = ws.newBlock('ps_set');
    set.setFieldValue('out2', 'TARGET');
    set.setFieldValue('on', 'LEVEL');
    const fl = ws.newBlock('ps_flicker');
    fl.setFieldValue('out2', 'TARGET');
    e.getInput('LINES')!.connection!.connect(set.previousConnection!);
    set.nextConnection!.connect(fl.previousConnection!);
    expect(blocksToText(ws)).toBe('effect candle:\n  out2 = on\n  flicker out2 for 3\n');
    ws.dispose();
  });
  it('a wait for block moved below the lines: they become the lines above it', () => {
    const ws = new Blockly.Workspace();
    textToBlocks(ws, 'effect haunt:\n  wait for trig1\n  audio_loop = 1\n');
    const wait = ws.getAllBlocks(true).find((b) => b.type === 'ps_wait')!;
    const loop = ws.getAllBlocks(true).find((b) => b.type === 'ps_audio_loop')!;
    const effect = ws.getAllBlocks(true).find((b) => b.type === 'ps_effect')!;
    loop.unplug();
    wait.unplug();
    effect.getInput('LINES')!.connection!.connect(loop.previousConnection!);
    loop.nextConnection!.connect(wait.previousConnection!);
    expect(blocksToText(ws)).toBe('effect haunt:\n  audio_loop = 1\n  wait for trig1\n');
    ws.dispose();
  });
});
