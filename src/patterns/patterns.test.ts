import { describe, expect, it } from 'vitest';
import { compilePattern, FIX, PatternError, programText } from './compile';
import { fdiv, fmul, PatternVM, runFrames } from './vm';
import { EXAMPLE_PATTERNS, STARTER_PATTERN } from './examples';
import { cleanPatternName, parseEpe } from './epe';
import * as fx from './fixed';
import { boardFit, decodeProgram, encodeProgram, fixedValues, fromBase64, toBase64 } from './encode';

/** Runs `expr` in a pattern's top level and gives back its value as a plain number. */
function value(expr: string, pre = ''): number {
  const p = compilePattern(`${pre}\nexport var out = 0\nout = ${expr}\nexport function render(i) {}`);
  const vm = new PatternVM(p, { random: () => 0.5 });
  vm.init();
  return vm.getVar('out')!;
}
const raw = (expr: string, pre = '') => Math.round(value(expr, pre) * FIX);
const rgbOf = (src: string, frames = 1, opts = {}) => Array.from(runFrames(compilePattern(src), frames, 1000 / 60, opts));

describe('pattern numbers (16.16 fixed point)', () => {
  it('keep 1/65536 steps', () => {
    expect(value('1 / 256 / 256')).toBe(1 / FIX);
    expect(value('0.5 + 0.25')).toBe(0.75);
    expect(value('7 % 3')).toBe(1);
    expect(value('-7 % 3')).toBe(-1);
  });
  it('wrap around past 32767.99 as on the board', () => {
    expect(value('32767 + 2')).toBe(-32767);
    expect(value('-32768 - 1')).toBe(32767);
    expect(value('200 * 200')).toBe(40000 - 65536);
  });
  it('multiply without losing the low bits', () => {
    expect(fmul(3 * FIX, 0.5 * FIX)).toBe(1.5 * FIX);
    expect(fmul(-3 * FIX, 0.5 * FIX)).toBe(-1.5 * FIX);
    expect(fmul(1, 1)).toBe(0); // 1/65536 squared rounds down
    expect(fmul(-1, 1)).toBe(-1); // and down means toward minus infinity, like an arithmetic shift
    expect(fmul(12345 * FIX + 0x1234, 2 * FIX)).toBe((24690 * FIX + 0x2468) | 0);
  });
  it('divide toward zero, and give the largest number for / 0', () => {
    expect(fdiv(FIX, 3 * FIX)).toBe(21845);
    expect(fdiv(-FIX, 3 * FIX)).toBe(-21845);
    expect(value('1 / 0')).toBeCloseTo(32768, 3);
    expect(value('-1 / 0')).toBe(-32768);
    expect(value('0 / 0')).toBe(0);
  });
  it('run bitwise operators on the whole 32-bit word', () => {
    expect(value('5 & 3')).toBe(1);
    expect(value('5 | 3')).toBe(7);
    expect(value('5 ^ 3')).toBe(6);
    expect(value('1 << 4')).toBe(16);
    expect(value('-16 >> 2')).toBe(-4);
    expect(raw('~0')).toBe(-1); // every bit set: -1/65536
    expect(value('1.5 & 1')).toBe(1);
    expect(value('0xFF')).toBe(255);
    expect(value('0xFFFF')).toBe(-1); // hex is a whole number, and 65535 wraps to -1
    expect(raw('2.75 & 0xFFFF')).toBe(2 * FIX); // -1.0 is every whole-number bit: the fraction goes
  });
  it('compare, test and decide like JavaScript, with 1 for true', () => {
    expect(value('3 > 2')).toBe(1);
    expect(value('3 == 2')).toBe(0);
    expect(value('0 || 5')).toBe(5);
    expect(value('2 && 0')).toBe(0);
    expect(value('2 && 7')).toBe(7);
    expect(value('!0')).toBe(1);
    expect(value('1 ? 4 : 5')).toBe(4);
    expect(value('x++ + x', 'var x = 3')).toBe(7);
    expect(value('++x * 2', 'var x = 3')).toBe(8);
  });
});

