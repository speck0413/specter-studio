// The live preview strip: the pattern runs in its own thread (worker.ts) at up to 60 frames a second and the
// lights are painted straight into the page. A pattern that stops answering is stopped (the thread is ended)
// and a plain message says so; the controls the pattern exports sit under the strip.
import { useEffect, useRef, useState } from 'react';
import { Alert, Box, Button, FormControlLabel, Slider, Stack, Switch, TextField, Typography } from '@mui/material';
import PatternWorker from './worker?worker';
import type { FromWorker, ToWorker } from './worker';
import { hex, hexToRgb, pickerHex, rgbToHsv } from './swatch';

/** How long the preview waits for a frame before it stops the pattern. */
export const STALL_MS = 1500;

type Ctl = { kind: string; name: string; label: string };
export interface PreviewError { message: string; line: number; phase: 'compile' | 'run' | 'stalled' }

const storeKey = (id: string) => `specter-pattern-controls:${id}`;
function loadSaved(id: string): { controls: Record<string, number[]>; vars: Record<string, number> } {
  try {
    const v = JSON.parse(localStorage.getItem(storeKey(id)) || 'null');
    if (v && typeof v === 'object') return { controls: v.controls || {}, vars: v.vars || {} };
  } catch { /* a private window or blocked storage: start fresh */ }
  return { controls: {}, vars: {} };
}
function keepSaved(id: string, s: { controls: Record<string, number[]>; vars: Record<string, number> }) {
  try { localStorage.setItem(storeKey(id), JSON.stringify(s)); } catch { /* not kept */ }
}

