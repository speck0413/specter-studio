// The show script's words, from one place: the firmware's shared module firmware/web/words.js (the checker's own
// tables, which the board's phone page colours its script with too). This file only gives that plain JavaScript
// module its TypeScript types, the way src/record/take.ts does for take.js.

// @ts-ignore the firmware's plain ES module has no type declarations; they are written out below
import * as shared from '../../firmware/firmware/web/words.js';

export const KEYWORDS: string[] = shared.KEYWORDS;
export const OUTPUTS: string[] = shared.OUTPUTS;
export const INPUTS: string[] = shared.INPUTS;
export const LEVELS: string[] = shared.LEVELS;
export const UNITS: string[] = shared.UNITS;
export const SETTINGS: string[] = shared.SETTINGS;
/** The pixel strip's effects (`pixels = chase red`), in the board's order. */
export const PIXEL_EFFECTS: string[] = shared.EFFECTS;
/** The named colours and their hex, `[['red', 'ff0000'], …, ['warm white', 'ffa040']]`. */
export const PIXEL_COLOURS: [string, string][] = shared.COLOURS;
/** A word's class: kw, out, in, lv (on/off), num (unit, time setting), fx (pixel effect, colour), '' (other). */
export const classOf: (word: string) => string = shared.classOf;

/** The effects that take no colour (`pixels = rainbow`): rainbow and fire have their own, off none (SHOW-SCRIPT.md SS-X2;
 * the board's scriptPixelColoured in script.h, whose checker rejects `pixels = fire red`). */
export const NO_COLOUR = ['off', 'rainbow', 'fire'];

/** A colour as written (`warm white`, `0xff8000`, any case and spacing) as six hex digits, or null. */
export function colourHex(c: string): string | null {
  const s = c.trim().toLowerCase().replace(/\s+/g, ' ');
  const named = PIXEL_COLOURS.find(([n]) => n === s);
  if (named) return named[1];
  const m = /^0x([0-9a-f]{6})$/.exec(s);
  return m ? m[1] : null;
}

/** `pixels = <rest>` read as the board reads it: an effect word first (if any), then a colour (if any). */
export function splitPixels(rest: string): { effect: string; colour: string } {
  const t = rest.trim();
  const m = /^(\S+)(\s+(.*))?$/.exec(t);
  if (m && PIXEL_EFFECTS.includes(m[1].toLowerCase())) return { effect: m[1], colour: (m[3] ?? '').trim() };
  return { effect: '', colour: t };
}
