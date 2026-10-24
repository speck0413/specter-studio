// What a board card shows of its effects (Boards page and Dashboard tiles):
//   * CardLook: the script's icon beside the board's name; while an effect runs, that effect's icon, its name and
//     the time left.
//   * CardFill: the card fills up in the effect's colour over the run's expected length, like a hold-to-test
//     button; when the length cannot be known, a gentle sweep (a still half fill with reduced motion).
//   * TriggerFlash (Dashboard): when a board starts an effect, its icon covers the card for FLASH_MS and fades;
//     with reduced motion a still badge instead; off in Settings › Look.
// Each part reads the run tracker itself, so a card that is not re-drawn for live states still follows its runs.
import { useEffect, useState } from 'react';
import { Box, Typography } from '@mui/material';
import { keyframes } from '@mui/system';
import { rpc } from '../api';
import { useStore } from '../store';
import { lookOf, runLengthMs, settingNames, settingsOf } from './look';
import { colorHex, PropIcon, resolveIcon } from './icons';
import { FLASH_MS, useRuns, type Run } from './runs';

/** Whether the computer asks for reduced motion (follows a change while Studio runs). */
export function useReducedMotion(): boolean {
  const q = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  const [v, setV] = useState(!!q?.matches);
  useEffect(() => {
    if (!q) return;
    const f = () => setV(q.matches);
    f();
    q.addEventListener?.('change', f);
    return () => q.removeEventListener?.('change', f);
  }, [q?.media]); // eslint-disable-line react-hooks/exhaustive-deps
  return v;
}

/** Re-renders every `ms` while `on`. */
function useTick(on: boolean, ms = 100): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [on, ms]);
  return now;
}

// the settings a board's script names for its times (get_params), read once per settings change
const settingsCache = new Map<string, { seq: number; values: Record<string, number> | null; pending?: Promise<void> }>();
function useBoardSettings(boardKey: string | undefined, script: string | undefined, seq = 0): Record<string, number> | undefined {
  const needed = !!boardKey && !!script && settingNames(script).length > 0;
  const c = boardKey ? settingsCache.get(boardKey) : undefined;
  const [, bump] = useState(0);
  useEffect(() => {
    if (!needed || !boardKey) return;
    const have = settingsCache.get(boardKey);
    if (have && have.seq === seq) { if (have.pending) void have.pending.then(() => bump((n) => n + 1)); return; }
    const entry: { seq: number; values: Record<string, number> | null; pending?: Promise<void> } = { seq, values: null };
    entry.pending = rpc(boardKey, { op: 'get_params' }).then((r) => { entry.values = r?.ok ? settingsOf(r.result?.values) : null; }).catch(() => {}).finally(() => { entry.pending = undefined; bump((n) => n + 1); });
    settingsCache.set(boardKey, entry);
  }, [needed, boardKey, seq]);
  return needed && c && c.seq === seq && c.values ? c.values : undefined;
}

export interface PropRun { run: Run; icon?: string; color: string; label: string; lengthMs: number | null; elapsedMs: number; progress: number | null }

/** The run a board card shows now, with its look and how far along it is (`progress` 0-1, null when its length
 * cannot be known). */
export function usePropRun(label: string, script?: string, boardKey?: string, paramsSeq?: number): PropRun | null {
  const t = useRuns();
  const run = t.runs[label];
  const settings = useBoardSettings(run ? boardKey : undefined, script, paramsSeq);
  const now = useTick(!!run);
  if (!run) return null;
  const look = run.kind === 'script' ? lookOf(script, run.name) : {};
  const r = resolveIcon(look.icon, look.color);
  const lengthMs = run.lengthMs ?? (run.kind === 'script' ? runLengthMs(script, run.name, settings) : null);
  const elapsedMs = Math.max(0, now - run.started);
  const progress = lengthMs && lengthMs > 0 ? Math.min(1, elapsedMs / lengthMs) : lengthMs === 0 ? 1 : null;
  return { run, icon: look.icon, color: r.color, label: r.label, lengthMs, elapsedMs, progress };
}

const runName = (r: Run) => (r.kind === 'effect' ? 'the built-in effect' : r.name ? `“${r.name}”` : 'a show');

function leftText(p: PropRun): string {
  if (p.progress === null) return 'running';
  const left = Math.ceil(((p.lengthMs || 0) - p.elapsedMs) / 1000);
  return left > 0 ? `${left} s left` : 'finishing';
}

