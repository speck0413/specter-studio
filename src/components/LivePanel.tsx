// A board's inputs and outputs, live. Buttons are momentary: held = on/closed, let go = off/open; they let go
// on pointer up, cancel, leaving the button, the window losing focus and the board going offline.
import { useEffect, useReducer, useRef, useState } from 'react';
import { Alert, Box, Button, Card, CardContent, Chip, Link, MenuItem, Slider, Stack, TextField, Typography } from '@mui/material';
import { isHeld, onHeldChanged, settling } from '../held';
import { call, rpc } from '../api';
import { Board, useStore } from '../store';
import { inputStatus, levelText, driverText, statusText, NOT_SEEN_PRESSED, TEST_PRESS_SHOWN_ONLY } from '../words';
import { useGuides } from './WiringGuide';
import { clampSound, hasSound, SOUND_MAX, soundChoices, soundNow, soundRequest } from '../sound';

function HoldButton({ label, onDown, onUp, disabled }: { label: string; onDown: () => Promise<unknown> | void; onUp: () => Promise<unknown> | void; disabled?: boolean }) {
  const held = useRef(false);
  const pressing = useRef<Promise<unknown>>(Promise.resolve());
  const onUpRef = useRef(onUp);
  onUpRef.current = onUp;
  // the release always follows the press's own request, so it can never overtake it
  const upRef = useRef(() => { if (held.current) { held.current = false; void pressing.current.finally(() => onUpRef.current()); } });
  const up = upRef.current;
  const down = () => { held.current = true; pressing.current = Promise.resolve(onDown()).catch(() => {}); };
  useEffect(() => {
    const u = upRef.current;
    window.addEventListener('blur', u);
    document.addEventListener('visibilitychange', u);
    return () => { window.removeEventListener('blur', u); document.removeEventListener('visibilitychange', u); u(); };
  }, []);
  useEffect(() => { if (disabled) up(); }, [disabled, up]);
  return (
    <Button variant="outlined" disabled={disabled} sx={{ touchAction: 'none', userSelect: 'none', whiteSpace: 'nowrap' }}
      onPointerDown={(e) => { if (e.button !== 0) return; (e.target as Element).setPointerCapture?.(e.pointerId); if (!held.current) down(); }}
      onPointerUp={up} onPointerCancel={up} onLostPointerCapture={up} onBlur={up} onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => { if ((e.key === ' ' || e.key === 'Enter') && !held.current) { e.preventDefault(); down(); } }}
      onKeyUp={(e) => { if (e.key === ' ' || e.key === 'Enter') up(); }}>
      {label}
    </Button>
  );
}