describe('pattern built-ins', () => {
  it('time() repeats every interval × 65.536 seconds', () => {
    const p = compilePattern('export var t\nexport function beforeRender(d) { t = time(1) }\nexport function render(i) {}');
    const vm = new PatternVM(p);
    vm.init();
    vm.frame(65536 / 4);
    expect(vm.getVar('t')).toBeCloseTo(0.25, 4);
    vm.frame(65536 / 2);
    expect(vm.getVar('t')).toBeCloseTo(0.75, 4);
    vm.frame(65536 / 2);
    expect(vm.getVar('t')).toBeCloseTo(0.25, 4);
  });
  it('wave, triangle and square at known points', () => {
    expect(value('wave(0)')).toBeCloseTo(0.5, 4);
    expect(value('wave(0.25)')).toBeCloseTo(1, 4);
    expect(value('wave(0.75)')).toBeCloseTo(0, 4);
    expect(value('triangle(0)')).toBe(0);
    expect(value('triangle(0.5)')).toBe(1);
    expect(value('triangle(0.25)')).toBe(0.5);
    expect(value('triangle(1.25)')).toBe(0.5);
    expect(value('square(0.2, 0.5)')).toBe(1);
    expect(value('square(0.7, 0.5)')).toBe(0);
  });
  it('maths', () => {
    expect(value('floor(-1.5)')).toBe(-2);
    expect(value('ceil(1.25)')).toBe(2);
    expect(value('round(2.5)')).toBe(3);
    expect(value('trunc(-1.75)')).toBe(-1);
    expect(value('frac(2.75)')).toBe(0.75);
    expect(value('abs(-3)')).toBe(3);
    expect(value('min(2, 3) + max(2, 3)')).toBe(5);
    expect(value('clamp(5, 0, 1)')).toBe(1);
    expect(value('mix(2, 4, 0.5)')).toBe(3);
    expect(value('smoothstep(0, 1, 0.5)')).toBe(0.5);
    expect(value('sqrt(16)')).toBe(4);
    expect(value('sin(PI / 2)')).toBeCloseTo(1, 4);
    expect(value('pow(2, 10)')).toBe(1024);
    expect(value('mod(-1, 3)')).toBe(2);
    expect(value('random(10)')).toBe(5);
  });
  it('hsv() and rgb() set the light, hue wraps around', () => {
    expect(rgbOf('export function render(i) { hsv(0, 1, 1) }').slice(0, 3)).toEqual([255, 0, 0]);
    expect(rgbOf('export function render(i) { hsv(1, 1, 1) }').slice(0, 3)).toEqual([255, 0, 0]);
    expect(rgbOf('export function render(i) { hsv(-2/3, 1, 1) }').slice(0, 3)).toEqual([0, 255, 0]);
    expect(rgbOf('export function render(i) { hsv(2/3, 1, 0.5) }').slice(0, 3)).toEqual([0, 0, 128]);
    expect(rgbOf('export function render(i) { hsv(0.5, 0, 1) }').slice(0, 3)).toEqual([255, 255, 255]);
    expect(rgbOf('export function render(i) { rgb(1, 0.5, 2) }').slice(0, 3)).toEqual([255, 128, 255]);
    // a light that gets no colour is off
    expect(rgbOf('export function render(i) { if (i == 1) rgb(1, 1, 1) }').slice(0, 6)).toEqual([0, 0, 0, 255, 255, 255]);
  });
  it('render gets every index and pixelCount is the strip length', () => {
    const out = rgbOf('export function render(index) { rgb(index / pixelCount, 0, 0) }', 1, { pixelCount: 4 });
    expect(out.filter((_, i) => i % 3 === 0)).toEqual([0, 64, 128, 191]);
  });
  it('render2D gets x along the strip when there is no render()', () => {
    const out = rgbOf('export function render2D(i, x, y) { rgb(x, y, 0) }', 1, { pixelCount: 2 });
    expect(out).toEqual([0, 0, 0, 128, 0, 0]);
  });
  it('lists: array(), [..], .length, index, forEach, mutate, mapTo, reduce, sum, sort', () => {
    expect(value('a.length', 'var a = array(5)')).toBe(5);
    expect(value('a[1] + a[2]', 'var a = [1, 2, 3]')).toBe(5);
    expect(value('a[9]', 'var a = [1, 2, 3]')).toBe(0);
    expect(value('a.sum()', 'var a = [1, 2, 3]\na.mutate((v, i) => v * i)')).toBe(8);
    expect(value('s', 'var s = 0\nvar a = [1, 2, 3]\na.forEach((v) => { s += v })')).toBe(6);
    expect(value('b[2]', 'var a = [1, 2, 3]\nvar b = array(3)\narrayMapTo(a, b, function (v) { return v * 10 })')).toBe(30);
    expect(value('a.reduce((acc, v) => acc + v, 10)', 'var a = [1, 2, 3]')).toBe(16);
    expect(value('a[0] * 100 + a[2]', 'var a = [3, 1, 2]\na.sort()')).toBe(103);
    expect(value('a[1] += 5', 'var a = [1, 2, 3]')).toBe(7);
  });
  it('user functions, loops, break and continue', () => {
    const pre = `function fib(n) { if (n < 2) return n; return fib(n - 1) + fib(n - 2) }
var s = 0
for (var i = 0; i < 10; i++) { if (i == 3) continue; if (i == 6) break; s += i }
var w = 0; while (w < 5) w += 2
var d = 0; do { d++ } while (d < 3)`;
    expect(value('fib(10)', pre)).toBe(55);
    expect(value('s', pre)).toBe(0 + 1 + 2 + 4 + 5);
    expect(value('w * 10 + d', pre)).toBe(63);
  });
});

