// The pattern language in Monaco: JavaScript-like colours, the built-in names coloured apart, completion and hover
// help in our own words. Its own language id: Monaco's JavaScript mode would want a language worker Studio does not
// load and would mark hsv() and friends as unknown.
import type * as Monaco from 'monaco-editor';
import { CONSTANTS, HOST_GLOBALS, PATTERN_WORDS } from './builtins';

export const PATTERN_LANG = 'led-pattern';

const KEYWORDS = ['var', 'let', 'const', 'function', 'export', 'if', 'else', 'for', 'while', 'do', 'return', 'break', 'continue', 'true', 'false'];

/** One line of help for each built-in, written for Studio. */
export const PATTERN_HELP: Record<string, string> = {
  time: '`time(x)` goes from 0 up to 1 and starts again, once every x × 65.5 seconds: `time(0.1)` repeats about every 6.5 s.',
  wave: '`wave(x)` is a smooth up-and-down between 0 and 1 (a sine wave), one round for every 1 that x grows.',
  triangle: '`triangle(x)` goes straight up from 0 to 1 and straight back down, one round for every 1 that x grows.',
  square: '`square(x, duty)` is 1 for the first `duty` part of each round and 0 for the rest.',
  mix: '`mix(a, b, amount)` is a when amount is 0, b when it is 1, and in between.',
  smoothstep: '`smoothstep(low, high, x)` goes smoothly from 0 to 1 as x goes from low to high.',
  clamp: '`clamp(x, low, high)` keeps x between low and high.',
  sin: 'Sine of an angle in radians.', cos: 'Cosine of an angle in radians.', tan: 'Tangent of an angle in radians.',
  asin: 'Arc sine, in radians.', acos: 'Arc cosine, in radians.', atan: 'Arc tangent, in radians.', atan2: '`atan2(y, x)`: the angle of a point, in radians.',
  abs: 'The number without its minus sign.', floor: 'Rounds down to a whole number.', ceil: 'Rounds up to a whole number.', round: 'Rounds to the nearest whole number.',
  trunc: 'Drops the part after the point.', frac: 'Only the part after the point: `frac(2.75)` is 0.75.',
  min: 'The smaller of two numbers.', max: 'The larger of two numbers.', pow: '`pow(x, y)`: x to the power y.', sqrt: 'Square root.',
  exp: 'e to the power x.', log: 'Natural logarithm.', log2: 'Logarithm base 2.', hypot: '`hypot(x, y)`: the distance from 0 to the point (x, y).',
  mod: '`mod(x, y)`: the remainder, always with the sign of y (so it counts round and round).',
  random: '`random(x)`: a different number from 0 up to x every time.',
  prng: '`prng(x)`: like random(x), but the same sequence again after `prngSeed(seed)`.',
  prngSeed: '`prngSeed(seed)` starts prng() over at a given point.',
  hsv: '`hsv(hue, saturation, brightness)` colours the light being drawn. Hue goes round the colour wheel from 0 to 1 (0 red, 0.33 green, 0.67 blue); saturation 0 is white; brightness 0 is off.',
  hsv24: 'The same as hsv().',
  rgb: '`rgb(red, green, blue)` colours the light being drawn, each from 0 to 1.',
  array: '`array(n)` makes a list of n numbers, all 0. Read and change them with `list[i]`.',
  arrayForEach: '`arrayForEach(list, f)` calls f(value, index) for every item.',
  arrayMapTo: '`arrayMapTo(from, to, f)` puts f(value, index) of each item of one list into another.',
  arrayMutate: '`arrayMutate(list, f)` replaces every item by f(value, index).',
  arrayReduce: '`arrayReduce(list, f, start)` adds up the list your way: f(sofar, value, index).',
  arraySum: 'The sum of a list.', arraySort: 'Sorts a list from small to large.', arrayLength: 'How many items a list has (or write `list.length`).',
  pixelCount: 'How many lights the strip has.',
  PI: 'π, 3.14159…', PI2: '2π: one full turn in radians.',
  beforeRender: '`export function beforeRender(delta)` runs once before every frame; delta is the milliseconds since the last one.',
  render: '`export function render(index)` runs once for every light, from 0 to pixelCount - 1, and gives it its colour with hsv() or rgb().',
  render2D: '`export function render2D(index, x, y)`: like render, with the light\'s place. On a strip x goes from 0 to 1 along it and y is 0.',
};

