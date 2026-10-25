// What Studio sends a board for one LED pattern (PROTOCOL.md "LED patterns", op put_pattern): the compiled program's
// bytes and the control values the preview has now. Before anything is sent, the pattern is compiled, checked
// against the board's limits and run for a few frames at the board's own number of lights, so a pattern that would
// stop on the board is said here, in the same words the board would use.

import { compilePattern, PatternError } from './compile';
import { boardFit, encodeProgram, fixedValues, toBase64 } from './encode';
import { boardNameProblem } from './known';
import { PatternVM } from './vm';

export type Prepared = { ok: true; req: Record<string, unknown>; buttons: string[] } | { ok: false; message: string };

/** `controls`: the preview's values by control function (0 to 1; a colour is three); triggers have none. */
export function preparePattern(name: string, source: string, controls: Record<string, number[]>, pixelCount: number): Prepared {
  const nameProblem = boardNameProblem(name);
  if (nameProblem) return { ok: false, message: nameProblem };
  let prog;
  try { prog = compilePattern(source); } catch (e) { return { ok: false, message: `The pattern does not compile: ${(e as Error).message}` }; }
  const fit = boardFit(prog);
  if (fit) return { ok: false, message: `Not sent: ${fit}.` };
  const sent: Record<string, number[]> = {};
  for (const c of prog.controls) {
    const v = controls[c.name];
    if (c.kind !== 'trigger' && Array.isArray(v) && v.length) sent[c.name] = fixedValues(v);
  }
  // a trial on the board's terms: its limits, its lights, its frame time (a board is slower: only the steps count)
  try {
    const vm = new PatternVM(prog, { pixelCount: Math.max(1, pixelCount), timeLimitMs: 5000 });
    vm.init();
    for (const [n, v] of Object.entries(sent)) vm.setControlFixed(n, v);
    for (let i = 0; i < 5; i++) vm.frame(20);
  } catch (e) {
    const m = e instanceof PatternError ? e.plain : String(e);
    return { ok: false, message: `Not sent: on a board with ${pixelCount} lights it would stop: ${m}.` };
  }
  return {
    ok: true,
    req: { op: 'put_pattern', name: name.trim().replace(/\s+/g, ' '), program: toBase64(encodeProgram(prog)), controls: sent },
    buttons: prog.controls.filter((c) => c.kind === 'trigger').map((c) => c.label.toLowerCase()),
  };
}