describe('pattern controls', () => {
  const src = `export var speed = 0.5
export var count = 3
var hue = 0, on = 0
export function sliderSpeed(v) { speed = v }
export function hsvPickerMainColor(h, s, v) { hue = h }
export function toggleSparkle(v) { on = v }
export function render(i) { hsv(hue, 1, speed) }`;
  it('are found by their names: slider…, hsvPicker…, toggle…, and export var', () => {
    const p = compilePattern(src);
    expect(p.controls.map((c) => [c.kind, c.label])).toEqual([['slider', 'Speed'], ['hsvPicker', 'Main color'], ['toggle', 'Sparkle']]);
    expect(p.vars.map((v) => v.name)).toEqual(['speed', 'count']);
  });
  it('change the pattern when moved', () => {
    const vm = new PatternVM(compilePattern(src), { pixelCount: 1 });
    vm.init();
    expect(vm.getVar('speed')).toBe(0.5);
    vm.setControl('sliderSpeed', [1]);
    expect(vm.getVar('speed')).toBe(1);
    vm.setControl('hsvPickerMainColor', [1 / 3, 1, 1]);
    expect(Array.from(vm.frame(16))).toEqual([0, 255, 0]);
    // an export var can be set directly
    vm.setVar('speed', 0.25);
    expect(Array.from(vm.frame(16))).toEqual([0, 64, 0]);
  });
});

describe('the runaway guard', () => {
  it('stops a loop that never ends in render, with a plain message and its line', () => {
    const p = compilePattern('export function render(i) {\n  while (1) {}\n}');
    const vm = new PatternVM(p, { budget: 100_000 });
    vm.init();
    expect(() => vm.frame(16)).toThrowError(/took too long on one frame/);
    try { vm.frame(16); } catch (e) { expect((e as PatternError).line).toBe(2); }
  });
  it('stops one in beforeRender and in the top-level code', () => {
    const before = new PatternVM(compilePattern('export function beforeRender(d) { for (;;) {} }\nexport function render(i) {}'), { budget: 50_000 });
    before.init();
    expect(() => before.frame(16)).toThrowError(/took too long/);
    expect(() => new PatternVM(compilePattern('var x = 0\nwhile (1) { x++ }\nexport function render(i) {}'), { budget: 50_000 }).init()).toThrowError(/took too long/);
  });
  it('also stops on time, whatever the step budget', () => {
    let t = 0;
    const vm = new PatternVM(compilePattern('export function render(i) { while (1) {} }'), { budget: 1e12, timeLimitMs: 50, now: () => (t += 1) });
    vm.init();
    expect(() => vm.frame(16)).toThrowError(/took too long/);
  });
  it('stops endless recursion and lists that are too big', () => {
    expect(() => value('f(1)', 'function f(x) { return f(x) }')).toThrowError(/too deeply/);
    expect(() => value('0', 'var a = array(30000)\nvar b = array(30000)\nvar c = array(30000)\nvar d = array(30000)')).toThrowError(/lists are too big/);
  });
});