export default function PatternPreview({ source, id, pixels, onError }: {
  source: string;
  /** whose control settings these are (the pattern's name) */
  id: string;
  pixels: number;
  onError?: (e: PreviewError | null) => void;
}) {
  const strip = useRef<HTMLDivElement>(null);
  const worker = useRef<Worker | null>(null);
  const waiting = useRef<number>(0);
  const loaded = useRef(false);
  const last = useRef(0);
  const [error, setError] = useState<PreviewError | null>(null);
  const [controls, setControls] = useState<Ctl[]>([]);
  const [vars, setVars] = useState<{ name: string; value: number | null }[]>([]);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const saved = useRef(loadSaved(id));
  const [values, setValues] = useState(saved.current);
  const frames = useRef(0);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const report = (e: PreviewError | null) => { setError(e); onErrorRef.current?.(e); };

  const send = (m: ToWorker) => worker.current?.postMessage(m);
  const stop = () => { worker.current?.terminate(); worker.current = null; loaded.current = false; waiting.current = 0; };
  const start = () => {
    stop();
    const w = new PatternWorker();
    w.onmessage = (ev: MessageEvent<FromWorker>) => {
      const m = ev.data;
      if (m.type === 'loaded') {
        loaded.current = true;
        last.current = performance.now();
        setControls(m.controls);
        setVars(m.vars);
        report(null);
      } else if (m.type === 'frame') {
        waiting.current = 0;
        paint(m.rgb);
        // the values on screen follow the pattern a few times a second, not every frame
        if (++frames.current % 10 === 0) setVars(m.vars);
      } else if (m.type === 'error') {
        loaded.current = false;
        waiting.current = 0;
        if (m.phase === 'compile') { setControls([]); setVars([]); }
        report({ message: m.message, line: m.line, phase: m.phase });
      }
    };
    w.onerror = (e) => { e.preventDefault(); loaded.current = false; report({ message: 'The preview could not start.', line: 0, phase: 'run' }); };
    worker.current = w;
    return w;
  };

  const paint = (rgb: Uint8Array) => {
    const el = strip.current;
    if (!el) return;
    const n = Math.min(el.children.length, rgb.length / 3);
    for (let i = 0; i < n; i++) {
      const c = el.children[i] as HTMLElement;
      const v = hex(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]);
      if (c.dataset.rgb !== v) { c.dataset.rgb = v; c.style.backgroundColor = v; }
    }
  };

  // (re)load the pattern 300 ms after typing stops; a new thread each time, so a stuck one never lingers
  useEffect(() => {
    const t = setTimeout(() => {
      const w = start();
      w.postMessage({ type: 'load', source, pixelCount: pixels, controls: values.controls, vars: values.vars } satisfies ToWorker);
    }, 300);
    return () => clearTimeout(t);
  }, [source, pixels]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => stop(), []); // eslint-disable-line react-hooks/exhaustive-deps

  // frames: one asked for at a time, at the screen's rate (60 a second); no answer within STALL_MS stops it
  useEffect(() => {
    let raf = 0;
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (!worker.current || !loaded.current) return;
      if (waiting.current) {
        if (now - waiting.current > STALL_MS) {
          stop();
          report({ message: 'The preview stopped answering, so the pattern was stopped (a loop that never ends?). Change the pattern to try again.', line: 0, phase: 'stalled' });
        }
        return;
      }
      if (pausedRef.current) { last.current = now; return; }
      const delta = Math.min(now - last.current, 1000);
      last.current = now;
      waiting.current = now || 1;
      send({ type: 'frame', delta });
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const remember = (next: typeof values) => { setValues(next); saved.current = next; keepSaved(id, next); };
  const setControl = (name: string, vals: number[]) => { send({ type: 'control', name, values: vals }); remember({ ...values, controls: { ...values.controls, [name]: vals } }); };
  const setVar = (name: string, v: number) => { send({ type: 'var', name, value: v }); remember({ ...values, vars: { ...values.vars, [name]: v } }); };

  const size = pixels > 120 ? 6 : pixels > 60 ? 10 : 18;
  return (
    <Stack spacing={1.5} data-testid="pattern-preview">
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
        <Typography variant="subtitle2" component="h3" sx={{ flex: 1 }}>Preview</Typography>
        <Button size="small" variant="outlined" onClick={() => setPaused(!paused)} aria-pressed={paused}>{paused ? 'Play' : 'Pause'}</Button>
      </Stack>
      <Box ref={strip} role="img" aria-label={`Preview of ${pixels} lights`} data-testid="pattern-strip"
        sx={{ display: 'flex', flexWrap: 'wrap', gap: '3px', p: 1.5, borderRadius: 1, bgcolor: '#0b0b0b', border: 1, borderColor: 'divider', opacity: error ? 0.45 : 1 }}>
        {Array.from({ length: pixels }, (_, i) => (
          <Box key={i} data-testid="pattern-led" data-rgb="#000000" sx={{ width: size, height: size, borderRadius: '50%', bgcolor: '#000000', boxShadow: '0 0 0 1px #333 inset' }} />
        ))}
      </Box>
      {error && <Alert severity="error" data-testid="pattern-error">{error.message}</Alert>}
      {(controls.length > 0 || vars.length > 0) && (
        <Stack spacing={1} data-testid="pattern-controls" sx={{ maxWidth: 480 }}>
          <Typography variant="subtitle2" component="h3">Controls</Typography>
          {controls.map((c) => {
            const v = values.controls[c.name];
            if (c.kind === 'slider') return (
              <Stack key={c.name} direction="row" spacing={2} sx={{ alignItems: 'center' }}>
                <Typography id={`ctl-${c.name}`} sx={{ width: 140 }} noWrap>{c.label}</Typography>
                <Slider size="small" min={0} max={1} step={0.01} value={v?.[0] ?? 0.5} aria-labelledby={`ctl-${c.name}`} data-testid={`control-${c.name}`}
                  onChange={(_, x) => setControl(c.name, [x as number])} />
              </Stack>
            );
            if (c.kind === 'hsvPicker' || c.kind === 'rgbPicker') {
              // nothing set yet: no colour is made up; the pattern starts in its own (whatever its code sets)
              const val = pickerHex(c.kind, v);
              return (
                <Stack key={c.name} direction="row" spacing={2} sx={{ alignItems: 'center' }}>
                  <Typography component="label" htmlFor={`ctl-${c.name}`} sx={{ width: 140 }} noWrap>{c.label}</Typography>
                  <Box sx={{ position: 'relative', width: 48, height: 26, flexShrink: 0 }}>
                    <Box data-testid={`swatch-${c.name}`} data-unset={val ? 'false' : 'true'} aria-hidden
                      sx={{ position: 'absolute', inset: 0, borderRadius: 1, border: 1, borderColor: 'divider', bgcolor: val ?? 'grey.400',
                        backgroundImage: val ? 'none' : 'repeating-linear-gradient(45deg, rgba(255,255,255,0.6) 0 4px, transparent 4px 8px)' }} />
                    <input id={`ctl-${c.name}`} type="color" value={val ?? '#808080'} data-testid={`control-${c.name}`}
                      aria-describedby={val ? undefined : `ctl-${c.name}-own`}
                      onChange={(e) => { const rgb = hexToRgb(e.target.value); setControl(c.name, c.kind === 'hsvPicker' ? rgbToHsv(...rgb) : rgb); }}
                      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', padding: 0, border: 'none', opacity: 0, cursor: 'pointer' }} />
                  </Box>
                  {!val && <Typography id={`ctl-${c.name}-own`} variant="body2" color="text.secondary">the pattern’s own</Typography>}
                </Stack>
              );
            }
            if (c.kind === 'toggle') return (
              <FormControlLabel key={c.name} control={<Switch size="small" checked={(v?.[0] ?? 0) > 0} onChange={(e) => setControl(c.name, [e.target.checked ? 1 : 0])} />} label={c.label} />
            );
            if (c.kind === 'trigger') return <Box key={c.name}><Button size="small" variant="outlined" onClick={() => send({ type: 'control', name: c.name, values: [] })}>{c.label}</Button></Box>;
            return (
              <TextField key={c.name} size="small" type="number" label={c.label} value={v?.[0] ?? 0} sx={{ maxWidth: 200 }}
                onChange={(e) => { const x = Number(e.target.value); if (Number.isFinite(x)) setControl(c.name, [x]); }} />
            );
          })}
          {vars.map((x) => {
            if (x.value === null) return null;
            const set = values.vars[x.name] ?? x.value;
            const small = set >= 0 && set <= 1;
            return (
              <Stack key={x.name} direction="row" spacing={2} sx={{ alignItems: 'center' }} data-testid={`var-${x.name}`}>
                <Typography id={`var-${x.name}-label`} sx={{ width: 140, fontFamily: 'monospace' }} noWrap>{x.name}</Typography>
                {small
                  ? <Slider size="small" min={0} max={1} step={0.01} value={x.value} aria-labelledby={`var-${x.name}-label`} onChange={(_, v) => setVar(x.name, v as number)} />
                  : <TextField size="small" type="number" value={Math.round(x.value * 1000) / 1000} slotProps={{ htmlInput: { 'aria-labelledby': `var-${x.name}-label` } }} sx={{ maxWidth: 140 }}
                      onChange={(e) => { const v = Number(e.target.value); if (Number.isFinite(v)) setVar(x.name, v); }} />}
                <Typography variant="caption" color="text.secondary" sx={{ width: 56, textAlign: 'right' }} data-testid={`var-${x.name}-value`}>{Math.round(x.value * 100) / 100}</Typography>
              </Stack>
            );
          })}
        </Stack>
      )}
    </Stack>
  );
}
