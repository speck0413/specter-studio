// Runs a compiled pattern (compile.ts) the way a board does: every number is 16.16 fixed point (a 32-bit integer
// holding value × 65536, from -32768 to 32767.99998), so sums that overflow wrap around and the bitwise
// operators work on the whole 32-bit word. Each frame has a budget of steps and of time: a pattern that loops
// forever stops with a plain message instead of freezing Studio.
//
// The board's interpreter (the firmware's pattern_vm.cpp) does exactly what this file does, step for step and
// bit for bit: the maths is integers only (fixed.ts), random numbers come from a 16-bit source, the clock is
// whole milliseconds on a board, and the limits (BOARD_LIMITS) are the board's. The shared golden vectors
// (firmware/pattern-golden, patterns.golden.test.ts) check that.
//
// The built-ins are written here from the public description of the pattern language; see builtins.ts for the
// list and the ids.

import { BUILTINS } from './builtins';
import { FIX, Op, PatternError, PatternProgram, toFix } from './compile';
import * as fx from './fixed';

export { fdiv, fmul } from './fixed';

export class PList { constructor(public v: Val[]) {} }
export class PFunc { constructor(public i: number) {} }
export type Val = number | PList | PFunc;

/** What a board holds for one pattern; Studio's preview uses the same numbers, so what runs here runs there. */
export interface PatternLimits {
  /** code words (opcodes and their values) */
  code: number;
  globals: number;
  functions: number;
  controls: number;
  /** values being worked on at once */
  stack: number;
  /** functions calling each other at once */
  depth: number;
  /** the values (parameters and `var`s) of every function running at once */
  locals: number;
  /** list values made in all while the pattern runs, one more per list (lists are never given back) */
  cells: number;
  /** steps one frame (or one control change) may take */
  steps: number;
}
export const BOARD_LIMITS: PatternLimits = {
  code: 4096, globals: 256, functions: 128, controls: 16, stack: 256, depth: 12, locals: 512, cells: 2048, steps: 98304,
};

export interface VmOptions {
  pixelCount?: number;
  /** steps one frame (or one control change) may take (default BOARD_LIMITS.steps) */
  budget?: number;
  /** milliseconds one frame may take */
  timeLimitMs?: number;
  now?: () => number;
  /** a random number from 0 to 1 (it is cut to 16 bits, as a board's) */
  random?: () => number;
  /** a random whole number from 0 to 65535 (the golden vectors' source); wins over `random` */
  random16?: () => number;
  limits?: Partial<PatternLimits>;
}

const CHUNK = 8192;
export const DEFAULT_BUDGET = BOARD_LIMITS.steps;
export const MAX_PIXELS = 4096;

const f = (v: number) => v / FIX;

export class PatternVM {
  readonly prog: PatternProgram;
  readonly limits: PatternLimits;
  globals: Val[];
  /** milliseconds since the pattern started (time() follows it) */
  clock = 0;
  pixelCount: number;
  /** red, green, blue per light, 0 to 255 */
  out: Uint8Array;
  private S: Val[];
  private sp = 0;
  private depth = 0;
  private localsUsed = 0;
  private left = 0;
  private spent = 0;
  private budget: number;
  private deadline = 0;
  private timeLimit: number;
  private now: () => number;
  private random16: () => number;
  private cells = 0;
  private seed = 0x2545f491;
  private r = 0; private g = 0; private b = 0;

  constructor(prog: PatternProgram, opts: VmOptions = {}) {
    this.prog = prog;
    this.limits = { ...BOARD_LIMITS, ...(opts.limits ?? {}) };
    this.globals = new Array(prog.globals.length).fill(0);
    this.S = new Array(this.limits.stack + 4);
    this.pixelCount = Math.max(1, Math.min(MAX_PIXELS, Math.floor(opts.pixelCount ?? 16)));
    this.out = new Uint8Array(this.pixelCount * 3);
    this.budget = opts.budget ?? this.limits.steps;
    this.timeLimit = opts.timeLimitMs ?? 250;
    this.now = opts.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    const random = opts.random ?? Math.random;
    this.random16 = opts.random16 ?? (() => Math.floor(random() * 65536) & 0xffff);
  }