describe('compile errors are plain and name the line', () => {
  const err = (src: string) => { try { compilePattern(src); } catch (e) { return (e as Error).message; } return ''; };
  it('says what is wrong', () => {
    expect(err('export function render(i) {\n  hsv(fo, 1, 1)\n}')).toBe('Line 2: there is no “fo” (a typo, or a variable that needs “var fo” first?)');
    expect(err('var x = 1')).toMatch(/needs “export function render\(index\)”/);
    expect(err('export function render(i) { hsv("red") }')).toMatch(/numbers only/);
    expect(err('export function render(i) {\n  x = 40000\n}')).toMatch(/Line 2: 40000 is too big/);
    expect(err('export function render(i) { perlin(i, 0, 0, 0) }')).toMatch(/not in Studio yet/);
    expect(err('function a(x) { return () => x }\nexport function render(i) {}')).toMatch(/belongs to the function around this one/);
    expect(err('export function render(i) { hsv(1, 2, 3, 4) }')).toMatch(/hsv\(\) takes 3 values, not 4/);
  });
});

describe('the portable form', () => {
  it('is plain numbers and names', () => {
    const p = compilePattern(STARTER_PATTERN);
    const back = JSON.parse(programText(p));
    expect(back.format).toBe('specter-pattern');
    expect(back.code.every((n: unknown) => Number.isInteger(n))).toBe(true);
    expect(back.lines).toBeUndefined();
    // the same program runs from its text form
    const a = runFrames(p, 5), b = runFrames({ ...back, lines: [] }, 5);
    expect(Array.from(b)).toEqual(Array.from(a));
  });
  it('every example compiles and lights something', () => {
    for (const x of EXAMPLE_PATTERNS) {
      let r = 0;
      const out = runFrames(compilePattern(x.text), 30, 1000 / 60, { random: () => (r = (r + 0.37) % 1) });
      expect(out.some((v) => v > 0), x.title).toBe(true);
    }
  });
  it('the starter rainbow moves', () => {
    const vm = new PatternVM(compilePattern(STARTER_PATTERN), { pixelCount: 8 });
    vm.init();
    const a = Array.from(vm.frame(16));
    const b = Array.from(vm.frame(500));
    expect(a).not.toEqual(b);
  });
});

describe('pattern files (.epe)', () => {
  it('read name and code', () => {
    const p = parseEpe(JSON.stringify({ id: 'abc', name: 'Blue: wave?', sources: { main: 'export function render(i) { hsv(0.6, 1, 1) }' }, preview: 'xx' }));
    expect(p).toMatchObject({ id: 'abc', name: 'Blue wave', source: 'export function render(i) { hsv(0.6, 1, 1) }' });
    expect(parseEpe(JSON.stringify({ name: 'x', sources: 'a' })).source).toBe('a');
  });
  it('refuse other files plainly', () => {
    expect(() => parseEpe('hello')).toThrowError('This file is not a pattern file (.epe): it could not be read.');
    expect(() => parseEpe('{"name":"x"}')).toThrowError(/no pattern code/);
  });
  it('names stay file-safe', () => {
    expect(cleanPatternName('..a/b\\c')).toBe('a b c');
    expect(cleanPatternName('   ')).toBe('');
  });
});

