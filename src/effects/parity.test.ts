/// <reference types="node" />
// SS-C5 for Studio's own reading of a script. The board's checker (through check_script, see
// core/tests/checker_parity.rs) decides what is right; Studio's blocks, C++ export and hints read the same text
// on their own, so every golden case checks that they never contradict the board's answer:
// - blocks: a line the board takes as a step or a header is that kind of block, with the same terminal; a line
//   the board does not understand is a "line" block;
// - C++ export: the effects, triggers, times and levels it writes are the board's (from the case's step table);
// - hints: a hint under a board message names only terminals that the message does not rule out; the
//   "one press runs both" warning sees the inputs the board's effects wait for.
// Trace-only cases (no `check`) hold scripts the board saves, so they count as checks with no errors.
// SHOW_SCRIPT_GOLDEN=<dir with cases/> runs another golden set (scripts/checker-parity.sh).
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from './blocks';
import { duration, percent, scriptToCpp } from './cppgen';
import { hoverFor } from './language';
import { conflicts, missingHint } from '../words';

const GOLDEN = process.env.SHOW_SCRIPT_GOLDEN || path.resolve(__dirname, '../../firmware/firmware/show-script-golden');

interface Msg { line: number; message: string }
interface Step { line: number; op: string; input?: string; target?: string; level?: number; ms?: number; sound?: number; setting?: string; board?: string; effect?: string; value?: string }
interface Case { name: string; text: string; settings: Record<string, unknown>; check: { ok: boolean; errors: Msg[]; warnings: Msg[]; table?: { effects: { name: string; line: number; steps: Step[] }[] } } }

function cases(): Case[] {
  const dir = path.join(GOLDEN, 'cases');
  return fs.readdirSync(dir).sort().flatMap((name) => {
    const c = JSON.parse(fs.readFileSync(path.join(dir, name, 'case.json'), 'utf8'));
    const check = c.check || { ok: true, errors: [], warnings: [] };
    return [{ name, text: fs.readFileSync(path.join(dir, name, 'script.txt'), 'utf8'), settings: c.settings || {}, check }];
  });
}

// the lines as the board numbers them (README "Reading a line" 1)
function lines(text: string): string[] {
  const l = text.replace(/\r\n|\r/g, '\n').split('\n');
  if (l.length && l[l.length - 1] === '') l.pop();
  return l;
}
// blank or only a comment once read (README "Reading a line" 2-4)
const blank = (raw: string) => !raw.replace(/[\t  ]/g, ' ').split('#')[0].trim().replace(/\.$/, '').trim();