const CONTROL_HELP = 'Controls: `export function sliderSpeed(v)` makes a slider (v from 0 to 1), `hsvPickerColor(h, s, v)` and `rgbPickerColor(r, g, b)` a colour picker, `toggleSparkle(on)` a switch, `triggerBurst()` a button. `export var` values are shown and can be changed too.';

let done = false;
export function registerPatternLanguage(monaco: typeof Monaco) {
  if (done) return;
  done = true;
  monaco.languages.register({ id: PATTERN_LANG, extensions: ['.pattern.js'], aliases: ['LED pattern'] });
  monaco.languages.setLanguageConfiguration(PATTERN_LANG, {
    comments: { lineComment: '//', blockComment: ['/*', '*/'] },
    brackets: [['{', '}'], ['[', ']'], ['(', ')']],
    autoClosingPairs: [{ open: '{', close: '}' }, { open: '[', close: ']' }, { open: '(', close: ')' }],
    surroundingPairs: [{ open: '{', close: '}' }, { open: '[', close: ']' }, { open: '(', close: ')' }],
    indentationRules: { increaseIndentPattern: /^.*\{[^}"']*$/, decreaseIndentPattern: /^\s*\}/ },
  });
  monaco.languages.setMonarchTokensProvider(PATTERN_LANG, {
    keywords: KEYWORDS,
    builtins: PATTERN_WORDS,
    tokenizer: {
      root: [
        [/\/\/.*$/, 'comment'],
        [/\/\*/, 'comment', '@comment'],
        [/\b(slider|hsvPicker|rgbPicker|toggle|trigger|inputNumber)[A-Z]\w*/, 'type'],
        [/\b(beforeRender|render|render2D|render3D)\b/, 'type'],
        [/0[xX][0-9a-fA-F]+/, 'number.hex'],
        [/(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/, 'number'],
        [/[A-Za-z_$][\w$]*/, { cases: { '@keywords': 'keyword', '@builtins': 'predefined', '@default': 'identifier' } }],
        [/[{}()[\]]/, '@brackets'],
        [/[<>=!~?:&|+\-*/^%]+/, 'operator'],
        [/[;,.]/, 'delimiter'],
      ],
      comment: [[/[^*/]+/, 'comment'], [/\*\//, 'comment', '@pop'], [/[*/]/, 'comment']],
    },
  } as any);
  monaco.languages.registerCompletionItemProvider(PATTERN_LANG, {
    provideCompletionItems(model, position) {
      const w = model.getWordUntilPosition(position);
      const range = { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: w.startColumn, endColumn: w.endColumn };
      const K = monaco.languages.CompletionItemKind;
      const words = [...PATTERN_WORDS, 'beforeRender', 'render', 'render2D'];
      return {
        suggestions: [
          ...words.map((n) => ({
            label: n, range, documentation: { value: PATTERN_HELP[n] ?? '' },
            kind: n in CONSTANTS || HOST_GLOBALS.includes(n) ? K.Constant : K.Function,
            insertText: n,
          })),
          ...KEYWORDS.map((k) => ({ label: k, kind: K.Keyword, insertText: k, range })),
        ],
      };
    },
  });
  monaco.languages.registerHoverProvider(PATTERN_LANG, {
    provideHover(model, position) {
      const w = model.getWordAtPosition(position);
      if (!w) return null;
      const help = PATTERN_HELP[w.word] ?? (/^(slider|hsvPicker|rgbPicker|toggle|trigger|inputNumber)[A-Z]/.test(w.word) ? CONTROL_HELP : null);
      return help ? { contents: [{ value: help }] } : null;
    },
  });
}
