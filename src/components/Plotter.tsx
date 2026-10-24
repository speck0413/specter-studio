// A live plotter like the Arduino IDE's. Sources: a board's own values over the network (outputs, inputs,
// number status values: no code needed), or a serial port's lines ("12 34", "temp:21.5 hum:40").
import { useEffect, useRef, useState } from 'react';
import { Box, Button, Chip, Stack, Typography, useTheme } from '@mui/material';
import { onEvent } from '../api';
import { statusText } from '../words';
import { useStore } from '../store';

export type Sample = Record<string, number>;
const WINDOW_MS = 30_000;

/** Numbers in a serial line: "a:1 b:2" or "1, 2 3" (unnamed values are value1, value2 ...). */
export function parseLine(line: string): Sample | null {
  const out: Sample = {};
  const named = [...line.matchAll(/([A-Za-z_][\w ]*?)\s*[:=]\s*(-?\d+(?:\.\d+)?(?:e-?\d+)?)/g)];
  if (named.length) {
    for (const m of named) out[m[1].trim()] = Number(m[2]);
    return out;
  }
  const nums = line.trim().split(/[\s,;\t]+/).filter(Boolean);
  if (!nums.length || nums.some((n) => !/^-?\d+(\.\d+)?(e-?\d+)?$/i.test(n))) return null;
  nums.forEach((n, i) => { out[`value${i + 1}`] = Number(n); });
  return out;
}

/** A board's state as numbers: outputs in %, inputs 0/100, number status values as they are. */
export function stateSample(st: any): Sample {
  const s: Sample = {};
  for (const o of st?.outputs || []) s[o.alias || o.channel] = o.level / 10;
  for (const i of st?.inputs || []) s[i.alias || i.input] = i.raw || i.active ? 100 : 0;
  for (const x of st?.status || []) if (typeof x.value === 'number') s[x.alias || x.key] = x.value;
  return s;
}

/** What the person sees for a board's status series (the ids stay as stateSample names them): the plain name. */
export function stateLabels(st: any): Record<string, string> {
  const l: Record<string, string> = {};
  for (const x of st?.status || []) if (typeof x.value === 'number') l[x.alias || x.key] = statusText(x)[0];
  return l;
}

