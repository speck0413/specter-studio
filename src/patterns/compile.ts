// Patterns: source text -> a small portable program (numbers only, no JavaScript left), so the same compiled form
// can run in Studio's preview (vm.ts) and, later, in a board's own interpreter. Written from the public
// description of the pattern language (a JavaScript-like subset); no other implementation's code is used.
//
// What a pattern can hold: `var`/`let`/`const`, `function` (and `export function`), `export var`, `if`/`else`,
// `for`, `while`, `do … while`, `break`, `continue`, `return`, the usual operators (also bitwise and `? :`),
// lists (`array(n)`, `[1, 2, 3]`, `a[i]`, `a.length`, `a.forEach(f)` …), and arrow or anonymous functions that
// use only their own values and the pattern's globals (no closures, objects, text or `switch`).
//
// The program (PatternProgram) is plain data: a list of numbers (the code), the globals' names, the functions'
// start addresses, the entry points and the controls. Opcodes and built-in ids (builtins.ts) only ever grow.
// No DOM or editor imports here, so it can be bundled into a plain module for the board's phone page.

import { BUILTIN_ID, BUILTINS, CONSTANTS, HOST_GLOBALS, METHODS } from './builtins';

export enum Op {
  CONST = 1, LOADG, STOREG, LOADL, STOREL, LOADF, POP, DUP, DUP2,
  ADD, SUB, MUL, DIV, MOD, NEG, BAND, BOR, BXOR, BNOT, SHL, SHR, USHR,
  EQ, NE, LT, LE, GT, GE, NOT,
  JMP, JZ, ANDJ, ORJ, CALL, CALLV, CALLB, RET, IDXGET, IDXSET,
}
/** How many numbers follow each opcode in the code list. */
export const OP_ARGS: Record<number, number> = {
  [Op.CONST]: 1, [Op.LOADG]: 1, [Op.STOREG]: 1, [Op.LOADL]: 1, [Op.STOREL]: 1, [Op.LOADF]: 1,
  [Op.JMP]: 1, [Op.JZ]: 1, [Op.ANDJ]: 1, [Op.ORJ]: 1, [Op.CALL]: 2, [Op.CALLV]: 1, [Op.CALLB]: 2,
};

export type ControlKind = 'slider' | 'hsvPicker' | 'rgbPicker' | 'toggle' | 'trigger' | 'inputNumber';
export interface Control { kind: ControlKind; name: string; label: string; fn: number }
export interface PatternFunction { name: string; addr: number; params: number; locals: number }
export interface PatternProgram {
  format: 'specter-pattern';
  version: 1;
  /** opcodes and their arguments; numbers are 16.16 fixed point (value × 65536, a 32-bit integer) */
  code: number[];
  /** the source line of every entry in `code` (for error messages; not needed to run) */
  lines: number[];
  /** global names; the first ones are HOST_GLOBALS, which the player sets */
  globals: string[];
  /** function 0 is the pattern's top-level code, run once when it loads */
  functions: PatternFunction[];
  entry: { beforeRender?: number; render?: number; render2D?: number; render3D?: number };
  /** exported functions named slider…, hsvPicker…, rgbPicker…, toggle…, trigger…, inputNumber… */
  controls: Control[];
  /** `export var` globals: shown and changeable in the preview */
  vars: { name: string; global: number }[];
}

export class PatternError extends Error {
  constructor(message: string, public line = 0) { super(line ? `Line ${line}: ${message}` : message); }
}

export const FIX = 65536;
export const MAX_NUMBER = 32768 - 1 / FIX;
/** A number as 16.16 fixed point; anything outside ±32768 wraps, as on the board. */
export const toFix = (x: number) => (Number.isFinite(x) ? Math.round(x * FIX) | 0 : 0);

// ------------------------------------------------------------------------------------------------ tokens

type Tok = { t: 'num' | 'id' | 'op' | 'eof'; v: string; n?: number; line: number };
const KEYWORDS = new Set(['var', 'let', 'const', 'function', 'export', 'if', 'else', 'for', 'while', 'do', 'return', 'break', 'continue', 'true', 'false']);
const OPS = ['>>>=', '>>>', '<<=', '>>=', '===', '!==', '==', '!=', '<=', '>=', '&&', '||', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '++', '--', '<<', '>>', '=>',
  '+', '-', '*', '/', '%', '&', '|', '^', '~', '!', '<', '>', '=', '?', ':', ',', ';', '(', ')', '[', ']', '{', '}', '.'];

