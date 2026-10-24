// The blocks pick from lists (inputs, outputs, levels, sounds, times) and still give the text back exactly.
import { afterEach, describe, expect, it } from 'vitest';
import * as Blockly from 'blockly';
import { blocksToText, defineBlocks, textToBlocks } from './blocks';
import { levelFollowsTarget, readTime, writeTime } from './fields';
import { defaultTerms, setTerms, soundList, termsFor } from './terms';

defineBlocks();
const board = termsFor(
  { inputs: ['TRIG1', 'TRIG2'], channels: ['OUT1', 'OUT2', 'RLY1', 'CC1'], terminals: [{ id: 'TRIG1', kind: 'input', label: 'bell' }, { id: 'OUT1', kind: 'output', alias: 'LAMP' }] },
  { aliases: [{ alias: 'valve_time', key: 'out1_on_ms' }] },
  soundList({ '0001-chime.mp3': 1, '0002-rain.mp3': 2 }),
);
afterEach(() => setTerms(defaultTerms()));

function load(text: string) {
  const ws = new Blockly.Workspace();
  textToBlocks(ws, text);
  return ws;
}
const block = (ws: Blockly.Workspace, type: string) => ws.getAllBlocks(false).find((b) => b.type === type)!;
const menu = (ws: Blockly.Workspace, type: string, field: string) => (block(ws, type).getField(field) as Blockly.FieldDropdown).getOptions(false).map(([t, v]) => [t, v]);
const shownText = (ws: Blockly.Workspace, type: string, field: string) => block(ws, type).getField(field)!.getText();
const tick = () => new Promise((r) => setTimeout(r, 50));

describe('block fields are dropdowns', () => {
  it('wait for: the inputs, by their names with the terminal beside them', () => {
    setTerms(board);
    const ws = load('effect a:\n  wait for TRIG1\n');
    expect(menu(ws, 'ps_wait', 'INPUT')).toEqual([['bell (trig1)', 'TRIG1'], ['trig2', 'trig2']]);
    expect(shownText(ws, 'ps_wait', 'INPUT')).toBe('bell (trig1)');
    expect(blocksToText(ws)).toBe('effect a:\n  wait for TRIG1\n');
  });
  it('a name the board does not have stays, marked', () => {
    setTerms(board);
    const ws = load('effect a:\n  wait for doorbell\n  porch = on\n');
    expect(shownText(ws, 'ps_wait', 'INPUT')).toBe('doorbell (not on this board)');
    expect(shownText(ws, 'ps_set', 'TARGET')).toBe('porch (not on this board)');
    expect(blocksToText(ws)).toBe('effect a:\n  wait for doorbell\n  porch = on\n');
    setTerms(defaultTerms());
    expect(shownText(ws, 'ps_wait', 'INPUT')).toBe('doorbell (unknown name)');
  });
  it('outputs: fade and flicker list only what dims, set and pulse list all', () => {
    const ws = load('effect a:\n  wait for trig1\n  out1 = on\n  fade out2 to 0% over 2\n  flicker out3 for 1\n  pulse cc1 for 200 ms\n');
    const ids = (type: string) => menu(ws, type, 'TARGET').map(([, v]) => v);
    expect(ids('ps_set')).toEqual(['out1', 'out2', 'out3', 'out4', 'rly1', 'rly2', 'cc1', 'cc2', '\u0000dmx']);
    expect(ids('ps_pulse')).toEqual(['out1', 'out2', 'out3', 'out4', 'rly1', 'rly2', 'cc1', 'cc2', '\u0000dmx']);
    expect(ids('ps_fade')).toEqual(['out1', 'out2', 'out3', 'out4', '\u0000dmx']);
    expect(ids('ps_flicker')).toEqual(['out1', 'out2', 'out3', 'out4', '\u0000dmx']);
  });
  it('the level: on, off and level… for an output that dims; on and off for a relay', () => {
    const ws = load('effect a:\n  wait for trig1\n  out1 = 50%\n  rly1 = on\n');
    const sets = ws.getAllBlocks(false).filter((b) => b.type === 'ps_set');
    const opts = (b: Blockly.Block) => (b.getField('LEVEL') as Blockly.FieldDropdown).getOptions(false).map(([t]) => t);
    expect(opts(sets[0])).toEqual(['50%', 'on', 'off', 'level…']);
    expect(opts(sets[1])).toEqual(['on', 'off']);
  });
  it('sounds: the list when known, plain otherwise', () => {
    const text = 'effect a:\n  audio_single = 2\n  audio_loop = OFF\n  wait for trig1\n  audio_single = 7\n';
    let ws = load(text);
    expect(menu(ws, 'ps_audio_single', 'SOUND')).toEqual([['2', '2'], ['another number…', '\u0000number']]);
    setTerms(board);
    ws = load(text);
    // "N · description", the value always the number
    expect(menu(ws, 'ps_audio_single', 'SOUND')).toEqual([['1 · chime', '1'], ['2 · rain', '2'], ['another number…', '\u0000number']]);
    expect(menu(ws, 'ps_audio_loop', 'SOUND').map(([t]) => t)).toEqual(['OFF', '1 · chime', '2 · rain', 'another number…']);
    const last = ws.getAllBlocks(false).filter((b) => b.type === 'ps_audio_single')[1];
    expect(last.getField('SOUND')!.getText()).toBe('7 (not in the sound list)');
    expect(blocksToText(ws)).toBe(text);
    // a file name from an older script stays, marked
    ws = load('effect a:\n  audio_single = chime.mp3\n');
    expect(block(ws, 'ps_audio_single').getField('SOUND')!.getText()).toBe('chime.mp3 (not a sound number)');
  });
  it('times show their unit, settings by name', () => {
    setTerms(board);
    const ws = load('effect a:\n  wait for trig1\n  sleep 2.5\n  pulse cc1 for valve_time\n  limit runs_per_cooldown runs per 3 min\n');
    expect(shownText(ws, 'ps_sleep', 'TIME')).toBe('2.5 s ▾');
    expect(shownText(ws, 'ps_pulse', 'TIME')).toBe('valve_time ▾');
    expect(shownText(ws, 'ps_limit', 'RUNS')).toBe('runs_per_cooldown ▾');
    expect(shownText(ws, 'ps_limit', 'TIME')).toBe('3 min ▾');
    expect(readTime('200 ms')).toEqual({ n: '200', unit: 'ms' });
    expect(readTime('3 minutes')).toEqual({ n: '3', unit: 'min' });
    expect(readTime('cooldown_ms')).toEqual({ setting: 'cooldown_ms' });
    expect(writeTime('2', 's')).toBe('2');
    expect(writeTime('200', 'ms')).toBe('200 ms');
  });
  it('the time block reads "wait"', () => {
    const ws = load('effect a:\n  wait for trig1\n  sleep 1\n');
    expect(block(ws, 'ps_sleep').toString()).toMatch(/^wait 1 s/);
  });
});

