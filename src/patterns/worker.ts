// The pattern preview's own thread: compiles and runs the pattern away from the window, so a slow or endless
// pattern never freezes Studio (the window also stops this thread when it does not answer, preview.ts). The
// pattern is interpreted, never run as JavaScript; network and storage are taken away here all the same.
import { compilePattern, PatternError } from './compile';
import { PatternVM } from './vm';

for (const k of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'WebTransport', 'importScripts', 'indexedDB', 'caches', 'RTCPeerConnection', 'BroadcastChannel']) {
  try { Object.defineProperty(self, k, { value: undefined, configurable: false, writable: false }); } catch { /* not there */ }
}

export type ToWorker =
  | { type: 'load'; source: string; pixelCount: number; controls: Record<string, number[]>; vars: Record<string, number> }
  | { type: 'frame'; delta: number }
  | { type: 'control'; name: string; values: number[] }
  | { type: 'var'; name: string; value: number }
  | { type: 'pixels'; count: number };

export type FromWorker =
  | { type: 'loaded'; controls: { kind: string; name: string; label: string }[]; vars: { name: string; value: number | null }[]; size: number }
  | { type: 'frame'; rgb: Uint8Array; vars: { name: string; value: number | null }[] }
  | { type: 'error'; message: string; line: number; phase: 'compile' | 'run' };

let vm: PatternVM | null = null;
const post = (m: FromWorker, transfer: Transferable[] = []) => (self as any).postMessage(m, transfer);
const vars = () => (vm ? vm.prog.vars.map((v) => ({ name: v.name, value: vm!.getVar(v.name) })) : []);
const fail = (e: unknown, phase: 'compile' | 'run') => {
  vm = null;
  post({ type: 'error', message: e instanceof Error ? e.message : String(e), line: e instanceof PatternError ? e.line : 0, phase });
};

self.onmessage = (ev: MessageEvent<ToWorker>) => {
  const m = ev.data;
  if (m.type === 'load') {
    let prog;
    try { prog = compilePattern(m.source); } catch (e) { return fail(e, 'compile'); }
    try {
      vm = new PatternVM(prog, { pixelCount: m.pixelCount, timeLimitMs: 200 });
      vm.init();
      for (const [name, value] of Object.entries(m.vars)) if (prog.vars.some((v) => v.name === name)) vm.setVar(name, value);
      for (const [name, values] of Object.entries(m.controls)) vm.setControl(name, values);
    } catch (e) { return fail(e, 'run'); }
    post({ type: 'loaded', controls: prog.controls.map(({ kind, name, label }) => ({ kind, name, label })), vars: vars(), size: prog.code.length });
    return;
  }
  if (!vm) return;
  try {
    if (m.type === 'frame') {
      const rgb = vm.frame(m.delta).slice();
      post({ type: 'frame', rgb, vars: vars() }, [rgb.buffer]);
    } else if (m.type === 'control') vm.setControl(m.name, m.values);
    else if (m.type === 'var') vm.setVar(m.name, m.value);
    else if (m.type === 'pixels') vm.setPixelCount(m.count);
  } catch (e) { fail(e, 'run'); }
};
