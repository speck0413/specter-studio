// Runs one golden case the way the board's golden test does: the program from its bytes, a fixed random source,
// a clock that never reaches the time limit (only the step budget stops a pattern), the steps in order.

import { PatternError, PatternProgram } from '../compile';
import { xorshift16 } from '../fixed';
import { PatternVM } from '../vm';
import { GoldenStep } from './cases';

export interface GoldenResult { frames: string[]; error?: { step: number; message: string } }

const hex = (b: Uint8Array) => Array.from(b, (v) => v.toString(16).padStart(2, '0')).join('');

export function runGolden(prog: PatternProgram, pixels: number, seed: number, steps: GoldenStep[]): GoldenResult {
  const vm = new PatternVM(prog, { pixelCount: pixels, random16: xorshift16(seed), now: () => 0 });
  const frames: string[] = [];
  let step = -1;
  try {
    vm.init();
    for (step = 0; step < steps.length; step++) {
      const s = steps[step];
      if ('frame' in s) frames.push(hex(vm.frame(s.frame)));
      else vm.setControlFixed(s.control, s.values);
    }
    return { frames };
  } catch (e) {
    if (!(e instanceof PatternError)) throw e;
    return { frames, error: { step, message: e.plain } };
  }
}