export default function Plotter({ source }: { source: { board: string } | { serial: string } }) {
  const theme = useTheme();
  const { boards } = useStore();
  const boardsRef = useRef(boards);
  boardsRef.current = boards;
  const canvas = useRef<HTMLCanvasElement>(null);
  const data = useRef<{ t: number; s: Sample }[]>([]);
  const [names, setNames] = useState<string[]>([]);
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [paused, setPaused] = useState(false);
  // a board's plot shows only what moved (13 flat lines at 0 tell nobody anything); a serial plot shows everything
  const boardSource = 'board' in source;
  const first = useRef<Sample>({});
  const [moved, setMoved] = useState<Set<string>>(new Set());
  const shownRef = useRef<string[]>([]);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  useEffect(() => {
    data.current = [];
    setNames([]);
    // a board's values as they are now: the first change after opening the plot counts as moved
    const now = 'board' in source ? boardsRef.current[source.board]?.state : null;
    setLabels(now ? stateLabels(now) : {});
    first.current = now ? stateSample(now) : {};
    setMoved(new Set());
    return onEvent((e) => {
      if (pausedRef.current) return;
      let s: Sample | null = null;
      if ('board' in source && e.kind === 'board' && e.key === source.board && e.msg.event === 'state') {
        s = stateSample(e.msg.data);
        const l = stateLabels(e.msg.data);
        setLabels((o) => (Object.keys(l).some((k) => o[k] !== l[k]) ? { ...o, ...l } : o));
      }
      if ('serial' in source && (e as any).kind === 'serial' && (e as any).path === source.serial) s = parseLine((e as any).line);
      if (!s) return;
      const now = Date.now();
      data.current.push({ t: now, s });
      while (data.current.length && data.current[0].t < now - WINDOW_MS) data.current.shift();
      const keys = Object.keys(s);
      const fresh: string[] = [];
      for (const k of keys) {
        if (!(k in first.current)) first.current[k] = s[k];
        else if (first.current[k] !== s[k]) fresh.push(k);
      }
      if (fresh.length) setMoved((m) => (fresh.some((k) => !m.has(k)) ? new Set([...m, ...fresh]) : m));
      setNames((n) => (keys.some((k) => !n.includes(k)) ? [...new Set([...n, ...keys])] : n));
    });
  }, [JSON.stringify(source)]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let raf = 0;
    const draw = () => {
      const c = canvas.current;
      if (c) {
        const w = (c.width = c.clientWidth * devicePixelRatio);
        const h = (c.height = c.clientHeight * devicePixelRatio);
        const g = c.getContext('2d')!;
        g.clearRect(0, 0, w, h);
        const pts = data.current;
        const now = pausedRef.current && pts.length ? pts[pts.length - 1].t : Date.now();
        let lo = Infinity, hi = -Infinity;
        for (const p of pts) for (const [k, v] of Object.entries(p.s)) if (!hidden.has(k)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
        if (lo === Infinity) { lo = 0; hi = 100; }
        if (hi - lo < 1e-9) { hi += 1; lo -= 1; }
        const pad = 30 * devicePixelRatio;
        const x = (t: number) => pad + ((t - (now - WINDOW_MS)) / WINDOW_MS) * (w - pad - 8);
        const y = (v: number) => h - pad / 2 - ((v - lo) / (hi - lo)) * (h - pad);
        g.strokeStyle = theme.palette.divider;
        g.fillStyle = theme.palette.text.secondary;
        g.font = `${11 * devicePixelRatio}px sans-serif`;
        for (const v of [lo, (lo + hi) / 2, hi]) { g.beginPath(); g.moveTo(pad, y(v)); g.lineTo(w, y(v)); g.stroke(); g.fillText(String(Math.round(v * 100) / 100), 2, y(v) + 4); }
        // the time along the bottom, in seconds
        for (const ago of [30, 20, 10, 0]) {
          const label = ago ? `${ago} s ago` : 'now';
          const tx = x(now - ago * 1000);
          g.fillText(label, Math.min(Math.max(tx - g.measureText(label).width / 2, pad), w - g.measureText(label).width - 2), h - 2);
        }
        names.forEach((k, i) => {
          if (hidden.has(k) || !shownRef.current.includes(k)) return;
          g.strokeStyle = theme.palette.series.colors[i % theme.palette.series.colors.length];
          g.lineWidth = 2 * devicePixelRatio;
          g.beginPath();
          let started = false;
          for (const p of pts) {
            const v = p.s[k];
            if (v === undefined) continue;
            if (started) g.lineTo(x(p.t), y(v)); else { g.moveTo(x(p.t), y(v)); started = true; }
          }
          g.stroke();
        });
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [names, hidden, theme]);
  const shown = boardSource ? names.filter((n) => moved.has(n)) : names;
  shownRef.current = shown;

  return (
    <Stack spacing={1}>
      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap alignItems="center">
        <Button variant="outlined" onClick={() => setPaused(!paused)}>{paused ? 'Resume' : 'Pause'}</Button>
        <Button onClick={() => { data.current = []; setNames([]); }}>Clear</Button>
        {shown.map((n) => { const i = names.indexOf(n); return (
          <Chip key={n} label={labels[n] || n} variant={hidden.has(n) ? 'outlined' : 'filled'} onClick={() => setHidden((h) => { const s = new Set(h); if (s.has(n)) s.delete(n); else s.add(n); return s; })}
            sx={{ bgcolor: hidden.has(n) ? undefined : theme.palette.series.colors[i % theme.palette.series.colors.length], color: hidden.has(n) ? undefined : theme.palette.series.text }} aria-pressed={!hidden.has(n)} />
        ); })}
      </Stack>
      <Box sx={{ position: 'relative', height: 320, border: 1, borderColor: 'divider', borderRadius: 2 }}>
        <canvas ref={canvas} style={{ width: '100%', height: '100%' }} role="img" aria-label={`Live plot of ${shown.map((n) => labels[n] || n).join(', ') || 'values'} over the last 30 seconds`} data-testid="plot" />
      </Box>
      {names.length === 0 && <Typography color="text.secondary">Waiting for values…</Typography>}
      {names.length > 0 && shown.length === 0 && <Typography color="text.secondary">Nothing has changed yet. Press an input or hold to test an output, and it shows up here.</Typography>}
    </Stack>
  );
}
