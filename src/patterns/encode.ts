// A compiled pattern as the bytes a board stores and runs (the firmware's pattern_program.h reads the same layout,
// firmware/PROTOCOL.md "LED patterns"). Little endian:
//
//   0   4  "SPAT"
//   4   1  format (1)
//   5   1  flags (0)
//   6   2  code words
//   8   2  globals (the first is pixelCount)
//   10  2  functions
//   12  1  controls
//   13  1  0
//   14  8  entry functions: beforeRender, render, render2D, render3D (0xffff: none)
//   22     per function: start (2), parameters (1), values (1)
//          per control: kind (1: slider, hsvPicker, rgbPicker, toggle, trigger, inputNumber), function (2),
//          name length (1), name, label length (1), label (ASCII)
//          the code: 32-bit words
//
// No source, no line numbers and no names other than the controls' go to the board.

import { Control, ControlKind, PatternProgram } from './compile';
import { BOARD_LIMITS, PatternLimits } from './vm';

export const PROGRAM_FORMAT = 1;
export const CONTROL_KINDS: ControlKind[] = ['slider', 'hsvPicker', 'rgbPicker', 'toggle', 'trigger', 'inputNumber'];
const NONE = 0xffff;
const MAX_TEXT = 63;

/** The first reason this program does not fit a board, in plain words; null when it fits. */
export function boardFit(p: PatternProgram, limits: PatternLimits = BOARD_LIMITS): string | null {
  if (p.code.length > limits.code) return `the pattern is too big for a board (${p.code.length} code steps, at most ${limits.code})`;
  if (p.globals.length > limits.globals) return `the pattern has too many variables for a board (${p.globals.length}, at most ${limits.globals})`;
  if (p.functions.length > limits.functions) return `the pattern has too many functions for a board (${p.functions.length}, at most ${limits.functions})`;
  if (p.controls.length > limits.controls) return `the pattern has too many controls for a board (${p.controls.length}, at most ${limits.controls})`;
  for (const c of p.controls) {
    if (!/^[\x20-\x7e]*$/.test(c.name + c.label) || c.name.length > MAX_TEXT || c.label.length > MAX_TEXT) return `the control ${c.name} has a name a board cannot keep (plain letters, at most ${MAX_TEXT})`;
  }
  return null;
}

export function encodeProgram(p: PatternProgram): Uint8Array {
  const fit = boardFit(p, { ...BOARD_LIMITS, code: 0xffff, globals: 0xffff, functions: 0xffff, controls: 255 });
  if (fit) throw new Error(fit);
  const bytes: number[] = [];
  const u8 = (v: number) => bytes.push(v & 0xff);
  const u16 = (v: number) => { u8(v); u8(v >> 8); };
  const u32 = (v: number) => { u16(v & 0xffff); u16(v >>> 16); };
  const text = (s: string) => { u8(s.length); for (let i = 0; i < s.length; i++) u8(s.charCodeAt(i)); };
  for (const c of 'SPAT') u8(c.charCodeAt(0));
  u8(PROGRAM_FORMAT); u8(0);
  u16(p.code.length); u16(p.globals.length); u16(p.functions.length); u8(p.controls.length); u8(0);
  for (const k of ['beforeRender', 'render', 'render2D', 'render3D'] as const) u16(p.entry[k] ?? NONE);
  for (const f of p.functions) { u16(f.addr); u8(f.params); u8(f.locals); }
  for (const c of p.controls) { u8(CONTROL_KINDS.indexOf(c.kind)); u16(c.fn); text(c.name); text(c.label); }
  for (const w of p.code) u32(w | 0);
  return Uint8Array.from(bytes);
}

/** The bytes back as a program (no lines, no global or function names: what a board has). */
export function decodeProgram(b: Uint8Array): PatternProgram {
  let at = 0;
  const need = (n: number) => { if (at + n > b.length) throw new Error('the pattern bytes end too soon'); };
  const u8 = () => { need(1); return b[at++]; };
  const u16 = () => { const v = u8(); return v | (u8() << 8); };
  const i32 = () => { const lo = u16(); return (lo | (u16() << 16)) | 0; };
  const text = () => { const n = u8(); need(n); const s = String.fromCharCode(...b.slice(at, at + n)); at += n; return s; };
  if (String.fromCharCode(u8(), u8(), u8(), u8()) !== 'SPAT') throw new Error('these are not pattern bytes');
  if (u8() !== PROGRAM_FORMAT) throw new Error('pattern bytes of another format');
  u8();
  const nCode = u16(), nGlobals = u16(), nFunctions = u16(), nControls = u8();
  u8();
  const entry: PatternProgram['entry'] = {};
  for (const k of ['beforeRender', 'render', 'render2D', 'render3D'] as const) { const v = u16(); if (v !== NONE) entry[k] = v; }
  const functions = Array.from({ length: nFunctions }, (_, i) => ({ name: `f${i}`, addr: u16(), params: u8(), locals: u8() }));
  const controls: Control[] = Array.from({ length: nControls }, () => {
    const kind = CONTROL_KINDS[u8()], fn = u16(), name = text(), label = text();
    return { kind, fn, name, label };
  });
  const code = Array.from({ length: nCode }, () => i32());
  if (at !== b.length) throw new Error('the pattern bytes are longer than they say');
  return { format: 'specter-pattern', version: 1, code, lines: [], globals: Array.from({ length: nGlobals }, (_, i) => (i === 0 ? 'pixelCount' : `g${i}`)), functions, entry, controls, vars: [] };
}

export function toBase64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}
export function fromBase64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

/** A control's value as a board takes it: each part 16.16 (0 to 1 is 0 to 65536). */
export const fixedValues = (values: number[]) => values.map((x) => (Number.isFinite(x) ? Math.round(x * 65536) | 0 : 0));
