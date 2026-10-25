// LED patterns from a script and to a board: the pattern and press lines in the blocks and the typeahead, what
// Studio sends (put_pattern) and what it refuses before sending.
import { afterEach, describe, expect, it } from 'vitest';
import * as Blockly from 'blockly';
import { blocksToText, defineBlocks, parse, textToBlocks } from '../effects/blocks';
import { completionsAt } from '../effects/completions';
import { scriptToCpp } from '../effects/cppgen';
import { defaultTerms } from '../effects/terms';
import { compilePattern } from './compile';
import { decodeProgram, fromBase64 } from './encode';
import { EXAMPLE_PATTERNS } from './examples';
import { boardNameProblem, boardPatterns, buttonsFor, buttonsOf, mergeKnown, setKnownPatterns, setScriptText } from './known';
import { preparePattern } from './send';

defineBlocks();
const PUZZLE = EXAMPLE_PATTERNS.find((x) => x.title === 'clue puzzle')!.text;
const load = (text: string) => { const ws = new Blockly.Workspace(); textToBlocks(ws, text); return ws; };
const known = [
  { name: 'clue puzzle', buttons: ['clue1', 'clue2', 'reset'], where: 'board' as const },
  { name: 'rainbow', buttons: [], where: 'library' as const },
];
afterEach(() => { setKnownPatterns([]); setScriptText(''); });

describe('the pattern lines in a script', () => {
  it('are blocks that round trip exactly', () => {
    expect(parse('  pixels = pattern Clue Puzzle').f).toEqual({ EFFECT: 'pattern', COLOUR: 'Clue Puzzle' });
    expect(parse('  PIXELS PRESS   Clue5').f).toEqual({ BUTTON: 'Clue5' });
    expect(parse('  pixels press').type).toBe('ps_raw');
    const text = 'effect a:\n  pixels = pattern clue puzzle\n  wait for trig1\n  PIXELS PRESS   Clue5  # a press\n  pixels press reset\n';
    expect(blocksToText(load(text))).toBe(text);
  });
  it('offer the board\'s patterns and their buttons in the menus', () => {
    setKnownPatterns(known);
    setScriptText('effect a:\n  pixels = pattern clue puzzle\n');
    const ws = load('effect a:\n  pixels = pattern clue puzzle\n  wait for trig1\n  pixels press clue2\n');
    const px = ws.getAllBlocks(false).find((b) => b.type === 'ps_pixels')!;
    const pr = ws.getAllBlocks(false).find((b) => b.type === 'ps_press')!;
    const opts = (b: Blockly.Block, f: string) => (b.getField(f) as Blockly.FieldDropdown).getOptions(false).map(([t, v]) => [t, v]);
    expect(opts(px, 'COLOUR').map(([, v]) => v).slice(0, 2)).toEqual(['clue puzzle', 'rainbow']);
    expect(opts(pr, 'BUTTON').map(([, v]) => v).slice(0, 3)).toEqual(['clue1', 'clue2', 'reset']);
    pr.setFieldValue('reset', 'BUTTON');
    expect(blocksToText(ws)).toContain('  pixels press reset\n');
  });
  it('are typed with help: the patterns after "pattern", the buttons after "pixels press"', () => {
    const t = defaultTerms();
    expect(completionsAt('  pixels = ', t, [], known).map((c) => c.label)).toContain('pattern');
    expect(completionsAt('  pixels = pattern ', t, [], known).map((c) => c.label)).toEqual(['clue puzzle', 'rainbow']);
    expect(completionsAt('  pixels press ', t, [], known, 'effect a:\n  pixels = pattern clue puzzle\n').map((c) => c.label)).toEqual(['clue1', 'clue2', 'reset']);
  });
  it('are comments in the C++ export (the beginner layer has no pattern step)', () => {
    const cpp = scriptToCpp('effect a:\n  wait for trig1\n  pixels = pattern ghost\n  pixels press flash\n  out1 = on\n');
    expect(cpp).toContain('not available in the C++ beginner layer: pixels = pattern ghost');
    expect(cpp).toContain('not available in the C++ beginner layer: pixels press flash');
  });
});

describe('the known patterns', () => {
  it('come from a board\'s list and the library, the board\'s first', () => {
    const b = boardPatterns([{ name: 'Clue  Puzzle', buttons: ['clue1'] }]);
    expect(b).toEqual([{ name: 'clue puzzle', buttons: ['clue1'], where: 'board' }]);
    expect(mergeKnown(b, [{ name: 'clue puzzle', buttons: [], where: 'library' }, { name: 'x', buttons: [], where: 'library' }]).map((p) => p.where)).toEqual(['board', 'library']);
    expect(buttonsOf(PUZZLE)).toEqual(['clue1', 'clue2', 'clue3', 'clue4', 'clue5', 'clue6', 'reset']);
    expect(buttonsFor('pixels = pattern rainbow', known)).toEqual([]);
  });
  it('have names a board keeps, or a plain reason', () => {
    expect(boardNameProblem('clue puzzle (2)')).toBeNull();
    expect(boardNameProblem('ghost #1')).toMatch(/letters, digits, spaces and - _ \( \)/);
    expect(boardNameProblem('x'.repeat(33))).toMatch(/at most 32 characters/);
  });
});

describe('sending a pattern', () => {
  it('sends the program\'s bytes and the preview\'s control values (16.16), not the buttons', () => {
    const src = 'export var s = 0\nexport function sliderSpeed(v) { s = v }\nexport function triggerGo() {}\nexport function render(i) { hsv(s, 1, 1) }';
    const p = preparePattern('my pattern', src, { sliderSpeed: [0.5], triggerGo: [] }, 60);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.req.op).toBe('put_pattern');
    expect(p.req.name).toBe('my pattern');
    expect(p.req.controls).toEqual({ sliderSpeed: [32768] });
    expect(decodeProgram(fromBase64(p.req.program as string)).code).toEqual(compilePattern(src).code);
    expect(p.buttons).toEqual(['go']);
  });
  it('refuses plainly what the board would refuse or stop', () => {
    expect(preparePattern('ghost#1', PUZZLE, {}, 60)).toMatchObject({ ok: false });
    expect(preparePattern('x', 'export function render(i) {', {}, 60)).toMatchObject({ ok: false, message: expect.stringMatching(/does not compile/) });
    // fine at 16 lights, too many steps a frame at 600
    const heavy = 'export function render(i) { var s = 0; for (var k = 0; k < 40; k++) s += k; rgb(s, 0, 0) }';
    expect(preparePattern('heavy', heavy, {}, 16).ok).toBe(true);
    expect(preparePattern('heavy', heavy, {}, 600)).toMatchObject({ ok: false, message: expect.stringMatching(/with 600 lights it would stop: the pattern took too long/) });
  });
});
