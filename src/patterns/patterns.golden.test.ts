// The shared golden vectors (firmware/pattern-golden in the firmware submodule): Studio's interpreter must give
// every case's lights byte for byte, run from the case's program bytes, as the board's native test does.
// PATTERN_GOLDEN_OUT=<firmware checkout>/firmware/pattern-golden writes them again from golden/cases.ts.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compilePattern } from './compile';
import { decodeProgram, encodeProgram, fromBase64, toBase64 } from './encode';
import { GOLDEN_CASES } from './golden/cases';
import { runGolden } from './golden/run';
import { BOARD_LIMITS } from './vm';

const OUT = process.env.PATTERN_GOLDEN_OUT;
const DIR = join(__dirname, '../../firmware/firmware/pattern-golden');

describe('pattern golden vectors', () => {
  it.runIf(!!OUT)('are written from golden/cases.ts', () => {
    const cases = join(OUT!, 'cases');
    rmSync(cases, { recursive: true, force: true });
    mkdirSync(cases, { recursive: true });
    writeFileSync(join(OUT!, 'limits.json'), JSON.stringify(BOARD_LIMITS, null, 2) + '\n');
    for (const c of GOLDEN_CASES) {
      const prog = compilePattern(c.source);
      const bytes = encodeProgram(prog);
      const r = runGolden(decodeProgram(bytes), c.pixels, c.seed, c.steps);
      const doc = { name: c.name, source: c.source, program: toBase64(bytes), pixels: c.pixels, seed: c.seed, steps: c.steps, ...r };
      writeFileSync(join(cases, `${c.name}.json`), JSON.stringify(doc, null, 1) + '\n');
    }
  });

  it.runIf(existsSync(DIR))('give the same lights here as on the board (the submodule\'s set)', () => {
    expect(JSON.parse(readFileSync(join(DIR, 'limits.json'), 'utf8'))).toEqual(BOARD_LIMITS);
    const files = readdirSync(join(DIR, 'cases')).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThan(20);
    for (const f of files) {
      const c = JSON.parse(readFileSync(join(DIR, 'cases', f), 'utf8'));
      const prog = decodeProgram(fromBase64(c.program));
      const r = runGolden(prog, c.pixels, c.seed, c.steps);
      expect(r.frames, c.name).toEqual(c.frames);
      expect(r.error, c.name).toEqual(c.error);
      // and Studio compiles the source to the same bytes
      expect(toBase64(encodeProgram(compilePattern(c.source))), c.name).toBe(c.program);
    }
  });

  it('every case still compiles, fits a board and ends as it should', () => {
    for (const c of GOLDEN_CASES) {
      const prog = compilePattern(c.source);
      const r = runGolden(decodeProgram(encodeProgram(prog)), c.pixels, c.seed, c.steps);
      expect(!!r.error, c.name).toBe(c.name.startsWith('error-'));
    }
  });
});
