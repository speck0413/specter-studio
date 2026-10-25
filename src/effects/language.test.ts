import { describe, expect, it } from 'vitest';
import { hoverFor, indentFix, markersFromCheck } from './language';
import { completionsAt } from './completions';

describe('effect script language helpers', () => {
  it('hover help in plain words', () => {
    expect(hoverFor('EFFECT')).toMatch(/Starts an effect/);
    expect(hoverFor('rly1')).toMatch(/on or off only/i);
    expect(hoverFor('dmx12')).toMatch(/DMX channel 12/);
    expect(hoverFor('seconds')).toBe(hoverFor('s'));
    expect(hoverFor('banana')).toBeNull();
  });
  it('completion at the start of a line: every kind of line, and setting each output', () => {
    const labels = completionsAt('  ').map((c) => c.label);
    for (const l of ['effect', 'wait for', 'wait', 'fade', 'flicker', 'audio_single', 'audio_loop', 'audio_stop', 'out4 =', 'cc2 =']) expect(labels).toContain(l);
    expect(labels).not.toContain('sleep');
    expect(completionsAt('').find((c) => c.label === 'fade')!.insert).toBe('fade ${1:out1} to ${2:0%} over ${3:2}');
  });
  it('the advanced lines: help, completion and the settings a line may name', () => {
    expect(hoverFor('effect')).toMatch(/take turns/);
    expect(hoverFor('audio_loop')).toMatch(/audio_loop = off/);
    expect(hoverFor('limit')).toMatch(/window that starts at the first run/);
    expect(hoverFor('pulse')).toMatch(/off after the time/);
    expect(hoverFor('out1_on_ms')).toMatch(/a time in milliseconds/);
    expect(hoverFor('runs_per_cooldown')).toMatch(/a number of runs/);
    const labels = completionsAt('').map((c) => c.label);
    for (const l of ['audio_loop = off', 'limit', 'pulse']) expect(labels).toContain(l);
    expect(completionsAt('  sleep ').map((c) => c.label)).toContain('cooldown_ms');
    for (const l of ['wait for … or remote', 'takes turns with']) expect(labels).not.toContain(l);
  });
  it('turns the board checker answer into markers', () => {
    const model = { getLineCount: () => 5, getLineMaxColumn: (l: number) => 10 + l };
    const m = markersFromCheck({ ok: false, errors: [{ line: 3, message: 'line 3: bad' }, { line: 0, message: 'the script has 9 effects. A board runs at most 8.' }], warnings: [{ line: 1, message: 'line 1: still on' }] }, model);
    expect(m).toEqual([
      { severity: 8, message: 'line 3: bad', startLineNumber: 3, startColumn: 1, endLineNumber: 3, endColumn: 13 },
      { severity: 8, message: 'the script has 9 effects. A board runs at most 8.', startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 11 },
      { severity: 4, message: 'line 1: still on', startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 11 },
    ]);
    expect(markersFromCheck({ errors: [{ line: 99, message: 'x' }], warnings: [] }, model)[0].startLineNumber).toBe(5);
  });
});

describe('typing line by line never makes a staircase', () => {
  it('a line is indented two spaces at most', () => {
    expect(indentFix('    ')).toBe('  ');
    expect(indentFix('   ')).toBe('  ');
    expect(indentFix('      out1 = on')).toBe('  out1 = on');
    expect(indentFix('\tsleep 2')).toBe('  sleep 2');
    expect(indentFix('  out1 = on')).toBeNull();
    expect(indentFix('effect porch:')).toBeNull();
    expect(indentFix('')).toBeNull();
  });
});

describe('sounds are numbers', () => {
  it('sound blocks default to a number, the volume block too, and no block, hover or help names a file except the card layout', async () => {
    const { defineBlocks, textToBlocks, blocksToText } = await import('./blocks');
    const Blockly = await import('blockly');
    defineBlocks();
    for (const t of ['ps_audio_single', 'ps_audio_loop']) {
      const ws = new Blockly.Workspace();
      const b = ws.newBlock(t);
      expect(b.getFieldValue('SOUND')).toMatch(/^\d+$/);
      ws.dispose();
    }
    const ws = new Blockly.Workspace();
    textToBlocks(ws, 'effect a:\n  wait for trig1\n  audio_volume = 40%\n');
    expect(ws.getAllBlocks(false).some((b) => b.type === 'ps_audio_volume' && b.getFieldValue('VOLUME') === '40%')).toBe(true);
    expect(blocksToText(ws)).toBe('effect a:\n  wait for trig1\n  audio_volume = 40%\n');
    const texts: string[] = [];
    for (const t of Object.keys(Blockly.Blocks).filter((k) => k.startsWith('ps_'))) {
      const b = ws.newBlock(t);
      texts.push(String(b.tooltip ?? ''), ...b.inputList.flatMap((i) => i.fieldRow.map((f) => String(f.getText()))));
    }
    ws.dispose();
    for (const w of ['audio_single', 'audio_loop', 'audio_volume', 'audio_stop', 'wait', 'sleep']) texts.push(hoverFor(w) ?? '');
    for (const t of texts) for (const m of t.match(/\S*\.mp3/g) || []) expect(m).toMatch(/^(mp3\/)?([0-9N]{4})-(…|<description>)\.mp3[.,]?$/);
  });
});
