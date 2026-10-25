// The patterns behind the shared golden vectors (firmware/pattern-golden): each runs in Studio's interpreter with
// a fixed random source and fixed frame times, and the board's interpreter must give the same lights, byte for
// byte. Written for Studio; they cover every built-in, the number edges, lists, controls and the plain errors.

import { EXAMPLE_PATTERNS } from '../examples';

export type GoldenStep = { frame: number } | { control: string; values: number[] };
export interface GoldenCase { name: string; source: string; pixels: number; seed: number; steps: GoldenStep[] }

const frames = (ms: number[]): GoldenStep[] => ms.map((m) => ({ frame: m }));
const SEED = 0x12345678;

// every result goes into all three colours through its low bits, so one bit off shows
const SHOW = `function show(v) { rgb(frac(v * 97.31), frac(v * 7.77), frac(v)) }\n`;

const sweep = (name: string, body: string, pixels = 48): GoldenCase => ({
  name,
  pixels,
  seed: SEED,
  source: `${SHOW}var t = 0
export function beforeRender(delta) { t += delta / 1000 }
export function render(index) {
  var x = (index - pixelCount / 2) * 0.37 + t
  ${body}
}
`,
  steps: frames([0, 16, 17, 250, 1000, 33]),
});

export const GOLDEN_CASES: GoldenCase[] = [
  sweep('trig-sin', 'show(sin(x * 3))'),
  sweep('trig-cos', 'show(cos(x * 3 - 1))'),
  sweep('trig-tan', 'show(tan(x))'),
  sweep('trig-big-angles', 'show(sin(x * 700) + cos(x * 900))'),
  sweep('waves', 'if (index % 3 == 0) show(wave(x)); else if (index % 3 == 1) show(triangle(x * 1.3)); else show(square(x, 0.3))'),
  sweep('inverse-trig', 'var y = x / 9; if (index % 4 == 0) show(asin(y)); else if (index % 4 == 1) show(acos(y)); else if (index % 4 == 2) show(atan(x * 5)); else show(atan2(x, y - 1))'),
  sweep('atan2-quadrants', 'show(atan2(sin(x * 2), cos(x * 2)) + atan2(0, x) + atan2(x, 0))'),
  sweep('exp-log', 'if (index % 3 == 0) show(exp(x)); else if (index % 3 == 1) show(log(abs(x) + 0.001)); else show(log2(abs(x * 300) + 0.0001))'),
  sweep('pow-sqrt-hypot', 'if (index % 4 == 0) show(pow(abs(x), 1.7)); else if (index % 4 == 1) show(pow(x, 3)); else if (index % 4 == 2) show(sqrt(abs(x) * 1000)); else show(hypot(x * 2000, x - 3))'),
  sweep('pow-edges', 'show(pow(0, x) + pow(x, 0) + pow(-2, x) + pow(2, x * 4) + pow(x, -2))'),
  sweep('exp-edges', 'show(exp(x * 4) + exp(-x * 5) + exp(11) + exp(-13))'),
  sweep('rounding', 'show(floor(x) + ceil(-x) * 3 + round(x * 2) * 5 + trunc(-x) * 7 + frac(-x) + abs(x - 2))'),
  sweep('min-max-clamp-mix', 'show(min(x, 1) + max(x, -1) * 2 + clamp(x, -0.5, 0.5) * 3 + mix(1, 5, x) + smoothstep(-2, 2, x) + smoothstep(1, 1, x))'),
  sweep('mod-div', 'show(mod(x * 7, 3) + mod(-x, 0.7) + (x * 9) % 2 + x / 0.3 + x / 0 + 0 / 0 + mod(x, 0) + (x % -1))'),
  sweep('wraparound', 'show(x * 30000 + 32767 + x * x * x * 999 - 32768 * x)'),
  sweep('bitwise', 'var a = x * 1000; show((a & 0xF0F) + (a | 3) + (a ^ 0x55) + ~a + (a << 3) + (a >> 2) + (a >>> 5) + (-a >>> 1))'),
  sweep('compare-logic', 'show((x > 1) + (x >= 1) * 2 + (x < 0) * 4 + (x <= 0) * 8 + (x == 1) * 16 + (x != 1) * 32 + !x + (x && 3) + (x || 5) + (x > 0 ? 7 : 9))'),
  sweep('hsv-rgb', 'if (index % 2) hsv(x, frac(x * 3), wave(x)); else rgb(x, -x, x * x)'),
  sweep('hsv24', 'hsv24(x * 0.1, 1, abs(sin(x)))'),
  {
    name: 'random-and-prng',
    pixels: 40,
    seed: SEED,
    source: `${SHOW}var s = 0
export function beforeRender(delta) { if (s == 0) prngSeed(12345); s++ }
export function render(index) { show(random(3) + prng(10) * 0.001 + random(-2)) }
`,
    steps: frames([16, 16, 16, 40, 2]),
  },
  {
    name: 'prng-default-seed',
    pixels: 20,
    seed: 99,
    source: `${SHOW}export function render(index) { if (index == 5) prngSeed(0); show(prng(1)) }\n`,
    steps: frames([10, 10]),
  },
  {
    name: 'time',
    pixels: 30,
    seed: SEED,
    source: `${SHOW}export function render(index) { show(time(index * 0.003 + 0.001) + time(0) + time(-1)) }\n`,
    steps: frames([0, 1, 7, 16, 999, 65535, 100000, 3]),
  },
  {
    name: 'render2d',
    pixels: 17,
    seed: SEED,
    source: 'export function render2D(index, x, y) { hsv(x, 1, 1 - y) }\n',
    steps: frames([16, 16]),
  },
  {
    name: 'render3d',
    pixels: 9,
    seed: SEED,
    source: 'export function render3D(index, x, y, z) { rgb(x, y + 0.5, z + x) }\n',
    steps: frames([16]),
  },
  {
    name: 'lists',
    pixels: 24,
    seed: SEED,
    source: `${SHOW}var a = array(pixelCount)
var b = [5, 3, 9, 3, 1, 7, 3]
var c = array(7)
var nested = [[1, 2], [3, 4], 5]
var pick = 0
var other = b
var dd = 0, s = 0
export function beforeRender(delta) {
  dd = delta
  a.mutate((v, i) => v + i * 0.01 + dd * 0.001)
  b.sort()
  arrayMapTo(b, c, function (v, i) { return v * i })
  pick = a.reduce((acc, v) => acc + v, 1) + c.sum() + a.length + nested[1][0] + (other == b) + (a == b) * 3 + nested[9]
  s = 0
  nested.forEach((v) => { s += 1 })
  pick += s
}
export function render(index) { show(a[index] + pick + b[index % 7] + c[index % 9]) }
`,
    steps: frames([16, 16, 16]),
  },
  {
    name: 'sort-stable-mixed',
    pixels: 12,
    seed: SEED,
    source: `${SHOW}var f = (v) => v
var L = [1]
var a = [3, f, -1, 0, L, 2, 0, -5, f, 1.5, 0, 9]
a.sort()
export function render(index) { var v = a[index]; if (v == f) show(100); else if (v == L) show(200); else if (v == 0) show(0.5); else show(v) }
`,
    steps: frames([16]),
  },
  {
    name: 'functions-as-values',
    pixels: 16,
    seed: SEED,
    source: `${SHOW}function twice(f, v) { return f(f(v)) }
var add = (v) => v + 0.25
var mul = function (v) { return v * 1.5 }
var which = 0
function fib(n) { if (n < 2) return n; return fib(n - 1) + fib(n - 2) }
export function beforeRender(delta) { which = !which }
export function render(index) { show(twice(which ? add : mul, index) + fib(index % 12) + (add == add) + (add == mul)) }
`,
    steps: frames([16, 16]),
  },
  {
    name: 'loops-and-locals',
    pixels: 20,
    seed: SEED,
    source: `${SHOW}export function render(index) {
  var s = 0, i = 0
  for (var k = 0; k < index; k++) { if (k == 4) continue; if (k == 15) break; s += k * 0.1 }
  while (i < 3) i++
  do { s -= 0.01 } while (s > 100)
  var u = s++, w = ++s
  s += 2; s -= 1; s *= 1.5; s /= 1.1; s %= 7
  show(s + u + w + i)
}
`,
    steps: frames([16]),
  },
  {
    name: 'controls',
    pixels: 16,
    seed: SEED,
    source: `var speed = 0.5, hue = 0, sat = 1, on = 0, n = 0, r = 0, g = 0, b = 0, hits = 0
export function sliderSpeed(v) { speed = v }
export function hsvPickerMainColor(h, s, v) { hue = h; sat = s }
export function rgbPickerAccent(rr, gg, bb) { r = rr; g = gg; b = bb }
export function toggleSparkle(v) { on = v }
export function inputNumberCount(v) { n = v }
export function triggerFlash() { hits++ }
var t = 0
export function beforeRender(delta) { t += delta * speed / 1000 }
export function render(index) {
  if (index < hits) rgb(r, g, b)
  else if (on && index == n) rgb(1, 1, 1)
  else hsv(hue + t + index / pixelCount, sat, 1)
}
`,
    steps: [
      { control: 'sliderSpeed', values: [65536] },
      { control: 'hsvPickerMainColor', values: [21845, 52428, 65536] },
      { frame: 16 },
      { control: 'triggerFlash', values: [] },
      { control: 'triggerFlash', values: [] },
      { control: 'rgbPickerAccent', values: [65536, 32768, 0] },
      { control: 'toggleSparkle', values: [65536] },
      { control: 'inputNumberCount', values: [7 * 65536] },
      { frame: 16 },
      { control: 'noSuchControl', values: [1] },
      { control: 'sliderSpeed', values: [13107] },
      { frame: 100 },
    ],
  },
  {
    name: 'puzzle-out-of-order',
    pixels: 60,
    seed: SEED,
    source: EXAMPLE_PATTERNS.find((x) => x.title === 'clue puzzle')!.text,
    steps: [
      { frame: 20 },
      { control: 'triggerClue3', values: [] },
      { frame: 20 },
      { control: 'triggerClue1', values: [] },
      { control: 'triggerClue6', values: [] },
      { frame: 20 },
      { control: 'triggerClue2', values: [] },
      { control: 'triggerClue5', values: [] },
      { control: 'triggerClue4', values: [] },
      { frame: 20 },
      { control: 'triggerReset', values: [] },
      { frame: 20 },
      { control: 'triggerClue4', values: [] },
      { frame: 20 },
    ],
  },
  {
    name: 'heavy-600',
    pixels: 600,
    seed: SEED,
    source: `var heat = array(pixelCount)
var t = 0
export function beforeRender(delta) {
  t += delta / 1000
  for (var i = 0; i < pixelCount; i++) heat[i] = max(0, heat[i] - random(0.05))
  heat[floor(random(pixelCount))] = 1
}
export function render(index) {
  var w = wave(t * 0.3 + index / 40) * 0.5 + sin(index * 0.1 + t) * 0.25 + heat[index] * 0.5
  hsv(0.02 + w * 0.12 + time(0.05), 1 - heat[index] * 0.3, clamp(w, 0, 1))
}
`,
    steps: frames([20, 20, 20]),
  },
  // the plain errors: the step that fails and its message (the board says the same, without the line)
  { name: 'error-endless-render', pixels: 8, seed: SEED, source: 'export function render(i) { while (1) {} }\n', steps: frames([16]) },
  { name: 'error-endless-top', pixels: 8, seed: SEED, source: 'var x = 0\nwhile (1) { x++ }\nexport function render(i) {}\n', steps: frames([16]) },
  { name: 'error-endless-control', pixels: 8, seed: SEED, source: 'export function triggerGo() { for (;;) {} }\nexport function render(i) { rgb(1, 0, 0) }\n', steps: [{ frame: 16 }, { control: 'triggerGo', values: [] }, { frame: 16 }] },
  { name: 'error-too-deep', pixels: 8, seed: SEED, source: 'function f(x) { return f(x + 1) }\nexport function beforeRender(d) { f(0) }\nexport function render(i) {}\n', steps: frames([16]) },
  { name: 'error-locals', pixels: 8, seed: SEED, source: `function f(n) { var ${Array.from({ length: 40 }, (_, i) => `v${i}`).join(', ')}; if (n > 0) f(n - 1); return 0 }\nexport function render(i) { f(20) }\n`, steps: frames([16]) },
  { name: 'error-lists-grow', pixels: 8, seed: SEED, source: 'var a\nexport function beforeRender(d) { a = array(300) }\nexport function render(i) { rgb(1, 1, 1) }\n', steps: frames([16, 16, 16, 16, 16, 16, 16, 16]) },
  { name: 'error-list-literal-in-render', pixels: 100, seed: SEED, source: 'export function render(i) { var c = [i, 1, 0]; rgb(c[1], c[2], 0) }\n', steps: frames([16, 16, 16, 16, 16, 16, 16]) },
  { name: 'error-list-as-number', pixels: 8, seed: SEED, source: 'var a = [1]\nexport function render(i) { rgb(a + 1, 0, 0) }\n', steps: frames([16]) },
  { name: 'error-not-a-function', pixels: 8, seed: SEED, source: 'var f = 3\nexport function render(i) { f(1) }\n', steps: frames([16]) },
  { name: 'error-needs-a-list', pixels: 8, seed: SEED, source: 'var f = 3\nexport function render(i) { rgb(f[1], 0, 0) }\n', steps: frames([16]) },
  { name: 'error-needs-a-function', pixels: 8, seed: SEED, source: 'var a = [1, 2]\nexport function render(i) { a.forEach(5) }\n', steps: frames([16]) },
  { name: 'error-stack', pixels: 8, seed: SEED, source: `export function render(i) { rgb(${'1 + ('.repeat(300)}1${')'.repeat(300)}, 0, 0) }\n`, steps: frames([16]) },
  ...EXAMPLE_PATTERNS.filter((x) => x.title !== 'clue puzzle').map((x) => ({
    name: `example-${x.title.replace(/\s+/g, '-')}`,
    pixels: 30,
    seed: SEED,
    source: x.text,
    steps: frames([16, 17, 16, 500, 16]),
  })),
];