export function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0, line = 1;
  while (i < src.length) {
    const c = src[i];
    if (c === '\n') { line++; i++; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (src.startsWith('//', i)) { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (src.startsWith('/*', i)) {
      const end = src.indexOf('*/', i + 2);
      if (end < 0) throw new PatternError('a /* comment */ is never closed', line);
      for (let k = i; k < end; k++) if (src[k] === '\n') line++;
      i = end + 2; continue;
    }
    const num = /^(0[xX][0-9a-fA-F]+|0[bB][01]+|(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?)/.exec(src.slice(i, i + 64));
    if (num && /[\d.]/.test(c) && !(c === '.' && !/\d/.test(src[i + 1] ?? ''))) {
      const s = num[0];
      const v = /^0[xX]/.test(s) ? parseInt(s.slice(2), 16) : /^0[bB]/.test(s) ? parseInt(s.slice(2), 2) : parseFloat(s);
      out.push({ t: 'num', v: s, n: v, line });
      i += s.length; continue;
    }
    const id = /^[A-Za-z_$][\w$]*/.exec(src.slice(i, i + 256));
    if (id) { out.push({ t: 'id', v: id[0], line }); i += id[0].length; continue; }
    if (c === '"' || c === "'" || c === '`') throw new PatternError('patterns have numbers only, no text in quotes', line);
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new PatternError(`“${c}” is not part of the pattern language`, line);
    out.push({ t: 'op', v: op === '===' ? '==' : op === '!==' ? '!=' : op, line });
    i += op.length;
  }
  out.push({ t: 'eof', v: '', line });
  return out;
}

// ------------------------------------------------------------------------------------------------ syntax tree

type Node = { k: string; line: number; [key: string]: any };

class Parser {
  private p = 0;
  constructor(private toks: Tok[]) {}
  private get cur() { return this.toks[this.p]; }
  private peek(o = 1) { return this.toks[Math.min(this.p + o, this.toks.length - 1)]; }
  private is(v: string) { const t = this.cur; return (t.t === 'op' || t.t === 'id') && t.v === v; }
  private eat(v: string) { if (this.is(v)) { this.p++; return true; } return false; }
  private expect(v: string, what?: string) {
    if (!this.eat(v)) throw new PatternError(`expected “${v}”${what ? ` ${what}` : ''} but found ${this.describe(this.cur)}`, this.cur.line);
  }
  private describe(t: Tok) { return t.t === 'eof' ? 'the end of the pattern' : `“${t.v}”`; }
  private name(what: string) {
    const t = this.cur;
    if (t.t !== 'id' || KEYWORDS.has(t.v)) throw new PatternError(`expected ${what} but found ${this.describe(t)}`, t.line);
    this.p++;
    return t.v;
  }
  private semi() { this.eat(';'); }

  program(): Node[] {
    const body: Node[] = [];
    while (this.cur.t !== 'eof') body.push(this.statement(true));
    return body;
  }

  private block(): Node[] {
    this.expect('{');
    const body: Node[] = [];
    while (!this.is('}')) {
      if (this.cur.t === 'eof') throw new PatternError('a { block } is never closed', this.cur.line);
      body.push(this.statement(false));
    }
    this.p++;
    return body;
  }

  private statement(top: boolean): Node {
    const t = this.cur, line = t.line;
    if (t.t === 'op' && t.v === '{') return { k: 'block', line, body: this.block() };
    if (t.t === 'op' && t.v === ';') { this.p++; return { k: 'block', line, body: [] }; }
    if (t.t === 'id') switch (t.v) {
      case 'export': {
        this.p++;
        if (!top) throw new PatternError('“export” belongs at the top of the pattern, not inside a function or block', line);
        if (this.is('function')) { const f = this.funcDecl(); f.exported = true; return f; }
        if (this.is('var') || this.is('let') || this.is('const')) { const v = this.varDecl(); v.exported = true; this.semi(); return v; }
        throw new PatternError('“export” goes before “var” or “function”', line);
      }
      case 'function':
        if (!top) throw new PatternError('put a function at the top of the pattern, not inside another one or a block', line);
        return this.funcDecl();
      case 'var': case 'let': case 'const': { const v = this.varDecl(); this.semi(); return v; }
      case 'if': {
        this.p++; this.expect('('); const cond = this.expr(); this.expect(')');
        const then = this.statement(false);
        const other = this.eat('else') ? this.statement(false) : null;
        return { k: 'if', line, cond, then, other };
      }
      case 'while': {
        this.p++; this.expect('('); const cond = this.expr(); this.expect(')');
        return { k: 'while', line, cond, body: this.statement(false) };
      }
      case 'do': {
        this.p++; const body = this.statement(false);
        this.expect('while', 'after a “do” block'); this.expect('('); const cond = this.expr(); this.expect(')'); this.semi();
        return { k: 'do', line, cond, body };
      }
      case 'for': {
        this.p++; this.expect('(');
        let init: Node | null = null;
        if (this.is('var') || this.is('let') || this.is('const')) init = this.varDecl();
        else if (!this.is(';')) init = { k: 'expr', line, e: this.expr() };
        this.expect(';', 'in “for (start; test; step)”');
        const cond = this.is(';') ? null : this.expr();
        this.expect(';', 'in “for (start; test; step)”');
        const step = this.is(')') ? null : this.expr();
        this.expect(')');
        return { k: 'for', line, init, cond, step, body: this.statement(false) };
      }
      case 'return': {
        this.p++;
        const e = this.is(';') || this.is('}') || this.cur.t === 'eof' ? null : this.expr();
        this.semi();
        return { k: 'return', line, e };
      }
      case 'break': case 'continue': this.p++; this.semi(); return { k: t.v, line };
    }
    const e = this.expr();
    this.semi();
    return { k: 'expr', line, e };
  }

  private funcDecl(): Node {
    const line = this.cur.line;
    this.expect('function');
    const name = this.name('a function name');
    return { k: 'func', line, name, ...this.funcRest() };
  }
  private funcRest() {
    this.expect('(');
    const params: string[] = [];
    while (!this.is(')')) { params.push(this.name('a value name')); if (!this.eat(',')) break; }
    this.expect(')');
    return { params, body: this.block() };
  }

  private varDecl(): Node {
    const line = this.cur.line;
    this.p++;
    const decls: { name: string; init: Node | null; line: number }[] = [];
    do {
      const l = this.cur.line;
      const name = this.name('a variable name');
      decls.push({ name, init: this.eat('=') ? this.assign() : null, line: l });
    } while (this.eat(','));
    return { k: 'var', line, decls };
  }

  expr(): Node {
    let e = this.assign();
    while (this.is(',')) { const line = this.cur.line; this.p++; e = { k: 'seq', line, a: e, b: this.assign() }; }
    return e;
  }

  private arrowAhead(): boolean {
    if (this.cur.t === 'id' && this.peek().v === '=>') return true;
    if (!this.is('(')) return false;
    let depth = 0;
    for (let k = this.p; k < this.toks.length; k++) {
      const v = this.toks[k];
      if (v.t !== 'op') continue;
      if (v.v === '(') depth++;
      else if (v.v === ')' && --depth === 0) return this.toks[k + 1]?.v === '=>';
    }
    return false;
  }

  private assign(): Node {
    if (this.arrowAhead()) return this.arrow();
    const left = this.ternary();
    const t = this.cur;
    if (t.t === 'op' && ['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=', '>>>='].includes(t.v)) {
      if (left.k !== 'id' && left.k !== 'index') throw new PatternError(`the left side of “${t.v}” must be a variable or a list item`, t.line);
      this.p++;
      return { k: 'assign', line: t.line, op: t.v === '=' ? '' : t.v.slice(0, -1), target: left, value: this.assign() };
    }
    return left;
  }

  private arrow(): Node {
    const line = this.cur.line;
    const params: string[] = [];
    if (this.cur.t === 'id') params.push(this.name('a value name'));
    else {
      this.expect('(');
      while (!this.is(')')) { params.push(this.name('a value name')); if (!this.eat(',')) break; }
      this.expect(')');
    }
    this.expect('=>');
    const body = this.is('{') ? this.block() : [{ k: 'return', line, e: this.assign() }];
    return { k: 'lambda', line, params, body };
  }

  private ternary(): Node {
    const cond = this.binary(0);
    if (!this.is('?')) return cond;
    const line = this.cur.line;
    this.p++;
    const a = this.assign();
    this.expect(':', 'in “test ? a : b”');
    return { k: 'cond', line, cond, a, b: this.assign() };
  }

  private static PREC: Record<string, number> = {
    '||': 1, '&&': 2, '|': 3, '^': 4, '&': 5, '==': 6, '!=': 6, '<': 7, '>': 7, '<=': 7, '>=': 7, '<<': 8, '>>': 8, '>>>': 8, '+': 9, '-': 9, '*': 10, '/': 10, '%': 10,
  };
  private binary(min: number): Node {
    let left = this.unary();
    for (;;) {
      const t = this.cur;
      const prec = t.t === 'op' ? Parser.PREC[t.v] : undefined;
      if (prec === undefined || prec <= min) return left;
      this.p++;
      left = { k: 'bin', line: t.line, op: t.v, a: left, b: this.binary(prec) };
    }
  }

  private unary(): Node {
    const t = this.cur;
    if (t.t === 'op' && ['-', '+', '!', '~'].includes(t.v)) { this.p++; return { k: 'unary', line: t.line, op: t.v, e: this.unary() }; }
    if (t.t === 'op' && (t.v === '++' || t.v === '--')) {
      this.p++;
      const e = this.unary();
      if (e.k !== 'id' && e.k !== 'index') throw new PatternError(`“${t.v}” needs a variable or a list item`, t.line);
      return { k: 'incdec', line: t.line, op: t.v, target: e, prefix: true };
    }
    return this.postfix();
  }

  private postfix(): Node {
    let e = this.primary();
    for (;;) {
      const t = this.cur;
      if (t.t !== 'op') return e;
      if (t.v === '(') {
        this.p++;
        const args: Node[] = [];
        while (!this.is(')')) { args.push(this.assign()); if (!this.eat(',')) break; }
        this.expect(')', 'to close the call');
        e = { k: 'call', line: t.line, callee: e, args };
      } else if (t.v === '[') {
        this.p++;
        const i = this.expr();
        this.expect(']');
        e = { k: 'index', line: t.line, obj: e, i };
      } else if (t.v === '.') {
        this.p++;
        e = { k: 'member', line: t.line, obj: e, name: this.name('a name after “.”') };
      } else if (t.v === '++' || t.v === '--') {
        if (e.k !== 'id' && e.k !== 'index') return e;
        this.p++;
        e = { k: 'incdec', line: t.line, op: t.v, target: e, prefix: false };
      } else return e;
    }
  }

  private primary(): Node {
    const t = this.cur, line = t.line;
    if (t.t === 'num') {
      this.p++;
      // 32768 itself is allowed so that -32768 can be written; hex and binary are whole numbers that wrap
      if (t.n! > 32768 && !/^0[xXbB]/.test(t.v)) throw new PatternError(`${t.v} is too big: pattern numbers go from -32768 to 32767.99`, line);
      return { k: 'num', line, v: toFix(t.n!) };
    }
    if (t.t === 'id') {
      if (t.v === 'true' || t.v === 'false') { this.p++; return { k: 'num', line, v: t.v === 'true' ? FIX : 0 }; }
      if (t.v === 'function') { this.p++; return { k: 'lambda', line, ...this.funcRest() }; }
      if (KEYWORDS.has(t.v)) throw new PatternError(`“${t.v}” cannot be used here`, line);
      this.p++;
      return { k: 'id', line, name: t.v };
    }
    if (t.t === 'op' && t.v === '(') { this.p++; const e = this.expr(); this.expect(')'); return e; }
    if (t.t === 'op' && t.v === '[') {
      this.p++;
      const items: Node[] = [];
      while (!this.is(']')) { items.push(this.assign()); if (!this.eat(',')) break; }
      this.expect(']', 'to close the list');
      return { k: 'list', line, items };
    }
    throw new PatternError(`unexpected ${this.describe(t)}`, line);
  }
}

// ------------------------------------------------------------------------------------------------ code

const CONTROL_PREFIX: [string, ControlKind][] = [['slider', 'slider'], ['hsvPicker', 'hsvPicker'], ['rgbPicker', 'rgbPicker'], ['toggle', 'toggle'], ['trigger', 'trigger'], ['inputNumber', 'inputNumber']];
/** "sliderFadeSpeed" -> "Fade speed" */
export function controlLabel(rest: string): string {
  const words = rest.replace(/_/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim().toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : rest;
}

const BIN: Record<string, Op> = {
  '+': Op.ADD, '-': Op.SUB, '*': Op.MUL, '/': Op.DIV, '%': Op.MOD, '&': Op.BAND, '|': Op.BOR, '^': Op.BXOR, '<<': Op.SHL, '>>': Op.SHR, '>>>': Op.USHR,
  '==': Op.EQ, '!=': Op.NE, '<': Op.LT, '<=': Op.LE, '>': Op.GT, '>=': Op.GE,
};

interface Scope { locals: Map<string, number> | null; outer: Set<string>; loops: { breaks: number[]; conts: number[] }[] }

class Gen {
  code: number[] = [];
  lines: number[] = [];
  globals: string[] = [...HOST_GLOBALS];
  gindex = new Map<string, number>(HOST_GLOBALS.map((g, i) => [g, i]));
  fnIndex = new Map<string, number>();
  functions: PatternFunction[] = [{ name: '(top)', addr: 0, params: 0, locals: 0 }];
  queue: { idx: number; node: Node; outer: Set<string> }[] = [];
  line = 0;

  emit(...words: number[]) { for (const w of words) { this.code.push(w); this.lines.push(this.line); } return this.code.length; }
  /** a jump with its target filled in later; returns where the target goes */
  jump(op: Op) { this.emit(op, -1); return this.code.length - 1; }
  patch(at: number, to = this.code.length) { this.code[at] = to; }

  global(name: string, line: number) {
    if (this.gindex.has(name)) return this.gindex.get(name)!;
    if (name in CONSTANTS) throw new PatternError(`${name} is a built-in number and cannot be changed`, line);
    if (name in BUILTIN_ID) throw new PatternError(`${name} is a built-in function: pick another name`, line);
    if (this.globals.length >= 1024) throw new PatternError('too many variables (at most 1024)', line);
    this.gindex.set(name, this.globals.length);
    this.globals.push(name);
    return this.globals.length - 1;
  }

  /** The `var` names declared in these statements, not looking inside functions. */
  declared(body: Node[], out: { name: string; line: number }[] = []) {
    for (const s of body) {
      if (!s) continue;
      if (s.k === 'var') for (const d of s.decls) out.push({ name: d.name, line: d.line });
      else if (s.k === 'block') this.declared(s.body, out);
      else if (s.k === 'if') { this.declared([s.then], out); if (s.other) this.declared([s.other], out); }
      else if (s.k === 'while' || s.k === 'do') this.declared([s.body], out);
      else if (s.k === 'for') { if (s.init) this.declared([s.init], out); this.declared([s.body], out); }
    }
    return out;
  }

  stmts(body: Node[], sc: Scope) { for (const s of body) this.stmt(s, sc); }

  stmt(s: Node, sc: Scope) {
    this.line = s.line;
    switch (s.k) {
      case 'func': return; // compiled on its own
      case 'block': return this.stmts(s.body, sc);
      case 'var':
        for (const d of s.decls) {
          if (!d.init) {
            if (sc.locals) { this.line = d.line; this.emit(Op.CONST, 0); this.store({ k: 'id', name: d.name, line: d.line }, sc); }
            continue;
          }
          this.line = d.line;
          this.expr(d.init, sc);
          this.store({ k: 'id', name: d.name, line: d.line }, sc);
        }
        return;
      case 'expr':
        this.expr(s.e, sc, true);
        return;
      case 'if': {
        this.expr(s.cond, sc);
        const jz = this.jump(Op.JZ);
        this.stmt(s.then, sc);
        if (s.other) {
          const jend = this.jump(Op.JMP);
          this.patch(jz);
          this.stmt(s.other, sc);
          this.patch(jend);
        } else this.patch(jz);
        return;
      }
      case 'while': {
        const top = this.code.length;
        this.expr(s.cond, sc);
        const jz = this.jump(Op.JZ);
        const loop = { breaks: [jz], conts: [] as number[] };
        sc.loops.push(loop);
        this.stmt(s.body, sc);
        sc.loops.pop();
        this.emit(Op.JMP, top);
        loop.conts.forEach((c) => this.patch(c, top));
        loop.breaks.forEach((b) => this.patch(b));
        return;
      }
      case 'do': {
        const top = this.code.length;
        const loop = { breaks: [] as number[], conts: [] as number[] };
        sc.loops.push(loop);
        this.stmt(s.body, sc);
        sc.loops.pop();
        const test = this.code.length;
        this.line = s.line;
        this.expr(s.cond, sc);
        const jz = this.jump(Op.JZ);
        this.emit(Op.JMP, top);
        this.patch(jz);
        loop.conts.forEach((c) => this.patch(c, test));
        loop.breaks.forEach((b) => this.patch(b));
        return;
      }
      case 'for': {
        if (s.init) this.stmt(s.init, sc);
        const top = this.code.length;
        const loop = { breaks: [] as number[], conts: [] as number[] };
        if (s.cond) { this.line = s.line; this.expr(s.cond, sc); loop.breaks.push(this.jump(Op.JZ)); }
        sc.loops.push(loop);
        this.stmt(s.body, sc);
        sc.loops.pop();
        const step = this.code.length;
        this.line = s.line;
        if (s.step) this.expr(s.step, sc, true);
        this.emit(Op.JMP, top);
        loop.conts.forEach((c) => this.patch(c, step));
        loop.breaks.forEach((b) => this.patch(b));
        return;
      }
      case 'return':
        if (!sc.locals) throw new PatternError('“return” belongs inside a function', s.line);
        if (s.e) this.expr(s.e, sc); else this.emit(Op.CONST, 0);
        this.emit(Op.RET);
        return;
      case 'break': case 'continue': {
        const loop = sc.loops[sc.loops.length - 1];
        if (!loop) throw new PatternError(`“${s.k}” belongs inside a loop`, s.line);
        (s.k === 'break' ? loop.breaks : loop.conts).push(this.jump(Op.JMP));
        return;
      }
    }
    throw new PatternError(`cannot compile “${s.k}”`, s.line);
  }

  /** Where a name lives: a local, a global, a function, a built-in number. */
  resolve(name: string, sc: Scope, line: number): { local?: number; global?: number; fn?: number; num?: number } {
    if (sc.locals?.has(name)) return { local: sc.locals.get(name)! };
    if (sc.outer.has(name)) throw new PatternError(`“${name}” belongs to the function around this one; a function inside another can use only its own values and the pattern's global variables`, line);
    if (this.gindex.has(name)) return { global: this.gindex.get(name)! };
    if (this.fnIndex.has(name)) return { fn: this.fnIndex.get(name)! };
    if (name in CONSTANTS) return { num: toFix(CONSTANTS[name]) };
    if (name in BUILTIN_ID) throw new PatternError(`${name} is a built-in function: call it, as in ${name}(…)`, line);
    throw new PatternError(`there is no “${name}” (a typo, or a variable that needs “var ${name}” first?)`, line);
  }

  store(target: Node, sc: Scope) {
    const r = this.resolve(target.name, sc, target.line);
    if (r.local !== undefined) this.emit(Op.STOREL, r.local);
    else if (r.global !== undefined) this.emit(Op.STOREG, r.global);
    else throw new PatternError(`“${target.name}” cannot be changed`, target.line);
  }

  /** Compiles an expression; `drop`: its value is not used. */
  expr(e: Node, sc: Scope, drop = false): void {
    this.line = e.line;
    switch (e.k) {
      case 'num': if (!drop) this.emit(Op.CONST, e.v); return;
      case 'id': {
        const r = this.resolve(e.name, sc, e.line);
        if (!drop) {
          if (r.local !== undefined) this.emit(Op.LOADL, r.local);
          else if (r.global !== undefined) this.emit(Op.LOADG, r.global);
          else if (r.fn !== undefined) this.emit(Op.LOADF, r.fn);
          else this.emit(Op.CONST, r.num!);
        }
        return;
      }
      case 'seq': this.expr(e.a, sc, true); this.expr(e.b, sc, drop); return;
      case 'list':
        if (e.items.length > 64) throw new PatternError('a [list] in the text can hold at most 64 values: use array(n) for more', e.line);
        for (const it of e.items) this.expr(it, sc);
        this.line = e.line;
        this.emit(Op.CALLB, BUILTIN_ID.__list, e.items.length);
        break;
      case 'unary':
        if (e.op === '-' && e.e.k === 'num') { if (!drop) this.emit(Op.CONST, (-e.e.v) | 0); return; }
        this.expr(e.e, sc);
        this.line = e.line;
        if (e.op === '-') this.emit(Op.NEG);
        else if (e.op === '!') this.emit(Op.NOT);
        else if (e.op === '~') this.emit(Op.BNOT);
        break;
      case 'bin':
        if (e.op === '&&' || e.op === '||') {
          this.expr(e.a, sc);
          const j = this.jump(e.op === '&&' ? Op.ANDJ : Op.ORJ);
          this.expr(e.b, sc);
          this.patch(j);
          break;
        }
        this.expr(e.a, sc);
        this.expr(e.b, sc);
        this.line = e.line;
        this.emit(BIN[e.op]);
        break;
      case 'cond': {
        this.expr(e.cond, sc);
        const jz = this.jump(Op.JZ);
        this.expr(e.a, sc);
        const jend = this.jump(Op.JMP);
        this.patch(jz);
        this.expr(e.b, sc);
        this.patch(jend);
        break;
      }
      case 'assign': case 'incdec': {
        const t = e.target as Node;
        const op = e.k === 'incdec' ? (e.op === '++' ? '+' : '-') : e.op;
        const value = () => { if (e.k === 'incdec') this.emit(Op.CONST, FIX); else this.expr(e.value, sc); this.line = e.line; };
        if (t.k === 'id') {
          if (op) this.expr(t, sc);
          value();
          if (op) this.emit(BIN[op]);
          if (!drop) this.emit(Op.DUP);
          this.store(t, sc);
        } else {
          this.expr(t.obj, sc);
          this.expr(t.i, sc);
          this.line = e.line;
          if (op) { this.emit(Op.DUP2); this.emit(Op.IDXGET); }
          value();
          if (op) this.emit(BIN[op]);
          this.emit(Op.IDXSET);
          if (drop) this.emit(Op.POP);
        }
        // x++ gives the value from before
        if (!drop && e.k === 'incdec' && !e.prefix) { this.emit(Op.CONST, FIX); this.emit(e.op === '++' ? Op.SUB : Op.ADD); }
        return;
      }
      case 'index':
        this.expr(e.obj, sc);
        this.expr(e.i, sc);
        this.line = e.line;
        this.emit(Op.IDXGET);
        break;
      case 'member':
        if (e.name !== 'length') throw new PatternError(`“.${e.name}” is not something a list has (lists have .length, .forEach, .mapTo, .mutate, .reduce, .sum and .sort)`, e.line);
        this.expr(e.obj, sc);
        this.line = e.line;
        this.emit(Op.CALLB, BUILTIN_ID.arrayLength, 1);
        break;
      case 'call': this.call(e, sc); break;
      case 'lambda': {
        const idx = this.functions.length;
        this.functions.push({ name: '(function)', addr: -1, params: e.params.length, locals: 0 });
        const outer = new Set([...sc.outer, ...(sc.locals ? sc.locals.keys() : [])]);
        this.queue.push({ idx, node: e, outer });
        this.emit(Op.LOADF, idx);
        break;
      }
      default: throw new PatternError(`cannot compile “${e.k}”`, e.line);
    }
    if (drop) this.emit(Op.POP);
  }

  call(e: Node, sc: Scope) {
    const c = e.callee as Node;
    const args = e.args as Node[];
    if (c.k === 'member') {
      if (c.name === 'length') throw new PatternError('.length is a number, not a function', e.line);
      const b = METHODS[c.name];
      if (!b) throw new PatternError(`lists have no “.${c.name}()”`, e.line);
      this.expr(c.obj, sc);
      for (const a of args) this.expr(a, sc);
      this.line = e.line;
      this.emit(Op.CALLB, BUILTIN_ID[b], args.length + 1);
      return;
    }
    if (c.k === 'id' && !sc.locals?.has(c.name) && !this.gindex.has(c.name)) {
      if (this.fnIndex.has(c.name)) {
        for (const a of args) this.expr(a, sc);
        this.line = e.line;
        this.emit(Op.CALL, this.fnIndex.get(c.name)!, args.length);
        return;
      }
      if (c.name in BUILTIN_ID && !c.name.startsWith('__')) {
        const want = BUILTINS[BUILTIN_ID[c.name]].n;
        if (want >= 0 && args.length > want) throw new PatternError(`${c.name}() takes ${want} value${want === 1 ? '' : 's'}, not ${args.length}`, e.line);
        for (const a of args) this.expr(a, sc);
        // missing values are 0
        for (let i = args.length; i < want; i++) this.emit(Op.CONST, 0);
        this.line = e.line;
        this.emit(Op.CALLB, BUILTIN_ID[c.name], Math.max(want, args.length));
        return;
      }
      if (!(c.name in CONSTANTS) && !sc.outer.has(c.name)) throw new PatternError(`there is no function called “${c.name}”${/^perlin|^setPalette|^paint|^bezier|^readMap|^setPerlin|^clockS|^analog|^digital|^pinMode|^sensor|^node|^sequencer|^translate|^rotate|^scale|^transform|^reset/.test(c.name) ? ' (that part of the pattern language is not in Studio yet)' : ''}`, e.line);
    }
    this.expr(c, sc);
    for (const a of args) this.expr(a, sc);
    this.line = e.line;
    this.emit(Op.CALLV, args.length);
  }

  /** One function's code: its values (parameters, then its `var`s) are locals. */
  func(idx: number, node: Node, outer: Set<string>) {
    const f = this.functions[idx];
    f.addr = this.code.length;
    const locals = new Map<string, number>();
    for (const p of node.params as string[]) {
      if (locals.has(p)) throw new PatternError(`“${p}” is named twice`, node.line);
      locals.set(p, locals.size);
    }
    for (const d of this.declared(node.body)) if (!locals.has(d.name)) locals.set(d.name, locals.size);
    if (locals.size > 64) throw new PatternError('a function can have at most 64 values', node.line);
    f.locals = locals.size;
    this.stmts(node.body, { locals, outer, loops: [] });
    this.line = node.line;
    this.emit(Op.CONST, 0, Op.RET);
  }
}

/** Compiles a pattern; throws PatternError (with the line) when it cannot. */
export function compilePattern(src: string): PatternProgram {
  const body = new Parser(tokenize(src)).program();
  const g = new Gen();
  const program: PatternProgram = { format: 'specter-pattern', version: 1, code: g.code, lines: g.lines, globals: g.globals, functions: g.functions, entry: {}, controls: [], vars: [] };
  // functions and globals are known before any code, wherever they are written
  const funcs = body.filter((s) => s.k === 'func');
  for (const f of funcs) {
    if (g.fnIndex.has(f.name)) throw new PatternError(`there are two functions called “${f.name}”`, f.line);
    if (f.name in BUILTIN_ID || f.name in CONSTANTS) throw new PatternError(`${f.name} is built in: give your function another name`, f.line);
    g.fnIndex.set(f.name, g.functions.length);
    g.functions.push({ name: f.name, addr: -1, params: f.params.length, locals: 0 });
  }
  for (const d of g.declared(body)) {
    if (g.fnIndex.has(d.name)) throw new PatternError(`“${d.name}” is already a function`, d.line);
    g.global(d.name, d.line);
  }
  for (const s of body) if (s.k === 'var' && s.exported) for (const d of s.decls) program.vars.push({ name: d.name, global: g.gindex.get(d.name)! });
  for (const f of funcs) {
    const idx = g.fnIndex.get(f.name)!;
    if (f.name === 'beforeRender' || f.name === 'render' || f.name === 'render2D' || f.name === 'render3D') (program.entry as any)[f.name] = idx;
    if (!f.exported) continue;
    const pre = CONTROL_PREFIX.find(([p]) => f.name.startsWith(p) && f.name.length > p.length);
    if (pre) program.controls.push({ kind: pre[1], name: f.name, label: controlLabel(f.name.slice(pre[0].length)), fn: idx });
  }
  // the top-level code is function 0; then every function, then the anonymous ones they hold
  g.stmts(body, { locals: null, outer: new Set(), loops: [] });
  g.emit(Op.CONST, 0, Op.RET);
  for (const f of funcs) g.func(g.fnIndex.get(f.name)!, f, new Set());
  while (g.queue.length) { const q = g.queue.shift()!; g.func(q.idx, q.node, q.outer); }
  if (program.entry.render === undefined && program.entry.render2D === undefined && program.entry.render3D === undefined) {
    throw new PatternError('a pattern needs “export function render(index)”, which gives each light its colour with hsv() or rgb()');
  }
  return program;
}

/** The program as compact text (what would go to a board, or into a file). */
export function programText(p: PatternProgram, withLines = false): string {
  const { lines, ...rest } = p;
  return JSON.stringify(withLines ? p : rest);
}