describe('the board-exact maths (fixed.ts)', () => {
  const near = (got: number, want: number, tol: number, what: string) => expect(Math.abs(got / FIX - want), what).toBeLessThan(tol);
  it('stays close to the exact values', () => {
    for (let x = -20; x <= 20; x += 0.173) {
      const v = Math.round(x * FIX);
      near(fx.fsin(v), Math.sin(v / FIX), 1e-4, `sin ${x}`);
      near(fx.fcos(v), Math.cos(v / FIX), 1e-4, `cos ${x}`);
      near(fx.fatan(v), Math.atan(v / FIX), 1e-4, `atan ${x}`);
      near(fx.fatan2(v, Math.round(1.7 * FIX)), Math.atan2(v / FIX, 1.7), 1e-4, `atan2 ${x}`);
      near(fx.fwave(v), (1 + Math.sin((v / FIX) * Math.PI * 2)) / 2, 1e-4, `wave ${x}`);
      if (x > 0) {
        near(fx.fsqrt(v), Math.sqrt(v / FIX), 1e-4, `sqrt ${x}`);
        near(fx.flog(v), Math.log(v / FIX), 2e-4, `log ${x}`);
        near(fx.flog2(v), Math.log2(v / FIX), 2e-4, `log2 ${x}`);
        near(fx.fpow(v, Math.round(1.5 * FIX)), Math.pow(v / FIX, 1.5), Math.pow(v / FIX, 1.5) * 2e-4 + 1e-4, `pow ${x}`);
      }
      if (x < 10) near(fx.fexp(v), Math.exp(v / FIX), Math.exp(v / FIX) * 2e-4 + 1e-4, `exp ${x}`);
      if (Math.abs(x) <= 1) {
        near(fx.fasin(v), Math.asin(v / FIX), 2e-4, `asin ${x}`);
        near(fx.facos(v), Math.acos(v / FIX), 2e-4, `acos ${x}`);
      }
      near(fx.fhypot(v, 3 * FIX), Math.hypot(v / FIX, 3), 1e-4, `hypot ${x}`);
    }
  });
  it('multiplies exactly like a 64-bit product', () => {
    const big = (a: number, b: number, s: number) => Number(BigInt.asIntN(32, (BigInt(a) * BigInt(b)) >> BigInt(s)));
    let seed = 7;
    const r = () => ((seed = (seed * 1103515245 + 12345) | 0) ^ (seed << 7)) | 0;
    for (let i = 0; i < 2000; i++) {
      const a = r(), b = r();
      for (const s of [16, 22, 29, 30]) expect(fx.mulS(a, b, s)).toBe(big(a, b, s));
    }
    for (const a of [-0x80000000, 0x7fffffff, -1, 0, 1]) for (const b of [-0x80000000, 0x7fffffff, -1, 1]) expect(fx.mulS(a, b, 16)).toBe(big(a, b, 16));
  });
});

describe('the bytes a board is sent (encode.ts)', () => {
  it('hold the whole program and come back the same', () => {
    for (const x of EXAMPLE_PATTERNS) {
      const p = compilePattern(x.text);
      const back = decodeProgram(encodeProgram(p));
      expect(back.code).toEqual(p.code);
      expect(back.functions.map((f) => [f.addr, f.params, f.locals])).toEqual(p.functions.map((f) => [f.addr, f.params, f.locals]));
      expect(back.controls).toEqual(p.controls);
      expect(back.entry).toEqual(p.entry);
      expect(back.globals.length).toBe(p.globals.length);
      expect(Array.from(runFrames(back, 5, 16, { random: () => 0.3 }))).toEqual(Array.from(runFrames(p, 5, 16, { random: () => 0.3 })));
    }
  });
  it('start with SPAT and the format, little endian', () => {
    const b = encodeProgram(compilePattern('export function render(i) { rgb(1, 0, 0) }'));
    expect(Array.from(b.slice(0, 6))).toEqual([0x53, 0x50, 0x41, 0x54, 1, 0]);
    expect(fromBase64(toBase64(b))).toEqual(b);
  });
  it('say plainly when a pattern is too big for a board', () => {
    const p = compilePattern('export function render(i) { rgb(1, 0, 0) }');
    expect(boardFit(p)).toBeNull();
    expect(boardFit({ ...p, code: new Array(5000).fill(1) })).toMatch(/too big for a board \(5000 code steps, at most 4096\)/);
  });
  it('take control values as 16.16', () => {
    expect(fixedValues([0, 0.5, 1, NaN])).toEqual([0, 32768, 65536, 0]);
  });
});