  /** Runs the pattern's top-level code once (its variables get their first values). */
  init() {
    this.globals[0] = toFix(this.pixelCount);
    this.start();
    this.exec(0, []);
  }

  setPixelCount(n: number) {
    this.pixelCount = Math.max(1, Math.min(MAX_PIXELS, Math.floor(n)));
    this.out = new Uint8Array(this.pixelCount * 3);
    this.globals[0] = toFix(this.pixelCount);
  }

  /** One frame: beforeRender(delta) once, then render(index) for every light. */
  frame(deltaMs: number): Uint8Array {
    this.clock += deltaMs;
    this.globals[0] = toFix(this.pixelCount);
    this.start();
    const e = this.prog.entry;
    if (e.beforeRender !== undefined) this.exec(e.beforeRender, [toFix(Math.min(deltaMs, 32767))]);
    const n = this.pixelCount, out = this.out;
    for (let i = 0; i < n; i++) {
      this.r = this.g = this.b = 0;
      const idx = i * FIX;
      // i / n as 16.16, halves up (the same whole-number sum as on the board)
      const t = Math.floor((2 * i * FIX + n) / (2 * n));
      if (e.render !== undefined) this.exec(e.render, [idx]);
      else if (e.render2D !== undefined) this.exec(e.render2D, [idx, t, 0]);
      else this.exec(e.render3D!, [idx, t, 0, 0]);
      out[i * 3] = fx.channel(this.r);
      out[i * 3 + 1] = fx.channel(this.g);
      out[i * 3 + 2] = fx.channel(this.b);
    }
    return out;
  }

  /** A control was moved: calls its function with the values (0 to 1; a colour is three of them). */
  setControl(name: string, values: number[]) {
    this.setControlFixed(name, values.map(toFix));
  }
  /** The same with the values already 16.16 (what a board is sent). */
  setControlFixed(name: string, values: number[]) {
    const c = this.prog.controls.find((x) => x.name === name);
    if (!c) return;
    this.start();
    this.exec(c.fn, values);
  }

  /** An `export var`'s value, as a plain number (null for a list or a function). */
  getVar(name: string): number | null {
    const v = this.prog.vars.find((x) => x.name === name);
    const val = v ? this.globals[v.global] : null;
    return typeof val === 'number' ? f(val) : null;
  }
  setVar(name: string, x: number) {
    const v = this.prog.vars.find((y) => y.name === name);
    if (v) this.globals[v.global] = toFix(x);
  }

  private start() {
    this.left = CHUNK;
    this.spent = 0;
    this.sp = 0;
    this.depth = 0;
    this.localsUsed = 0;
    this.deadline = this.now() + this.timeLimit;
  }

  private tooLong(pc: number): never {
    this.fail(pc, 'the pattern took too long on one frame and was stopped (a loop that never ends?)');
  }
  private fail(pc: number, msg: string): never {
    throw new PatternError(msg, this.prog.lines?.[pc] || 0, pc);
  }
  private num(v: Val, pc: number): number {
    if (typeof v === 'number') return v;
    this.fail(pc, v instanceof PList ? 'a list cannot be used as a number here' : 'a function cannot be used as a number here');
  }
  private list(v: Val, pc: number): PList {
    if (v instanceof PList) return v;
    this.fail(pc, 'this needs a list (make one with array(n) or [1, 2, 3])');
  }
  // a list takes its values and one more (a board keeps its length there)
  private newList(len: number, pc: number): PList {
    if (this.cells + len + 1 > this.limits.cells) this.fail(pc, `the pattern's lists are too big (at most ${this.limits.cells} values in all: make lists once, at the top of the pattern)`);
    this.cells += len + 1;
    return new PList(new Array(len).fill(0));
  }

