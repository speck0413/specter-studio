// Runs a compiled pattern (compile.ts) the way a board will: every number is 16.16 fixed point (a 32-bit integer
// holding value × 65536, from -32768 to 32767.99998), so sums that overflow wrap around and the bitwise
// operators work on the whole 32-bit word. Each frame has a budget of steps and of time: a pattern that loops
// forever stops with a plain message instead of freezing Studio.
//
// The built-ins are written here from the public description of the pattern language; see builtins.ts for the
// list and the ids.

import { BUILTINS } from './builtins';
import { FIX, Op, PatternError, PatternProgram, toFix } from './compile';

export class PList { constructor(public v: Val[]) {} }
export class PFunc { constructor(public i: number) {} }
export type Val = number | PList | PFunc;

export interface VmOptions {
  pixelCount?: number;
  /** steps one frame (or one control change) may take */
  budget?: number;
  /** milliseconds one frame may take */
  timeLimitMs?: number;
  now?: () => number;
  random?: () => number;
}

const MAX_DEPTH = 48;
const MAX_CELLS = 100_000;
const CHUNK = 8192;
export const DEFAULT_BUDGET = 4_000_000;

/** 16.16 multiply: the exact 64-bit product shifted down by 16, wrapped to 32 bits (no low bits lost). */
export function fmul(a: number, b: number): number {
  const ah = a >> 16, al = a & 0xffff;
  return (ah * b + Math.floor((al * b) / FIX)) | 0;
}
/** 16.16 divide, rounded toward zero; dividing by zero gives the largest number of the right sign (0 / 0 is 0). */
export function fdiv(a: number, b: number): number {
  if (b === 0) return a > 0 ? 0x7fffffff : a < 0 ? -0x80000000 : 0;
  return Math.trunc((a * FIX) / b) | 0;
}
const f = (v: number) => v / FIX;
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

export class PatternVM {
  readonly prog: PatternProgram;
  globals: Val[];
  /** milliseconds since the pattern started (time() and the waves follow it) */
  clock = 0;
  pixelCount: number;
  /** red, green, blue per light, 0 to 255 */
  out: Uint8Array;
  private S: Val[] = new Array(4096);
  private sp = 0;
  private depth = 0;
  private left = 0;
  private spent = 0;
  private budget: number;
  private deadline = 0;
  private timeLimit: number;
  private now: () => number;
  private random: () => number;
  private cells = 0;
  private seed = 0x2545f491;
  private r = 0; private g = 0; private b = 0;

  constructor(prog: PatternProgram, opts: VmOptions = {}) {
    this.prog = prog;
    this.globals = new Array(prog.globals.length).fill(0);
    this.pixelCount = Math.max(1, Math.min(4096, Math.floor(opts.pixelCount ?? 16)));
    this.out = new Uint8Array(this.pixelCount * 3);
    this.budget = opts.budget ?? DEFAULT_BUDGET;
    this.timeLimit = opts.timeLimitMs ?? 250;
    this.now = opts.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    this.random = opts.random ?? Math.random;
  }

  /** Runs the pattern's top-level code once (its variables get their first values). */
  init() {
    this.globals[0] = toFix(this.pixelCount);
    this.start();
    this.exec(0, []);
  }

