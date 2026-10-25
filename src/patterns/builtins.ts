// The built-in functions a pattern can call, in a fixed order: a compiled pattern names a built-in by its place
// in this list (its id), so the board's interpreter can use the same numbers later. Only ever add to the end;
// never reorder or remove (a stored pattern would call the wrong function).
//
// `n` is how many values it takes (-1: any number). Names follow the public pattern language; the behaviour is
// written here from its description, see vm.ts.

export interface Builtin { name: string; n: number }

export const BUILTINS: Builtin[] = [
  { name: 'time', n: 1 },
  { name: 'wave', n: 1 },
  { name: 'triangle', n: 1 },
  { name: 'square', n: 2 },
  { name: 'mix', n: 3 },
  { name: 'smoothstep', n: 3 },
  { name: 'clamp', n: 3 },
  { name: 'sin', n: 1 },
  { name: 'cos', n: 1 },
  { name: 'tan', n: 1 },
  { name: 'asin', n: 1 },
  { name: 'acos', n: 1 },
  { name: 'atan', n: 1 },
  { name: 'atan2', n: 2 },
  { name: 'abs', n: 1 },
  { name: 'floor', n: 1 },
  { name: 'ceil', n: 1 },
  { name: 'round', n: 1 },
  { name: 'trunc', n: 1 },
  { name: 'frac', n: 1 },
  { name: 'min', n: 2 },
  { name: 'max', n: 2 },
  { name: 'pow', n: 2 },
  { name: 'sqrt', n: 1 },
  { name: 'exp', n: 1 },
  { name: 'log', n: 1 },
  { name: 'log2', n: 1 },
  { name: 'hypot', n: 2 },
  { name: 'mod', n: 2 },
  { name: 'random', n: 1 },
  { name: 'prng', n: 1 },
  { name: 'prngSeed', n: 1 },
  { name: 'hsv', n: 3 },
  { name: 'hsv24', n: 3 },
  { name: 'rgb', n: 3 },
  { name: 'array', n: 1 },
  { name: 'arrayForEach', n: 2 },
  { name: 'arrayMapTo', n: 3 },
  { name: 'arrayMutate', n: 2 },
  { name: 'arrayReduce', n: 3 },
  { name: 'arraySum', n: 1 },
  { name: 'arraySort', n: 1 },
  { name: 'arrayLength', n: 1 },
  // not callable by name: `[1, 2, 3]` makes a list through this one
  { name: '__list', n: -1 },
];

export const BUILTIN_ID: Record<string, number> = Object.fromEntries(BUILTINS.map((b, i) => [b.name, i]));

/** `list.forEach(f)` and friends: the method name, the built-in it calls with the list first. */
export const METHODS: Record<string, string> = {
  forEach: 'arrayForEach', mapTo: 'arrayMapTo', mutate: 'arrayMutate', reduce: 'arrayReduce', sum: 'arraySum', sort: 'arraySort',
};

/** Named numbers, folded in when the pattern is compiled. */
export const CONSTANTS: Record<string, number> = {
  PI: Math.PI, PI2: Math.PI * 2, PI3_4: Math.PI * 0.75, PISQ: Math.PI * Math.PI, E: Math.E, LN2: Math.LN2, LN10: Math.LN10,
  LOG2E: Math.LOG2E, LOG10E: Math.LOG10E, SQRT1_2: Math.SQRT1_2, SQRT2: Math.SQRT2,
};

/** Globals the player sets before every frame (always the first globals, in this order). */
export const HOST_GLOBALS = ['pixelCount'];

/** Every name a pattern can use without declaring it (the editor's colours and completion). */
export const PATTERN_WORDS = [...BUILTINS.map((b) => b.name).filter((n) => !n.startsWith('__')), ...Object.keys(CONSTANTS), ...HOST_GLOBALS];