// The sound player (SOUND terminal): pick a sound, play it once or on repeat, stop, and the volume for now. Play
// once ends by itself; a repeat this tile started stops when the tile goes away (leaving the board page) or the
// window loses focus, like the other tests: nothing keeps playing that nobody is looking at.
function SoundTile({ b, tile, heading }: { b: Board; tile: object; heading: object }) {
  const { change, prefs, libraryVersion } = useStore();
  // the card list (the library's sounds.csv, kept by the SD card tool): a description for each number
  const [cardList, setCardList] = useState<Record<string, number>>({});
  useEffect(() => { if (prefs.workspace) call('sounds', { folder: prefs.workspace }).then(setCardList).catch(() => setCardList({})); }, [prefs.workspace, libraryVersion]);
  const choices = soundChoices(cardList);
  const [pick, setPick] = useState<number | ''>('');
  const [number, setNumber] = useState(1);
  const [volume, setVolume] = useState<number | null>(null);
  const [range, setRange] = useState({ min: 0, max: 30 });
  const [msg, setMsg] = useState<{ tone: 'error'; text: string } | null>(null);
  const repeating = useRef(false);
  const now = soundNow(b.state, cardList);
  const chosen = choices.find((c) => c.n === pick) || (choices.length && pick === '' ? choices[0] : undefined);
  const n = chosen ? chosen.n : number;
  // where the slider starts: the board's saved trigger sound volume (Settings, Sound), and its range
  useEffect(() => {
    void rpc(b.key, { op: 'get_params' }).then((r: any) => {
      if (!r?.ok) return;
      const v = (r.result.values || []).find((x: any) => x.key === 'trigger_volume')?.value;
      const p = (r.result.params || []).find((x: any) => x.key === 'trigger_volume');
      if (p && Number.isFinite(p.min) && Number.isFinite(p.max)) setRange({ min: p.min, max: p.max });
      if (typeof v === 'number') setVolume((now) => (now === null ? v : now));
    }).catch(() => {});
  }, [b.key]);
  const send = async (req: Record<string, unknown>) => {
    setMsg(null);
    const r = await change(b.key, req).catch((e: any) => ({ ok: false, error: { message: String(e.message || e) } }));
    if (!r?.ok) setMsg({ tone: 'error', text: r?.error?.message || 'The board did not take it.' });
    return !!r?.ok;
  };
  const stopRef = useRef(() => {});
  stopRef.current = () => { if (repeating.current) { repeating.current = false; void rpc(b.key, soundRequest.stop()).catch(() => {}); } };
  useEffect(() => {
    const u = () => stopRef.current();
    window.addEventListener('blur', u);
    return () => { window.removeEventListener('blur', u); u(); };
  }, []);
  // the repeat ended some other way (Stop on the board, another sound): nothing of ours to stop any more
  useEffect(() => { if (!now.playing) repeating.current = false; }, [now.playing]);
  const off = !b.online;
  return (
    <Card variant="outlined" data-testid="sound-tile" sx={{ borderLeft: 3, borderLeftColor: now.playing ? 'output.on' : 'output.off' }}>
      <CardContent sx={tile}>
        <Typography sx={{ ...heading, overflowWrap: 'anywhere' }}>Sound</Typography>
        <Typography variant="body2" color={now.online ? 'text.primary' : 'error'} data-testid="sound-now" role="status" aria-live="polite">{now.text}</Typography>
        <Stack spacing={1.5} sx={{ mt: 1.5 }}>
          {choices.length > 0 ? (
            <TextField select size="small" label="Sound" value={chosen ? chosen.n : ''} onChange={(e) => setPick(Number(e.target.value))}
              helperText="The sounds on the card, from the SD card tool's list.">
              {choices.map((c) => <MenuItem key={c.n} value={c.n}>{c.n} · {c.name}</MenuItem>)}
            </TextField>
          ) : (
            <TextField size="small" type="number" label="Sound" value={number} onChange={(e) => setNumber(clampSound(Number(e.target.value)))}
              slotProps={{ htmlInput: { min: 1, max: SOUND_MAX, 'aria-label': 'Sound number' } }} sx={{ width: 140 }} />
          )}
          {choices.length === 0 && <Typography variant="body2" color="text.secondary">Sound 1 is the one file in the card's folder 01 (01/001-….mp3), the same sound 1 as “play sound 1” in an effect. The SD card tool puts your sounds there.</Typography>}
          <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
            <Button variant="outlined" disabled={off} onClick={async () => { repeating.current = false; await send(soundRequest.once(n)); }}>Play once</Button>
            <Button variant="outlined" disabled={off} onClick={async () => { if (await send(soundRequest.repeat(n))) repeating.current = true; }}
              title="Plays this sound again and again until you press Stop sound">Play on repeat</Button>
            <Button variant="outlined" color="error" disabled={off} onClick={async () => { repeating.current = false; await send(soundRequest.stop()); }}>Stop sound</Button>
          </Stack>
          <Box>
            <Typography variant="body2" id={`sound-volume-${b.key}`}>Volume{volume !== null ? `: ${volume}` : ''}</Typography>
            <Slider size="small" min={range.min} max={range.max} step={1} value={volume ?? Math.min(range.max, 20)} disabled={off}
              aria-labelledby={`sound-volume-${b.key}`} valueLabelDisplay="auto"
              onChange={(_, v) => setVolume(v as number)} onChangeCommitted={(_, v) => void send(soundRequest.volume(v as number))} />
            <Typography variant="body2" color="text.secondary" data-testid="sound-volume-help">
              This changes the volume for now only; nothing is saved. When the board plays its background loop or trigger sound by itself, it uses their saved volumes (Settings, Sound).
            </Typography>
          </Box>
          {msg && <Alert severity={msg.tone} onClose={() => setMsg(null)}>{msg.text}</Alert>}
        </Stack>
      </CardContent>
    </Card>
  );
}

const alias = (t: any) => (t.alias ? `${t.alias} (${t.channel || t.input})` : t.channel || t.input);

export default function LivePanel({ b, onWiring: wiringIn, dense = false }: { b: Board; onWiring?: (terminal: string) => void; dense?: boolean }) {
  const { change, testOutput, pinFor } = useStore();
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  useEffect(() => onHeldChanged(rerender), []);
  const guides = useGuides();
  const onWiring = guides?.available ? wiringIn : undefined;
  const caps: string[] = b.info?.capabilities || [];
  // a practice board's inputs are pressed as by a wire (sim_input); a board that takes test presses (also a
  // simulator added by its address) gets Hold to test instead
  const sim = b.sim || (caps.includes('sim') && !caps.includes('test_input'));
  const canDrive = caps.includes('outputs');
  // a real board that takes test presses on its inputs (firmware op test_input): Hold to test, like an output
  const canPress = !sim && caps.includes('test_input');
  // the let-go never asks for the page password (the board takes it without one); the press may
  const letGo = async (input: string) => { const pin = await pinFor(b.key); return rpc(b.key, { op: 'test_input', input, active: false, ...(pin ? { pin } : {}) }).catch(() => null); };
  const st = b.state;
  const labels: Record<string, string> = {};
  const roles: Record<string, string> = {};
  for (const t of b.info?.terminals || []) { if (t.label) labels[t.id] = t.label; if (t.role) roles[t.id] = t.role; }
  if (!st) return <Typography>Waiting for the board…</Typography>;
  const grid = { display: 'grid', gridTemplateColumns: (t: any) => `repeat(auto-fill, minmax(${t.spacing(dense ? 36 : 44)}, 1fr))`, gap: 2 } as const;
  const tile = { p: 2, '&:last-child': { pb: 2 } } as const;
  const heading = { fontWeight: 600 } as const;
  // an output still on from a test nobody holds any more (a let-go lost with the connection, another app's test)
  const leftOn = canDrive ? (st.outputs || []).filter((o: any) => o.manual && o.level > 0 && !isHeld(b.key, o.channel) && !settling(b.key, o.channel)) : [];
  return (
    <Stack spacing={1.5}>
      {leftOn.length > 0 && b.online && (
        <Alert severity="warning" data-testid="left-on"
          action={<Button color="inherit" onClick={() => { for (const o of leftOn) void change(b.key, { op: 'set_output', channel: o.channel, level: null }); }}>Release</Button>}>
          {leftOn.map((o: any) => o.channel).join(', ')} {leftOn.length === 1 ? 'is' : 'are'} still on from a test.
        </Alert>
      )}
      <Typography variant="subtitle1" component="h3" sx={heading}>Inputs</Typography>
      <Box sx={grid}>
        {st.inputs?.map((i: any) => (
          <Card key={i.input} variant="outlined" data-testid={`input-${i.input}`}>
            <CardContent sx={tile}>
              <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between">
                <Typography sx={{ fontWeight: 700, minWidth: 0, overflowWrap: 'anywhere' }}>{alias(i)}</Typography>
                <Chip size="small" color={i.raw || i.active || i.test ? 'warning' : 'default'} label={i.raw || i.active || i.test ? 'pressed' : 'open'} />
              </Stack>
              {labels[i.input] && <Typography variant="body2" color="text.secondary">{labels[i.input]}</Typography>}
              {i.waiting && <Typography variant="body2">let go first</Typography>}
              {i.test && i.test_starts === false && <Typography variant="body2" color="warning.main" data-testid="test-press-shown-only">{TEST_PRESS_SHOWN_ONLY}</Typography>}
              <Typography variant="body2" color="text.secondary" data-testid="input-status">{inputStatus(i, roles[i.input], !!st.paused)}</Typography>
              {inputStatus(i, roles[i.input], !!st.paused) === 'Ready' && !b.pressed?.[i.input] && !sim
                && <Typography variant="body2" color="text.secondary" data-testid="input-not-seen">{NOT_SEEN_PRESSED}</Typography>}
              <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" alignItems="center" sx={{ mt: 1 }}>
                {sim && <HoldButton label="Press" disabled={!b.online}
                  onDown={() => rpc(b.key, { op: 'sim_input', input: i.input, active: true })}
                  onUp={() => rpc(b.key, { op: 'sim_input', input: i.input, active: false })} />}
                {canPress && <HoldButton label="Hold to test" disabled={!b.online}
                  onDown={() => change(b.key, { op: 'test_input', input: i.input, active: true })}
                  onUp={() => letGo(i.input)} />}
                {onWiring && <Link component="button" variant="body2" onClick={() => onWiring(i.input)}>How do I wire this?</Link>}
              </Stack>
            </CardContent>
          </Card>
        ))}
      </Box>
      <Typography variant="subtitle1" component="h3" sx={heading}>Outputs</Typography>
      <Box sx={grid}>
        {st.outputs?.map((o: any) => (
          <Card key={o.channel} variant="outlined" data-testid={`output-${o.channel}`} sx={{ borderLeft: 3, borderLeftColor: o.level > 0 ? 'output.on' : 'output.off' }}>
            <CardContent sx={tile}>
              <Typography sx={{ fontWeight: 700, overflowWrap: 'anywhere' }}>{alias(o)}</Typography>
              {labels[o.channel] && <Typography variant="body2" color="text.secondary">{labels[o.channel]}</Typography>}
              <Box sx={{ my: 0.75, height: 6, borderRadius: 3, bgcolor: 'action.hover', overflow: 'hidden' }} aria-hidden>
                <Box sx={{ width: `${o.level / 10}%`, height: '100%', bgcolor: 'output.on' }} />
              </Box>
              <Typography variant="body2" data-testid="level">{levelText(o.channel, o.level)}{o.driver ? ` · ${driverText(o.driver)}` : ''}{o.fault ? ` · problem: ${o.fault}` : ''}</Typography>
              <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" alignItems="center" sx={{ mt: 1 }}>
                {canDrive && <HoldButton label="Hold to test" disabled={!b.online}
                  onDown={() => testOutput(b.key, o.channel, true)}
                  onUp={() => testOutput(b.key, o.channel, false)} />}
                {onWiring && <Link component="button" variant="body2" onClick={() => onWiring(o.channel)}>How do I wire this?</Link>}
              </Stack>
            </CardContent>
          </Card>
        ))}
      </Box>
      {hasSound(b) && <SoundTile b={b} tile={tile} heading={heading} />}
      {st.script?.effects?.length > 0 && (
        <Box>
          <Typography variant="subtitle1" component="h3" sx={heading}>Effects running</Typography>
          {st.script.effects.map((e: any) => <Typography key={e.name}>{e.name}: {e.running ? `running (line ${e.line})` : 'waiting for its trigger'}</Typography>)}
        </Box>
      )}
      {st.script?.error && <Typography color="error">The stored effect script has a problem: {st.script.error}</Typography>}
      {st.status?.length > 0 && <Box><Typography variant="subtitle1" component="h3" sx={heading}>Status</Typography>{st.status.map((s: any) => <Typography key={s.key}>{statusText(s).join(': ')}</Typography>)}</Box>}
    </Stack>
  );
}