const KIND: Record<string, string> = {
  wait_for: 'ps_wait', set: 'ps_set', sleep: 'ps_sleep', fade: 'ps_fade', flicker: 'ps_flicker',
  audio_single: 'ps_audio_single', audio_loop: 'ps_audio_loop', audio_stop: 'ps_audio_stop', pulse: 'ps_pulse', audio_loop_off: 'ps_audio_loop',
  audio_volume: 'ps_audio_volume', pixels: 'ps_pixels', tell: 'ps_tell',
};
// the advanced line that adds no step (SHOW-SCRIPT.md): its block
const DECL = /^\s*limit\b/i;
// M-unknown, and (newer firmware) its hint forms for the commonest mistakes: "out1 on", "play x", "turn ..."
const UNKNOWN = /^line \d+: (I do not understand |write it as three lines: |to play a sound, write |write it as "[a-z]+\d+ = )/;
const squash = (s: string) => s.replace(/ /g, '').toLowerCase();
const ms = (d: string | null) => {
  const m = d && /^(milliseconds|seconds|minutes)\(([\d.]+)\)$/.exec(d);
  if (!m) return null;
  return Math.round(Number(m[2]) * (m[1] === 'minutes' ? 60000 : m[1] === 'seconds' ? 1000 : 1));
};

// a case that names terminals (settings <terminal>_name, SS-N) is read with the board's names, which these offline
// readers do not know: the board's own checker covers it (core/tests/checker_parity.rs)
const all = cases().filter((c) => !Object.keys(c.settings).some((k) => k.endsWith('_name')));

describe('Studio reads every golden script as the board does', () => {
  it('has the golden set', () => expect(all.length).toBeGreaterThan(70));

  it.each(all.map((c) => [c.name, c] as const))('blocks: %s', (_n, c) => {
    const ls = lines(c.text);
    const steps = new Map<number, Step>();
    const headers = new Set<number>();
    for (const e of c.check.table?.effects || []) {
      headers.add(e.line);
      for (const s of e.steps) steps.set(s.line, s);
    }
    const errs = new Map(c.check.errors.map((e) => [e.line, e.message]));
    const s_has = (n: number) => steps.has(n);
    const wrong: string[] = [];
    ls.forEach((raw, i) => {
      const n = i + 1;
      if (blank(raw)) return;
      const p = parse(raw);
      const err = errs.get(n);
      if (UNKNOWN.test(err || '') && p.type !== 'ps_raw') wrong.push(`line ${n} ${JSON.stringify(raw)}: the board does not understand it, blocks read ${p.type}`);
      if (!err && p.type === 'ps_raw') wrong.push(`line ${n} ${JSON.stringify(raw)}: the board takes it, blocks read a line they do not know`);
      if (headers.has(n) && p.type !== 'ps_effect') wrong.push(`line ${n}: a header for the board, blocks read ${p.type}`);
      if (!err && !s_has(n) && DECL.test(raw) && p.type !== 'ps_limit') wrong.push(`line ${n} ${JSON.stringify(raw)}: an advanced line, blocks read ${p.type}`);
      const s = steps.get(n);
      if (s) {
        if (p.type !== KIND[s.op]) wrong.push(`line ${n} ${JSON.stringify(raw)}: the board reads ${s.op}, blocks read ${p.type}`);
        else if (s.input && squash(p.f.INPUT) !== s.input.toLowerCase()) wrong.push(`line ${n}: input ${s.input}, blocks ${p.f.INPUT}`);
        else if (s.target && squash(p.f.TARGET) !== s.target.toLowerCase()) wrong.push(`line ${n}: target ${s.target}, blocks ${p.f.TARGET}`);
        else if (s.op === 'tell' && p.f.BOARD.toLowerCase() !== s.board) wrong.push(`line ${n}: tells ${s.board}, blocks ${p.f.BOARD}`);
        else if (s.op === 'tell' && s.effect && p.f.DO.toLowerCase().replace(/ +/g, '_') !== s.effect) wrong.push(`line ${n}: effect ${s.effect}, blocks ${p.f.DO}`);
        else if (s.setting && s.op === 'tell' && squash(p.f.DO.split(/[=:]/)[0]) !== s.setting) wrong.push(`line ${n}: setting ${s.setting}, blocks ${p.f.DO}`);
      }
    });
    expect(wrong).toEqual([]);
  });

  it.each(all.filter((c) => c.check.table).map((c) => [c.name, c] as const))('C++ export: %s', (_n, c) => {
    const ls = lines(c.text);
    const effects = c.check.table!.effects;
    const cpp = scriptToCpp(c.text);
    const wrong: string[] = [];
    const count = (cpp.match(/^ {2}\/\/ effect /gm) || []).length;
    if (count !== effects.length) wrong.push(`${effects.length} effects for the board, ${count} in the C++`);
    const whens = [...cpp.matchAll(/prop\.when\((\w+)\)/g)].map((m) => m[1]);
    // an effect's trigger is its first wait for (sound lines may come before it)
    const firsts = effects.map((e) => e.steps.find((s) => s.op === 'wait_for')?.input).filter(Boolean);
    if (JSON.stringify(whens) !== JSON.stringify(firsts)) wrong.push(`triggers ${firsts} for the board, ${whens} in the C++`);
    for (const e of effects) for (const s of e.steps) {
      // the export reads a line as the board does: one trailing "." dropped (README "Reading a line" 3)
      const p = parse(ls[s.line - 1].replace(/\.(\s*(#.*)?)$/, '$1'));
      // a time kept as a setting (SS-G6) has no number to compare: the export leaves that line as a comment
      if ((s.op === 'sleep' || s.op === 'fade' || s.op === 'flicker') && !s.setting && ms(duration(p.f.TIME)) !== s.ms) wrong.push(`line ${s.line}: ${s.ms} ms for the board, C++ ${duration(p.f.TIME)}`);
      if ((s.op === 'fade' || s.op === 'set') && /^OUT/.test(s.target!)) {
        const pc = percent(p.f.LEVEL);
        if (pc === null || Math.round(pc * 10) !== s.level) wrong.push(`line ${s.line}: level ${s.level}‰ for the board, C++ ${pc}%`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it.each(all.filter((c) => c.check.table).map((c) => [c.name, c] as const))('inputs in use: %s', (_n, c) => {
    const ALL = ['TRIG1', 'TRIG2', 'USER1', 'USER2', 'USER3'];
    const board: any = { script: { text: c.text }, shows: [{ id: 1, name: 's', enabled: true, inputs: ALL }] };
    const seen = conflicts(board).map((m) => m.split(' ')[0]).sort();
    const want = [...new Set(c.check.table!.effects.flatMap((e) => e.steps.filter((s) => s.op === 'wait_for').map((s) => s.input!)))].sort();
    expect(seen).toEqual(want);
  });

  it.each(all.filter((c) => c.check.errors.length).map((c) => [c.name, c] as const))('hints: %s', (_n, c) => {
    const wrong: string[] = [];
    for (const e of c.check.errors) {
      const h = missingHint(e.message);
      if (!h) continue;
      // a hint may suggest a terminal; never one the message says is not there
      const missing = /there is no (\S+) on this board/.exec(e.message)?.[1];
      for (const t of h.match(/\b(out\d+|rly\d+|cc\d+|trig\d+|user\d+)\b/gi) || []) if (t.toLowerCase() === missing) wrong.push(`${e.message} -> ${h}`);
    }
    expect(wrong).toEqual([]);
  });

  it('hover help says USER1-3 are triggers (current firmware has no "buttons" setting)', () => {
    for (const u of ['user1', 'user2', 'user3']) {
      expect(hoverFor(u)).toMatch(/trigger/i);
      expect(hoverFor(u)).not.toMatch(/learn|record-mode|default/i);
    }
  });
});
