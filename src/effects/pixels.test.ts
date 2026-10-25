// The pixel strip line, `pixels = <effect> <colour>` (firmware SHOW-SCRIPT.md SS-X): its words come from the
// firmware's words.js, and the blocks, typeahead, C++ export and help read it as the board does.
import { describe, expect, it } from 'vitest';
import * as Blockly from 'blockly';
import { blocksToText, defineBlocks, parse, textToBlocks } from './blocks';
import { completionsAt } from './completions';
import { pixelStep, scriptToCpp } from './cppgen';
import { hoverFor } from './language';
import { colourHex, KEYWORDS, PIXEL_COLOURS, PIXEL_EFFECTS, splitPixels } from './words';

defineBlocks();
const load = (text: string) => { const ws = new Blockly.Workspace(); textToBlocks(ws, text); return ws; };
const pixels = (ws: Blockly.Workspace) => ws.getAllBlocks(false).find((b) => b.type === 'ps_pixels')!;
const menu = (b: Blockly.Block, f: string) => (b.getField(f) as Blockly.FieldDropdown).getOptions(false).map(([t, v]) => [t, v]);

describe('the words come from the firmware', () => {
  it('has the pixel line, effects and colours', () => {
    expect(KEYWORDS).toContain('pixels');
    expect(PIXEL_EFFECTS).toEqual(['off', 'fill', 'chase', 'rainbow', 'flash', 'fade', 'flicker', 'comet', 'sparkle', 'breathe', 'fire']);
    expect(PIXEL_COLOURS.map(([n]) => n)).toContain('warm white');
  });
  it('reads colours and lines as the board does', () => {
    expect(colourHex('Warm   White')).toBe('ffa040');
    expect(colourHex('0xFF8000')).toBe('ff8000');
    expect(colourHex('#ff8000')).toBeNull();
    expect(splitPixels(' Sparkle   Warm White')).toEqual({ effect: 'Sparkle', colour: 'Warm White' });
    expect(splitPixels('warm white')).toEqual({ effect: '', colour: 'warm white' });
  });
});

describe('the light the pixels block', () => {
  it('reads every form of the line', () => {
    expect(parse('  pixels = chase red').f).toEqual({ EFFECT: 'chase', COLOUR: 'red' });
    expect(parse('  PIXELS : Sparkle   Warm White').type).toBe('ps_pixels');
    expect(parse('  pixels = 0x00ff80').f).toEqual({ EFFECT: '', COLOUR: '0x00ff80' });
    expect(parse('  pixels red').type).toBe('ps_raw');
    expect(parse('  pixel = blue').type).toBe('ps_set');
  });
  it('round trips exactly, also lines the board refuses', () => {
    const text = 'effect a:\n  PIXELS : Sparkle   Warm White   # sparkle\n  pixels =\n  pixels = glow red\n  pixels = rainbow\n  wait for trig1\n';
    expect(blocksToText(load(text))).toBe(text);
  });
  it('picks an effect and a colour from lists, as written', () => {
    const ws = load('effect a:\n  wait for trig1\n  pixels = Chase Warm White\n');
    const b = pixels(ws);
    expect(menu(b, 'EFFECT').map(([, v]) => v)).toEqual(['off', 'fill', 'Chase', 'rainbow', 'flash', 'fade', 'flicker', 'comet', 'sparkle', 'breathe', 'fire', '']);
    expect(menu(b, 'COLOUR').map(([t]) => t)).toEqual(['no colour (white)', 'red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple', 'pink', 'white', 'warm white', 'exact colour…']);
    expect(b.getField('COLOUR')!.getText()).toBe('warm white');
    b.setFieldValue('comet', 'EFFECT');
    b.setFieldValue('0xff2000', 'COLOUR');
    expect(blocksToText(ws)).toBe('effect a:\n  wait for trig1\n  pixels = comet 0xff2000\n');
    expect(b.getField('COLOUR')!.getText()).toBe('0xff2000');
    b.setFieldValue('', 'EFFECT');
    b.setFieldValue('blue', 'COLOUR');
    expect(blocksToText(ws)).toBe('effect a:\n  wait for trig1\n  pixels = blue\n');
    b.setFieldValue('rainbow', 'EFFECT');
    b.setFieldValue('', 'COLOUR');
    expect(menu(b, 'COLOUR')[0][0]).toBe('its own colours');
    expect(blocksToText(ws)).toBe('effect a:\n  wait for trig1\n  pixels = rainbow\n');
  });
  it('offers no colour after an effect that takes none: rainbow and fire have their own, off none', () => {
    const ws = load('effect a:\n  wait for trig1\n  pixels = chase red\n');
    const b = pixels(ws);
    expect(menu(b, 'COLOUR').length).toBe(PIXEL_COLOURS.length + 2);
    for (const [effect, only] of [['fire', 'its own colours'], ['Rainbow', 'its own colours'], ['off', 'no colour (dark)']]) {
      b.setFieldValue(effect, 'EFFECT');
      b.setFieldValue('', 'COLOUR');
      expect(menu(b, 'COLOUR')).toEqual([[only, '']]);
      expect(b.getField('COLOUR')!.getText()).toBe(only);
    }
    // a colour written after one is kept as written and marked, as the board's checker says it
    const text = 'effect a:\n  pixels = fire red\n  pixels = rainbow 0x00ff80\n';
    const ws2 = load(text);
    const [fire, rainbow] = ws2.getAllBlocks(true).filter((x) => x.type === 'ps_pixels');
    expect(fire.getField('COLOUR')!.getText()).toBe('red (fire takes no colour)');
    expect(rainbow.getField('COLOUR')!.getText()).toBe('0x00ff80 (rainbow takes no colour)');
    expect(blocksToText(ws2)).toBe(text);
    // the colour's words follow the effect
    fire.setFieldValue('chase', 'EFFECT');
    expect(fire.getField('COLOUR')!.getText()).toBe('red');
  });
  it('marks what it does not know, and keeps it', () => {
    // the board reads a first word that is no effect as a colour
    const b = pixels(load('effect a:\n  pixels = glow reddish\n'));
    expect(b.getField('EFFECT')!.getText()).toBe('colour only (fills the strip)');
    expect(b.getField('COLOUR')!.getText()).toBe('glow reddish (not a colour)');
    expect(pixels(load('effect a:\n  pixels = chase reddish\n')).getField('COLOUR')!.getText()).toBe('reddish (not a colour)');
  });
});