  setPixelCount(n: number) {
    this.pixelCount = Math.max(1, Math.min(4096, Math.floor(n)));
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
      if (e.render !== undefined) this.exec(e.render, [idx]);
      else if (e.render2D !== undefined) this.exec(e.render2D, [idx, toFix(i / n), 0]);
      else this.exec(e.render3D!, [idx, toFix(i / n), 0, 0]);
      out[i * 3] = Math.round(this.r * 255);
      out[i * 3 + 1] = Math.round(this.g * 255);
      out[i * 3 + 2] = Math.round(this.b * 255);
    }
    return out;
  }

  /** A control was moved: calls its function with the values (0 to 1; a colour is three of them). */
  setControl(name: string, values: number[]) {
    const c = this.prog.controls.find((x) => x.name === name);
    if (!c) return;
    this.start();
    this.exec(c.fn, values.map(toFix));
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
    this.deadline = this.now() + this.timeLimit;
  }

  private tooLong(pc: number): never {
    throw new PatternError('the pattern took too long on one frame and was stopped (a loop that never ends?)', this.prog.lines[pc] || 0);
  }
  private fail(pc: number, msg: string): never {
    throw new PatternError(msg, this.prog.lines[pc] || 0);
  }
  private num(v: Val, pc: number): number {
    if (typeof v === 'number') return v;
    this.fail(pc, v instanceof PList ? 'a list cannot be used as a number here' : 'a function cannot be used as a number here');
  }
  private list(v: Val, pc: number): PList {
    if (v instanceof PList) return v;
    this.fail(pc, 'this needs a list (make one with array(n) or [1, 2, 3])');
  }

  /** Calls function `fi` with these values and returns what it gives back. */
  exec(fi: number, args: Val[]): Val {
    const prog = this.prog;
    const fn = prog.functions[fi];
    if (++this.depth > MAX_DEPTH) { this.depth = 0; this.fail(fn.addr, `functions call each other too deeply (more than ${MAX_DEPTH} at once)`); }
    const L: Val[] = new Array(fn.locals);
    for (let i = 0; i < fn.locals; i++) L[i] = i < fn.params && i < args.length ? args[i] : 0;
    const code = prog.code, S = this.S, G = this.globals;
    let sp = this.sp;
    const base = sp;
    let pc = fn.addr;
    for (;;) {
      if (--this.left <= 0) {
        this.spent += CHUNK;
        this.left = CHUNK;
        if (this.spent >= this.budget || this.now() > this.deadline) this.tooLong(pc);
      }
      if (sp > 4000) this.fail(pc, 'the pattern ran out of room for its values');
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
        case Op.MUL: sp--; S[sp - 1] = fmul(this.num(S[sp - 1], at), this.num(S[sp], at)); break;
        case Op.DIV: sp--; S[sp - 1] = fdiv(this.num(S[sp - 1], at), this.num(S[sp], at)); break;
        case Op.MOD: { sp--; const b = this.num(S[sp], at); S[sp - 1] = b === 0 ? 0 : (this.num(S[sp - 1], at) % b) | 0; break; }
        case Op.NEG: S[sp - 1] = -this.num(S[sp - 1], at) | 0; break;
        case Op.BAND: sp--; S[sp - 1] = this.num(S[sp - 1], at) & this.num(S[sp], at); break;
        case Op.BOR: sp--; S[sp - 1] = this.num(S[sp - 1], at) | this.num(S[sp], at); break;
        case Op.BXOR: sp--; S[sp - 1] = this.num(S[sp - 1], at) ^ this.num(S[sp], at); break;
        case Op.BNOT: S[sp - 1] = ~this.num(S[sp - 1], at); break;
        // a shift moves the 32-bit word by the whole part of the right side
        case Op.SHL: sp--; S[sp - 1] = this.num(S[sp - 1], at) << ((this.num(S[sp], at) >> 16) & 31); break;
        case Op.SHR: sp--; S[sp - 1] = this.num(S[sp - 1], at) >> ((this.num(S[sp], at) >> 16) & 31); break;
        case Op.USHR: sp--; S[sp - 1] = (this.num(S[sp - 1], at) >>> ((this.num(S[sp], at) >> 16) & 31)) | 0; break;
        case Op.EQ: sp--; S[sp - 1] = S[sp - 1] === S[sp] || (S[sp - 1] instanceof PFunc && S[sp] instanceof PFunc && (S[sp - 1] as PFunc).i === (S[sp] as PFunc).i) ? FIX : 0; break;
        case Op.NE: sp--; S[sp - 1] = S[sp - 1] !== S[sp] && !(S[sp - 1] instanceof PFunc && S[sp] instanceof PFunc && (S[sp - 1] as PFunc).i === (S[sp] as PFunc).i) ? FIX : 0; break;
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
    const fl = (k: number) => n(k) / FIX;
    switch (BUILTINS[id]?.name) {
      case 'time': {
        const period = fl(0) * FIX; // ms: interval × 65.536 s
        if (period <= 0) return 0;
        return toFix((this.clock % period) / period) & 0xffff;
      }
      case 'wave': return toFix((1 + Math.sin(fl(0) * Math.PI * 2)) / 2);
      case 'triangle': { const x = n(0) & 0xffff; return x < 0x8000 ? x * 2 : (0x10000 - x) * 2; }
      case 'square': return (n(0) & 0xffff) < n(1) ? FIX : 0;
      case 'mix': return (n(0) + fmul((n(1) - n(0)) | 0, n(2))) | 0;
      case 'smoothstep': {
        const lo = fl(0), hi = fl(1);
        const t = hi === lo ? (fl(2) < lo ? 0 : 1) : clamp01((fl(2) - lo) / (hi - lo));
        return toFix(t * t * (3 - 2 * t));
      }
      case 'clamp': { const v = n(0), lo = n(1), hi = n(2); return v < lo ? lo : v > hi ? hi : v; }
      case 'sin': return toFix(Math.sin(fl(0)));
      case 'cos': return toFix(Math.cos(fl(0)));
      case 'tan': return toFix(Math.tan(fl(0)));
      case 'asin': return toFix(Math.asin(Math.max(-1, Math.min(1, fl(0)))));
      case 'acos': return toFix(Math.acos(Math.max(-1, Math.min(1, fl(0)))));
      case 'atan': return toFix(Math.atan(fl(0)));
      case 'atan2': return toFix(Math.atan2(fl(0), fl(1)));
      case 'abs': return Math.abs(n(0)) | 0;
      case 'floor': return n(0) & ~0xffff;
      case 'ceil': return -(-n(0) & ~0xffff) | 0;
      case 'round': return ((n(0) + 0x8000) | 0) & ~0xffff;
      case 'trunc': { const v = n(0); return v < 0 ? -(-v & ~0xffff) | 0 : v & ~0xffff; }
      case 'frac': { const v = n(0); return v < 0 ? -(-v & 0xffff) : v & 0xffff; }
      case 'min': return Math.min(n(0), n(1));
      case 'max': return Math.max(n(0), n(1));
      case 'pow': return toFix(Math.pow(fl(0), fl(1)));
      case 'sqrt': return fl(0) <= 0 ? 0 : toFix(Math.sqrt(fl(0)));
      case 'exp': return toFix(Math.exp(fl(0)));
      case 'log': return fl(0) <= 0 ? -0x80000000 : toFix(Math.log(fl(0)));
      case 'log2': return fl(0) <= 0 ? -0x80000000 : toFix(Math.log2(fl(0)));
      case 'hypot': return toFix(Math.hypot(fl(0), fl(1)));
      case 'mod': { const b = n(1); if (b === 0) return 0; let r = n(0) % b; if (r !== 0 && (r < 0) !== (b < 0)) r += b; return r | 0; }
      case 'random': return toFix(this.random() * fl(0));
      case 'prng': {
        let x = this.seed;
        x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
        this.seed = x | 0;
        return toFix(((x >>> 0) / 4294967296) * fl(0));
      }
      case 'prngSeed': this.seed = n(0) || 0x2545f491; return 0;
      case 'hsv': case 'hsv24': {
        let h = fl(0) % 1; if (h < 0) h += 1;
        const s = clamp01(fl(1)), v = clamp01(fl(2));
        const i = Math.floor(h * 6), fr = h * 6 - i, p = v * (1 - s), q = v * (1 - fr * s), t = v * (1 - (1 - fr) * s);
        [this.r, this.g, this.b] = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6];
        return 0;
      }
      case 'rgb': this.r = clamp01(fl(0)); this.g = clamp01(fl(1)); this.b = clamp01(fl(2)); return 0;
      case 'array': {
        const len = Math.max(0, n(0) >> 16);
        if (this.cells + len > MAX_CELLS) this.fail(pc, `the pattern's lists are too big (at most ${MAX_CELLS} values in all)`);
        this.cells += len;
        return new PList(new Array(len).fill(0));
      }
      case '__list': return new PList(a.slice());
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
      case 'arraySort': { const l = this.list(a[0], pc); l.v.sort((x, y) => (typeof x === 'number' ? x : 0) - (typeof y === 'number' ? y : 0)); return 0; }
    }
    this.fail(pc, `the compiled pattern is damaged (unknown built-in ${id})`);
  }
}

/** Compiles nothing: runs an already compiled program for `frames` frames of `deltaMs` (tests, checks). */
export function runFrames(prog: PatternProgram, frames: number, deltaMs = 1000 / 60, opts: VmOptions = {}): Uint8Array {
  const vm = new PatternVM(prog, opts);
  vm.init();
  for (let i = 0; i < frames; i++) vm.frame(deltaMs);
  return vm.out;
}