  /** Calls function `fi` with these values and returns what it gives back. */
  exec(fi: number, args: Val[]): Val {
    const prog = this.prog;
    const fn = prog.functions[fi];
    if (++this.depth > this.limits.depth) { this.depth = 0; this.fail(fn.addr, `functions call each other too deeply (more than ${this.limits.depth} at once)`); }
    if (this.localsUsed + fn.locals > this.limits.locals) this.fail(fn.addr, 'the pattern ran out of room for its values');
    this.localsUsed += fn.locals;
    const L: Val[] = new Array(fn.locals);
    for (let i = 0; i < fn.locals; i++) L[i] = i < fn.params && i < args.length ? args[i] : 0;
    const code = prog.code, S = this.S, G = this.globals, maxSp = this.limits.stack;
    let sp = this.sp;
    const base = sp;
    let pc = fn.addr;
    for (;;) {
      if (--this.left <= 0) {
        this.spent += CHUNK;
        this.left = CHUNK;
        if (this.spent >= this.budget || this.now() > this.deadline) this.tooLong(pc);
      }
      if (sp > maxSp) this.fail(pc, 'the pattern ran out of room for its values');
      const at = pc;
      switch (code[pc++]) {
        case Op.CONST: S[sp++] = code[pc++]; break;
        case Op.LOADG: S[sp++] = G[code[pc++]]; break;
        case Op.STOREG: G[code[pc++]] = S[--sp]; break;
        case Op.LOADL: S[sp++] = L[code[pc++]]; break;
        case Op.STOREL: L[code[pc++]] = S[--sp]; break;
        case Op.LOADF: S[sp++] = new PFunc(code[pc++]); break;
        case Op.POP: sp--; break;
        case Op.DUP: S[sp] = S[sp - 1]; sp++; break;
        case Op.DUP2: S[sp] = S[sp - 2]; S[sp + 1] = S[sp - 1]; sp += 2; break;
        case Op.ADD: sp--; S[sp - 1] = (this.num(S[sp - 1], at) + this.num(S[sp], at)) | 0; break;
        case Op.SUB: sp--; S[sp - 1] = (this.num(S[sp - 1], at) - this.num(S[sp], at)) | 0; break;
        case Op.MUL: sp--; S[sp - 1] = fx.fmul(this.num(S[sp - 1], at), this.num(S[sp], at)); break;
        case Op.DIV: sp--; S[sp - 1] = fx.fdiv(this.num(S[sp - 1], at), this.num(S[sp], at)); break;
        case Op.MOD: { sp--; const a = this.num(S[sp - 1], at), b = this.num(S[sp], at); S[sp - 1] = b === 0 || b === -1 ? 0 : (a % b) | 0; break; }
        case Op.NEG: S[sp - 1] = -this.num(S[sp - 1], at) | 0; break;
        case Op.BAND: sp--; S[sp - 1] = this.num(S[sp - 1], at) & this.num(S[sp], at); break;
        case Op.BOR: sp--; S[sp - 1] = this.num(S[sp - 1], at) | this.num(S[sp], at); break;
        case Op.BXOR: sp--; S[sp - 1] = this.num(S[sp - 1], at) ^ this.num(S[sp], at); break;
        case Op.BNOT: S[sp - 1] = ~this.num(S[sp - 1], at); break;
        // a shift moves the 32-bit word by the whole part of the right side
        case Op.SHL: sp--; S[sp - 1] = this.num(S[sp - 1], at) << ((this.num(S[sp], at) >> 16) & 31); break;
        case Op.SHR: sp--; S[sp - 1] = this.num(S[sp - 1], at) >> ((this.num(S[sp], at) >> 16) & 31); break;
        case Op.USHR: sp--; S[sp - 1] = (this.num(S[sp - 1], at) >>> ((this.num(S[sp], at) >> 16) & 31)) | 0; break;
        case Op.EQ: sp--; S[sp - 1] = same(S[sp - 1], S[sp]) ? FIX : 0; break;
        case Op.NE: sp--; S[sp - 1] = same(S[sp - 1], S[sp]) ? 0 : FIX; break;
        case Op.LT: sp--; S[sp - 1] = this.num(S[sp - 1], at) < this.num(S[sp], at) ? FIX : 0; break;
        case Op.LE: sp--; S[sp - 1] = this.num(S[sp - 1], at) <= this.num(S[sp], at) ? FIX : 0; break;
        case Op.GT: sp--; S[sp - 1] = this.num(S[sp - 1], at) > this.num(S[sp], at) ? FIX : 0; break;
        case Op.GE: sp--; S[sp - 1] = this.num(S[sp - 1], at) >= this.num(S[sp], at) ? FIX : 0; break;
        case Op.NOT: S[sp - 1] = S[sp - 1] === 0 ? FIX : 0; break;
        case Op.JMP: pc = code[pc]; break;
        case Op.JZ: if (S[--sp] === 0) pc = code[pc]; else pc++; break;
        // && and ||: the left side is the answer when it decides, else it goes and the right side is worked out
        case Op.ANDJ: if (S[sp - 1] === 0) pc = code[pc]; else { sp--; pc++; } break;
        case Op.ORJ: if (S[sp - 1] !== 0) pc = code[pc]; else { sp--; pc++; } break;
        case Op.CALL: case Op.CALLV: case Op.CALLB: {
          const op = code[at];
          const id = op === Op.CALLV ? -1 : code[pc++];
          const n = code[pc++];
          sp -= n;
          const a = S.slice(sp, sp + n);
          let callee = id;
          if (op === Op.CALLV) {
            const c = S[--sp];
            if (!(c instanceof PFunc)) this.fail(at, 'this is not a function, so it cannot be called');
            callee = c.i;
          }
          this.sp = sp;
          const r = op === Op.CALLB ? this.builtin(callee, a, at) : this.exec(callee, a);
          S[sp++] = r;
          break;
        }
        case Op.RET: {
          const v = S[sp - 1];
          this.sp = base;
          this.depth--;
          this.localsUsed -= fn.locals;
          return v;
        }
        case Op.IDXGET: {
          sp--;
          const l = this.list(S[sp - 1], at), i = this.num(S[sp], at) >> 16;
          S[sp - 1] = i >= 0 && i < l.v.length ? l.v[i] : 0;
          break;
        }
        case Op.IDXSET: {
          sp -= 2;
          const l = this.list(S[sp - 1], at), i = this.num(S[sp], at) >> 16, v = S[sp + 1];
          if (i >= 0 && i < l.v.length) l.v[i] = v;
          S[sp - 1] = v;
          break;
        }
        default: this.fail(at, `the compiled pattern is damaged (unknown step ${code[at]} at ${at})`);
      }
    }
  }