describe('typeahead after pixels =', () => {
  it('offers the line, then effects and colours, then colours', () => {
    expect(completionsAt('  pix').map((c) => c.label)).toContain('pixels');
    const first = completionsAt('  pixels = ');
    expect(first.slice(0, 11).map((c) => c.label)).toEqual(PIXEL_EFFECTS);
    expect(first.map((c) => c.label)).toContain('warm white');
    expect(first.find((c) => c.label === 'chase')).toMatchObject({ insert: 'chase ', retrigger: true });
    expect(first.find((c) => c.label === 'rainbow')).toMatchObject({ insert: 'rainbow', retrigger: false });
    const colours = completionsAt('  pixels = chase ');
    expect(colours.map((c) => c.label)).toEqual([...PIXEL_COLOURS.map(([n]) => n), 'exact colour']);
    expect(colours.at(-1)).toMatchObject({ insert: '0x${1:ff8000}', snippet: true });
    expect(completionsAt('  pixels = rainbow ')).toEqual([]);
    // no colours after an effect that takes none (SS-X2: rainbow and fire have their own, off none), in any case
    for (const e of ['fire', 'Fire', 'rainbow', 'off', 'OFF']) {
      expect(completionsAt(`  pixels = ${e} `)).toEqual([]);
      expect(completionsAt(`  pixels: ${e} `)).toEqual([]);
    }
    expect(completionsAt('  pixels = Breathe ').map((c) => c.label)).toContain('warm white');
    // never the levels of an output
    expect(first.map((c) => c.label)).not.toContain('on');
  });
});

describe('C++ export', () => {
  it('maps each effect to the library pixel step, or a comment', () => {
    expect(pixelStep(' chase red')).toBe('.chasePixels(rgb(255, 0, 0), milliseconds(60))');
    expect(pixelStep(' warm white')).toBe('.setPixels(rgb(255, 160, 64))');
    expect(pixelStep(' fill')).toBe('.setPixels(rgb(255, 255, 255))');
    expect(pixelStep(' off')).toBe('.pixelsOff()');
    expect(pixelStep(' rainbow')).toBe('.rainbowPixels(milliseconds(5000))');
    expect(pixelStep(' flash 0x00ff80')).toBe('.flashPixels(rgb(0, 255, 128), milliseconds(600))');
    expect(pixelStep(' fade blue')).toBe('.fadeInPixels(rgb(0, 0, 255), milliseconds(2000))');
    expect(pixelStep(' flicker orange')).toBe('.flickerPixels(rgb(255, 96, 0))');
    expect(pixelStep(' comet red')).toBeNull();
    const cpp = scriptToCpp('effect a:\n  pixels = breathe purple\n  wait for trig1\n  pixels = chase red\n  pixels = fire\n');
    expect(cpp).toContain('// not available in the C++ beginner layer (above the first wait for): pixels = breathe purple');
    expect(cpp).toContain('.chasePixels(rgb(255, 0, 0), milliseconds(60))');
    expect(cpp).toContain('// not available in the C++ beginner layer: pixels = fire');
  });
});

describe('help', () => {
  it('explains the line, links to LED patterns, and knows the colours', () => {
    expect(hoverFor('pixels')).toMatch(/\[LED pattern\]\(command:specter\.openPatterns\)/);
    expect(hoverFor('comet')).toMatch(/fading tail/);
    expect(hoverFor('warm')).toMatch(/warm white/);
    expect(hoverFor('0xff8000')).toMatch(/red 255, green 128, blue 0/);
  });
});