describe('choosing from the lists writes the plain line', () => {
  it('a chosen input, output, level and time', () => {
    const ws = load('effect a:\n  wait for trig1\n  out1 = on\n  sleep 1\n');
    block(ws, 'ps_wait').setFieldValue('trig2', 'INPUT');
    block(ws, 'ps_set').setFieldValue('out3', 'TARGET');
    block(ws, 'ps_set').setFieldValue('50%', 'LEVEL');
    block(ws, 'ps_sleep').setFieldValue('200 ms', 'TIME');
    expect(blocksToText(ws)).toBe('effect a:\n  wait for trig2\n  out3 = 50%\n  wait 200 ms\n');
  });
  it('an output changed to a relay: a percentage becomes on (above 0) or off, with a note', async () => {
    const ws = load('effect a:\n  wait for trig1\n  out1 = 50%\n  out2 = 0%\n');
    ws.addChangeListener(levelFollowsTarget(ws));
    const [a, b] = ws.getAllBlocks(false).filter((x) => x.type === 'ps_set');
    a.setFieldValue('rly1', 'TARGET');
    b.setFieldValue('cc1', 'TARGET');
    await tick();
    expect(blocksToText(ws)).toBe('effect a:\n  wait for trig1\n  rly1 = on\n  cc1 = off\n');
    expect((a as any).levelNote).toBe('rly1 is on or off only, so 50% became on.');
    // the note goes with the next change
    a.setFieldValue('off', 'LEVEL');
    await tick();
    expect((a as any).levelNote).toBeNull();
  });
  it('loading text never changes it (a relay at 50% stays for Check to explain)', async () => {
    const text = 'effect a:\n  wait for trig1\n  rly1 = 50%\n';
    const ws = new Blockly.Workspace();
    ws.addChangeListener(levelFollowsTarget(ws));
    textToBlocks(ws, text);
    await tick();
    expect(blocksToText(ws)).toBe(text);
  });
});