  private call(fnv: Val, args: Val[], pc: number): Val {
    if (!(fnv instanceof PFunc)) this.fail(pc, 'this needs a function, for example (v, i) => v * 2');
    return this.exec(fnv.i, args);
  }

  private builtin(id: number, a: Val[], pc: number): Val {
    const n = (k: number) => this.num(a[k] ?? 0, pc);
    switch (BUILTINS[id]?.name) {
      case 'time': {
        const period = n(0); // milliseconds: the interval × 65.536 s
        if (period <= 0) return 0;
        const r = this.clock % period;
        return Math.floor((2 * r * FIX + period) / (2 * period)) & 0xffff;
      }
      case 'wave': return fx.fwave(n(0));
      case 'triangle': { const x = n(0) & 0xffff; return x < 0x8000 ? x * 2 : (0x10000 - x) * 2; }
      case 'square': return (n(0) & 0xffff) < n(1) ? FIX : 0;
      case 'mix': return (n(0) + fx.fmul((n(1) - n(0)) | 0, n(2))) | 0;
      case 'smoothstep': return fx.smoothstep(n(0), n(1), n(2));
      case 'clamp': { const v = n(0), lo = n(1), hi = n(2); return v < lo ? lo : v > hi ? hi : v; }
      case 'sin': return fx.fsin(n(0));
      case 'cos': return fx.fcos(n(0));
      case 'tan': return fx.ftan(n(0));
      case 'asin': return fx.fasin(n(0));
      case 'acos': return fx.facos(n(0));
      case 'atan': return fx.fatan(n(0));
      case 'atan2': return fx.fatan2(n(0), n(1));
      case 'abs': return Math.abs(n(0)) | 0;
      case 'floor': return n(0) & ~0xffff;
      case 'ceil': return -(-n(0) & ~0xffff) | 0;
      case 'round': return ((n(0) + 0x8000) | 0) & ~0xffff;
      case 'trunc': { const v = n(0); return v < 0 ? -(-v & ~0xffff) | 0 : v & ~0xffff; }
      case 'frac': { const v = n(0); return v < 0 ? -(-v & 0xffff) | 0 : v & 0xffff; }
      case 'min': return Math.min(n(0), n(1));
      case 'max': return Math.max(n(0), n(1));
      case 'pow': return fx.fpow(n(0), n(1));
      case 'sqrt': return fx.fsqrt(n(0));
      case 'exp': return fx.fexp(n(0));
      case 'log': return fx.flog(n(0));
      case 'log2': return fx.flog2(n(0));
      case 'hypot': return fx.fhypot(n(0), n(1));
      case 'mod': { const b = n(1); if (b === 0 || b === -1) return 0; let r = n(0) % b; if (r !== 0 && (r < 0) !== (b < 0)) r += b; return r | 0; }
      case 'random': return fx.fmul(this.random16() & 0xffff, n(0));
      case 'prng': {
        let x = this.seed;
        x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
        this.seed = x | 0;
        return fx.fmul(x >>> 16, n(0));
      }
      case 'prngSeed': this.seed = n(0) || 0x2545f491; return 0;
      case 'hsv': case 'hsv24': [this.r, this.g, this.b] = fx.hsv(n(0), n(1), n(2)); return 0;
      case 'rgb': {
        const c = (x: number) => (x < 0 ? 0 : x > FIX ? FIX : x);
        this.r = c(n(0)); this.g = c(n(1)); this.b = c(n(2));
        return 0;
      }
      case 'array': return this.newList(Math.max(0, n(0) >> 16), pc);
      case '__list': { const l = this.newList(a.length, pc); for (let i = 0; i < a.length; i++) l.v[i] = a[i]; return l; }
      case 'arrayLength': return toFix(this.list(a[0], pc).v.length);
      case 'arrayForEach': { const l = this.list(a[0], pc); for (let i = 0; i < l.v.length; i++) this.call(a[1], [l.v[i], i * FIX, l], pc); return 0; }
      case 'arrayMutate': { const l = this.list(a[0], pc); for (let i = 0; i < l.v.length; i++) l.v[i] = this.call(a[1], [l.v[i], i * FIX, l], pc); return 0; }
      case 'arrayMapTo': {
        const src = this.list(a[0], pc), dst = this.list(a[1], pc);
        for (let i = 0; i < src.v.length && i < dst.v.length; i++) dst.v[i] = this.call(a[2], [src.v[i], i * FIX, src], pc);
        return 0;
      }
      case 'arrayReduce': {
        const l = this.list(a[0], pc);
        let acc: Val = a[2] ?? 0;
        for (let i = 0; i < l.v.length; i++) acc = this.call(a[1], [acc, l.v[i], i * FIX, l], pc);
        return acc;
      }
      case 'arraySum': { const l = this.list(a[0], pc); let s = 0; for (const v of l.v) s = (s + (typeof v === 'number' ? v : 0)) | 0; return s; }
      // a stable sort by value (anything that is not a number counts as 0)
      case 'arraySort': { const l = this.list(a[0], pc); l.v.sort((x, y) => (typeof x === 'number' ? x : 0) - (typeof y === 'number' ? y : 0)); return 0; }
    }
    this.fail(pc, `the compiled pattern is damaged (unknown built-in ${id})`);
  }
}

/** == between two values: numbers by value, lists by which list, functions by which function */
function same(x: Val, y: Val): boolean {
  return x === y || (x instanceof PFunc && y instanceof PFunc && x.i === y.i);
}

/** Compiles nothing: runs an already compiled program for `frames` frames of `deltaMs` (tests, checks). */
export function runFrames(prog: PatternProgram, frames: number, deltaMs = 1000 / 60, opts: VmOptions = {}): Uint8Array {
  const vm = new PatternVM(prog, opts);
  vm.init();
  for (let i = 0; i < frames; i++) vm.frame(deltaMs);
  return vm.out;
}