/** The script's icon beside a board's name; while it runs an effect, that effect's icon, name and time left. */
export function CardLook({ label, script, boardKey, paramsSeq, size = 22 }: { label: string; script?: string; boardKey?: string; paramsSeq?: number; size?: number }) {
  const p = usePropRun(label, script, boardKey, paramsSeq);
  if (p) {
    return (
      <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, flexShrink: 0, maxWidth: '55%' }} data-testid="card-running">
        <PropIcon icon={p.icon} color={p.color} size={size} label={`${p.label}: ${p.run.name || 'running'}`} testId="card-icon" />
        <Typography variant="body2" sx={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.run.kind === 'effect' ? 'effect' : p.run.name || 'show'}</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ whiteSpace: 'nowrap' }}>{leftText(p)}</Typography>
      </Box>
    );
  }
  if (!script?.trim()) return null;
  const l = lookOf(script);
  return <PropIcon icon={l.icon} color={l.color} size={size} label={`${resolveIcon(l.icon).label}: the effect script's icon`} testId="card-icon" />;
}

const sweep = keyframes`from { transform: translateX(-100%); } to { transform: translateX(250%); }`;

/** The card filling up while an effect runs (put inside a card that is `position: relative; isolation: isolate`). */
export function CardFill({ label, script, boardKey, paramsSeq, name }: { label: string; script?: string; boardKey?: string; paramsSeq?: number; name: string }) {
  const p = usePropRun(label, script, boardKey, paramsSeq);
  const reduced = useReducedMotion();
  if (!p) return null;
  const pct = p.progress === null ? undefined : Math.round(p.progress * 100);
  const tint = `${p.color}2e`;
  return (
    <Box role="progressbar" aria-label={`${name}: ${runName(p.run)} running`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}
      aria-valuetext={pct === undefined ? 'running, length not known' : `${pct} %, ${leftText(p)}`} data-testid="card-fill" data-progress={pct ?? ''}
      sx={{ position: 'absolute', inset: 0, zIndex: -1, pointerEvents: 'none', overflow: 'hidden' }}>
      {pct !== undefined
        ? <Box sx={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${pct}%`, bgcolor: tint, transition: reduced ? 'none' : 'width 100ms linear' }} />
        : <Box sx={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: '40%', bgcolor: tint, ...(reduced ? { width: '50%' } : { animation: `${sweep} 1.8s ease-in-out infinite` }) }} />}
      <Box sx={{ position: 'absolute', left: 0, bottom: 0, height: 4, width: pct !== undefined ? `${pct}%` : '100%', bgcolor: p.color, opacity: pct !== undefined ? 1 : 0.5 }} />
    </Box>
  );
}

const fade = keyframes`0% { opacity: 0; transform: scale(.85); } 12% { opacity: 1; transform: scale(1); } 65% { opacity: 1; } 100% { opacity: 0; transform: scale(1.05); }`;

/** When a board starts an effect: its icon over the card for a moment (the latest start only; nothing queues). */
export function TriggerFlash({ label, script, name }: { label: string; script?: string; name: string }) {
  const { prefs } = useStore();
  const t = useRuns();
  const reduced = useReducedMotion();
  const f = t.flashes[label];
  const [shown, setShown] = useState<number | null>(null);
  useEffect(() => {
    if (!f || Date.now() - f.at > FLASH_MS) return;
    setShown(f.seq);
    const tm = setTimeout(() => setShown((s) => (s === f.seq ? null : s)), Math.max(0, FLASH_MS - (Date.now() - f.at)));
    return () => clearTimeout(tm);
  }, [f?.seq]); // eslint-disable-line react-hooks/exhaustive-deps
  if (prefs.triggerFlash === false || !f || shown !== f.seq) return null;
  const look = f.kind === 'script' ? lookOf(script, f.name) : {};
  const r = resolveIcon(look.icon, look.color);
  const what = f.kind === 'effect' ? 'the built-in effect' : f.name || 'a show';
  const text = `${name} started ${what}`;
  if (reduced) {
    return (
      <Box role="status" aria-label={text} data-testid="trigger-badge" sx={{ position: 'absolute', top: 6, right: 6, zIndex: 2, display: 'flex', alignItems: 'center', gap: 0.5, px: 0.75, py: 0.25, borderRadius: 4, bgcolor: 'background.paper', border: 2, borderColor: colorHex(r.color) || 'divider', pointerEvents: 'none' }}>
        <PropIcon icon={look.icon} color={look.color} size={20} tooltip={false} label={r.label} />
        <Typography variant="body2" sx={{ fontWeight: 700 }}>{what}</Typography>
      </Box>
    );
  }
  return (
    <Box key={f.seq} role="status" aria-label={text} data-testid="trigger-flash"
      sx={{ position: 'absolute', inset: 0, zIndex: 2, pointerEvents: 'none', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 0.5,
        bgcolor: (th) => (th.palette.mode === 'dark' ? 'rgba(0,0,0,.82)' : 'rgba(255,255,255,.88)'), animation: `${fade} ${FLASH_MS}ms ease-out forwards` }}>
      <PropIcon icon={look.icon} color={look.color} size={64} tooltip={false} label={r.label} />
      <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>{what}</Typography>
    </Box>
  );
}
