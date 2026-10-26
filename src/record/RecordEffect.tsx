// "Record effect": pick what starts it and the outputs to use, press Start, then tap or hold the outputs and
// slide the dimmable ones (OUT1-OUT4). The real board does each one as you do it; Stop and the board does the whole thing back once; keep it and it becomes an
// effect script in your library, sent to the board, which then does it every time the input is pressed.
// Safety: every output this page turned on is let go on Stop, when the page closes, when the board drops off or
// is stopped, and held ones when the window loses focus; a hold never lasts longer than the board's maximum
// on-time for that output (the board enforces it too). Cancel (or Escape) at any step stops, lets go of every
// output it touched, asks "Discard this recording?" only when something was recorded, and closes the recorder. docs/DESIGN.md "Record effect". The take becomes a script
// with the firmware's shared take.js (./take.ts), the same module the board's phone page records with.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Box, Button, Checkbox, Dialog, DialogActions, DialogContent, DialogContentText, DialogTitle, FormControlLabel, FormGroup, MenuItem, Slider, Stack, TextField, Typography } from '@mui/material';
import { call, rpc } from '../api';
import { soundList as soundListOf } from '../effects/terms';
import { Board, useStore } from '../store';
import { dimmable, Hold, mergeTakes, named, plan, Plan, SoundTap, suggestName, Take, takeToScript, TimelineEntry } from './take';

type Phase = 'setup' | 'count' | 'rec' | 'play' | 'review';
interface Held { start: number; cutAt?: number; timer?: number }

const TRIGGERS = ['TRIG1', 'TRIG2', 'USER1', 'USER2', 'USER3'];
const SOUND_KEYS = ['q', 'w', 'e', 'r'];
const isTyping = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.getAttribute('role') === 'combobox' || t.getAttribute('role') === 'option');

export interface Recorded { name: string; text: string; trigger: string; outputs: string[] }

export default function RecordEffect({ b, onSave, onClose }: { b: Board; onSave: (t: Recorded) => Promise<void>; onClose: () => void }) {
  const { change, testOutput, prefs, libraryVersion } = useStore();
  const terminals: any[] = b.info?.terminals || [];
  const term = (id: string) => terminals.find((t) => String(t.id).toUpperCase() === id);
  const labels = useMemo(() => {
    const l: Record<string, string> = {};
    for (const t of terminals) if (t.label && t.kind !== 'sound' && t.kind !== 'pixel') l[String(t.id).toLowerCase()] = t.alias || t.label;
    return l;
  }, [terminals]);
  const caps: string[] = b.info?.capabilities || [];
  const canDrive = caps.includes('outputs');
  // outputs a script may use: the role is "shows" and the pulse-and-recover effect does not own it
  const offered: string[] = (b.info?.channels || (b.state?.outputs || []).map((o: any) => o.channel)).map((c: string) => c.toLowerCase())
    .filter((c: string) => term(c.toUpperCase())?.shows !== false);
  // the outputs this effect drives (ticked before Start): their buttons and keys 1-9, in board order
  const [use, setUse] = useState<string[] | null>(null);
  const outputs = use ? offered.filter((o) => use.includes(o)) : offered;
  const inputs = (b.info?.inputs || TRIGGERS).filter((i: string) => TRIGGERS.includes(i.toUpperCase()));
  const inputOk = (i: string) => term(i)?.shows !== false;
  const inputWhy = (i: string) => {
    const t = term(i);
    if (!t || t.shows !== false) return '';
    if (/^USER/.test(i)) return 'this firmware needs “Buttons” set to triggers in Settings (update it: newer firmware always lets USER buttons trigger)';
    if (t.role === 'pause') return 'it is set to pause the board (Settings)';
    return `it is used by ${t.role || 'something else'}`;
  };

  // an input that reads pressed (or must be let go first) right now: unwired inputs can float like that, and an
  // effect waiting for it would not start until it is let go
  const heldNow = (i: string) => (b.state?.inputs || []).some((x: any) => String(x.input).toUpperCase() === i.toUpperCase() && (x.active || x.waiting));
  const [phase, setPhase] = useState<Phase>('setup');
  const [trigger, setTrigger] = useState(() => (inputs.find((i: string) => inputOk(i) && !heldNow(i)) || inputs.find(inputOk) || 'TRIG1').toLowerCase());
  const [countIn, setCountIn] = useState(true);
  const [count, setCount] = useState(0);
  const [trimLead, setTrimLead] = useState(true);
  const [base, setBase] = useState<Take>({ holds: [], sounds: [], levels: [] }); // earlier passes
  const [pass, setPassState] = useState<Take>({ holds: [], sounds: [], levels: [] }); // this pass
  const [slider, setSliderState] = useState<Record<string, number>>({}); // dimmable outputs: the level slider (percent)
  const sliderRef = useRef(slider);
  const passRef = useRef(pass);
  const setPass = (t: Take) => { passRef.current = t; setPassState(t); };
  const onlineRef = useRef(b.online); onlineRef.current = b.online;
  const paused = !!b.state?.paused;
  const pausedRef = useRef(paused); pausedRef.current = paused;
  const [held, setHeld] = useState<Record<string, Held>>({});
  const [playing, setPlaying] = useState<{ plan: Plan; timeline: TimelineEntry[] } | null>(null); // what plays now (the take back, or earlier passes under a new one)
  const [now, setNow] = useState(0); // ms since the clock started, for the timeline
  const [maxOn, setMaxOn] = useState<Record<string, number>>({});
  const [sounds, setSounds] = useState<Record<string, number>>({});
  const [name, setName] = useState('');
  const [problem, setProblem] = useState('');
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);
  const [asking, setAsking] = useState(false); // "Discard this recording?" is open
  const keepRef = useRef<HTMLButtonElement>(null);

  const heldRef = useRef(held); heldRef.current = held;
  const phaseRef = useRef(phase); phaseRef.current = phase;
  const t0 = useRef(0);
  const queue = useRef<Record<string, Promise<unknown>>>({});
  const touched = useRef(new Set<string>());
  const timers = useRef<number[]>([]);
  const ticker = useRef<number | undefined>(undefined);
  const elapsed = () => performance.now() - t0.current;

  useEffect(() => {
    void rpc(b.key, { op: 'get_params' }).then((r: any) => {
      if (!r?.ok) return;
      const m: Record<string, number> = {};
      for (const x of r.result.values || []) { const k = /^([a-z]+\d)_max_on_ms$/.exec(x.key); if (k) m[k[1]] = Number(x.value) || 0; }
      setMaxOn(m);
    }).catch(() => {});
  }, [b.key]);
  useEffect(() => { if (prefs.workspace) call('sounds', { folder: prefs.workspace }).then(setSounds).catch(() => setSounds({})); }, [prefs.workspace, libraryVersion]);
  const hasSound = caps.includes('sound');
  const soundList: { n: number; label: string }[] = hasSound
    ? (Object.keys(sounds).length ? soundListOf(sounds).map((s) => ({ n: s.n, label: s.description ? `${s.n} · ${s.description}` : `Sound ${s.n}` })) : [1, 2, 3].map((n) => ({ n, label: `Sound ${n}` }))).slice(0, SOUND_KEYS.length)
    : [];

  // ---- the board: one request after another per output, so a quick tap's "off" never overtakes its "on"; while
  // one is on its way only the newest wanted level waits (a slider moved quickly sends what it ends on)
  const wanted = useRef<Record<string, number | undefined>>({});
  const send = useCallback((ch: string, level: number | boolean) => {
    const pct = typeof level === 'boolean' ? (level ? 100 : 0) : Math.max(0, Math.min(100, Math.round(level)));
    if (pct > 0) touched.current.add(ch);
    const queued = wanted.current[ch] !== undefined;
    wanted.current[ch] = pct;
    if (queued) return queue.current[ch] || Promise.resolve();
    const p = (queue.current[ch] || Promise.resolve()).catch(() => {}).then(() => {
      const l = wanted.current[ch] ?? 0;
      wanted.current[ch] = undefined;
      return testOutput(b.key, ch, l > 0, l * 10);
    });
    queue.current[ch] = p;
    return p;
  }, [b.key, testOutput]);
  const releaseAll = useCallback(() => {
    for (const ch of touched.current) void send(ch, 0);
    touched.current.clear();
  }, [send]);
  const setSlider = (x: Record<string, number>) => { sliderRef.current = x; setSliderState(x); };
  const stopTimers = () => { timers.current.forEach((t) => window.clearTimeout(t)); timers.current = []; };
  const startTicker = () => { window.clearInterval(ticker.current); ticker.current = window.setInterval(() => setNow(elapsed()), 50); };
  const stopTicker = () => { window.clearInterval(ticker.current); ticker.current = undefined; };

  // ---- press and let go
  const press = (target: string) => {
    if (phaseRef.current !== 'rec' || heldRef.current[target] || pausedRef.current) return;
    const h: Held = { start: elapsed() };
    const max = maxOn[target] || 0;
    if (max > 0) h.timer = window.setTimeout(() => {
      // the board's maximum on-time: off now, even though the finger is still down
      const cur = heldRef.current[target];
      if (!cur || cur.cutAt !== undefined) return;
      void send(target, 0);
      setHeld((x) => ({ ...x, [target]: { ...cur, cutAt: cur.start + max } }));
    }, max);
    heldRef.current = { ...heldRef.current, [target]: h };
    setHeld(heldRef.current);
    void send(target, 100);
  };
  const letGo = useCallback((target: string, at = elapsed()) => {
    const h = heldRef.current[target];
    if (!h) return;
    window.clearTimeout(h.timer);
    const rest = { ...heldRef.current };
    delete rest[target];
    heldRef.current = rest;
    setHeld(rest);
    // back to the slider's level (off without one)
    if (h.cutAt === undefined) void send(target, sliderRef.current[target] || 0);
    const hold: Hold = { target, start: h.start, end: h.cutAt ?? at, cut: h.cutAt !== undefined, heldMs: at - h.start };
    setPass({ ...passRef.current, holds: [...passRef.current.holds, hold] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [send]);
  const letGoAll = useCallback(() => { for (const t of Object.keys(heldRef.current)) letGo(t); }, [letGo]);
  const slide = (target: string, level: number) => {
    if (phaseRef.current !== 'rec' || pausedRef.current || sliderRef.current[target] === level) return;
    setSlider({ ...sliderRef.current, [target]: level });
    setPass({ ...passRef.current, levels: [...(passRef.current.levels || []), { target, at: elapsed(), level }] });
    if (!heldRef.current[target]) void send(target, level);
  };
  const tapSound = (n: number) => {
    if (phaseRef.current !== 'rec' || pausedRef.current) return;
    setPass({ ...passRef.current, sounds: [...passRef.current.sounds, { sound: n, at: elapsed() }] });
    void change(b.key, { op: 'sound', cmd: 'play_folder', folder: n, track: 1 });
  };

  // ---- playing a take on the board: Studio drives the outputs along the timeline the script itself runs (its
  // levels and fades, from take.js), or, for a take too big for one board, along the plan's steps
  const playable = useCallback((take: Take, lead: boolean) => {
    const p = plan(take, { maxOnMs: maxOn, trimLead: lead });
    const r = takeToScript(take, { name: 'take', trigger, maxOnMs: maxOn, trimLead: lead });
    let timeline: TimelineEntry[] = r.error ? [] : r.timeline;
    if (r.error) {
      for (const [target, steps] of Object.entries(p.steps)) for (const st of steps) timeline.push({ at: st.t, target, level: st.level });
      for (const s of p.sounds) timeline.push({ at: s.at, sound: s.sound });
      timeline = timeline.sort((x, y) => x.at - y.at);
    }
    return { plan: p, timeline };
  }, [maxOn, trigger]);
  const play = useCallback((what: { plan: Plan; timeline: TimelineEntry[] }, then: () => void, offset = 0) => {
    stopTimers();
    setPlaying(what);
    const at = (ms: number, f: () => void) => timers.current.push(window.setTimeout(f, Math.max(0, ms - offset)));
    for (const e of what.timeline) {
      if (e.sound !== undefined) { const n = e.sound; at(e.at, () => void change(b.key, { op: 'sound', cmd: 'play_folder', folder: n, track: 1 })); }
      else { const { target, level } = e; at(e.at, () => { if (!heldRef.current[target]) void send(target, level); }); }
    }
    at(what.plan.lengthMs + 400, () => { setPlaying(null); then(); });
  }, [b.key, change, send]);

  const all = (t: Take, u: Take): Take => mergeTakes(t, u);
  const script = useMemo(() => takeToScript(all(base, pass), { name: name || suggestName(all(base, pass), labels), trigger, maxOnMs: maxOn, labels, trimLead, source: 'in Specter Studio' }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [base, pass, name, trigger, maxOn, labels, trimLead, sounds]);

  const playBack = useCallback((take: Take) => {
    if (pausedRef.current) return;
    setPhase('play');
    t0.current = performance.now();
    startTicker();
    play(playable(take, trimLead), () => { stopTicker(); releaseAll(); setPhase('review'); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trimLead, play, playable, releaseAll]);
  const hasAny = (t: Take) => t.holds.length > 0 || t.sounds.length > 0 || (t.levels || []).length > 0;

  // ---- start and stop
  const begin = () => {
    t0.current = performance.now();
    setNow(0);
    setPhase('rec');
    setSlider({});
    startTicker();
    // a second pass: the earlier ones play on the board while the new one is tapped on top
    if (hasAny(base)) play(playable(base, false), () => {});
  };
  const start = () => {
    if (pausedRef.current) return;
    setProblem(''); setNotice('');
    if (!countIn) return begin();
    setPhase('count');
    setCount(3);
    [2, 1].forEach((n, i) => timers.current.push(window.setTimeout(() => setCount(n), (i + 1) * 800)));
    timers.current.push(window.setTimeout(begin, 3 * 800));
  };
  const finish = useCallback(() => {
    if (phaseRef.current === 'count') { stopTimers(); setPhase(hasAny(base) ? 'review' : 'setup'); return; }
    if (phaseRef.current !== 'rec') return;
    const at = elapsed();
    for (const t of Object.keys(heldRef.current)) letGo(t, at);
    // a slider left up stays on until here
    if ((passRef.current.levels || []).length) setPass({ ...passRef.current, end: at });
    setSlider({});
    stopTimers();
    stopTicker();
    setPlaying(null);
    releaseAll();
    phaseRef.current = 'review';
    // the board says it back: the whole take, once, straight away
    const take = all(base, passRef.current);
    const any = hasAny(take);
    if (any && onlineRef.current) timers.current.push(window.setTimeout(() => playBack(take), 250));
    else setPhase(any ? 'review' : 'setup');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, letGo, releaseAll, playBack]);
  const stopPlaying = () => { stopTimers(); stopTicker(); setPlaying(null); releaseAll(); setPhase('review'); };
  const haltRef = useRef(() => {});
  haltRef.current = () => {
    const ph = phaseRef.current;
    letGoAll();
    if (ph !== 'count' && ph !== 'rec' && ph !== 'play') return;
    stopTimers(); stopTicker(); setPlaying(null); releaseAll();
    if (ph === 'rec' && (passRef.current.levels || []).length) setPass({ ...passRef.current, end: elapsed() });
    setSlider({});
    const t = all(base, passRef.current);
    phaseRef.current = hasAny(t) ? 'review' : 'setup';
    setPhase(phaseRef.current);
    setNotice('Studio stopped and turned everything off because its window lost focus. What you tapped so far is kept.');
  };
  // ---- Cancel (and Escape), at every step: everything stops and every output this recorder touched is let go at
  // once (set_output level null: back to what it did before, off or the level its show gives it), which also ends
  // Studio's test hold on it. A take is kept for a moment and the person asked; with nothing recorded it just closes.
  const cancelRef = useRef(() => {});
  cancelRef.current = () => {
    if (saving) return;
    const ph = phaseRef.current;
    letGoAll();
    stopTimers(); stopTicker(); setPlaying(null);
    if (ph === 'rec' && (passRef.current.levels || []).length) setPass({ ...passRef.current, end: elapsed() });
    setSlider({});
    releaseAll();
    setNotice(''); setProblem('');
    if (!hasAny(all(base, passRef.current))) { onClose(); return; }
    phaseRef.current = 'review';
    setPhase('review');
    setAsking(true);
  };
  const discard = () => { setAsking(false); stopTimers(); releaseAll(); onClose(); };
  const goBack = () => { setAsking(false); window.setTimeout(() => keepRef.current?.focus(), 0); };
  useEffect(() => {
    // bubble phase: an Escape that a menu or a dialog uses (the "What starts it" list, this question) never gets here
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return;
      e.preventDefault();
      cancelRef.current();
    };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, []);
  const empty = (): Take => ({ holds: [], sounds: [], levels: [] });
  const again = () => { stopTimers(); releaseAll(); setBase(empty()); setPass(empty()); setName(''); setPhase('setup'); };
  const more = () => { setBase((x) => all(x, passRef.current)); setPass(empty()); setPhase('setup'); };

  const save = async () => {
    const r = script;
    if (r.error) return setProblem(r.error);
    setSaving(true);
    try {
      const chk = await rpc(b.key, { op: 'check_script', text: r.text, ...(Object.keys(sounds).length ? { sounds } : {}) });
      if (chk?.ok && chk.result && chk.result.ok === false) { setProblem(`The board says: ${chk.result.errors?.[0]?.message || 'it has a problem'}`); return; }
      await onSave({ name: (name || suggestName(all(base, pass), labels)).trim(), text: r.text, trigger, outputs: [...new Set(r.segments.map((x) => x.target))] });
    } finally { setSaving(false); }
  };

  // ---- safety: leaving the page, the window losing focus, the board dropping off or being stopped
  useEffect(() => {
    // focus gone (another window, a hidden tab: timers may then run late): everything off, the take ends here
    const blur = () => haltRef.current();
    const vis = () => { if (document.visibilityState === 'hidden') haltRef.current(); };
    const hide = () => { stopTimers(); letGoAll(); releaseAll(); };
    window.addEventListener('blur', blur);
    document.addEventListener('visibilitychange', vis);
    window.addEventListener('pagehide', hide);
    return () => { window.removeEventListener('blur', blur); document.removeEventListener('visibilitychange', vis); window.removeEventListener('pagehide', hide); };
  }, [letGoAll, releaseAll]);
  useEffect(() => () => {
    stopTimers(); stopTicker();
    for (const h of Object.values(heldRef.current)) window.clearTimeout(h.timer);
    releaseAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const wasOnline = useRef(b.online);
  useEffect(() => {
    if (!b.online && wasOnline.current) {
      // gone: end the take where it is; what it held is let go again when the board is back
      const lost = new Set(touched.current);
      if (phaseRef.current === 'rec') finish(); else if (phaseRef.current === 'play' || phaseRef.current === 'count') stopPlaying();
      touched.current = lost;
      setProblem(`${b.info?.name || 'The board'} stopped answering. Everything it had on from here is turned off as soon as it is back.`);
    }
    if (b.online && !wasOnline.current) releaseAll();
    wasOnline.current = b.online;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [b.online]);
  useEffect(() => {
    if (b.state?.paused && phaseRef.current !== 'setup' && phaseRef.current !== 'review') {
      stopTimers(); stopTicker(); setPlaying(null);
      if (phaseRef.current === 'rec') { for (const t of Object.keys(heldRef.current)) letGo(t); }
      releaseAll();
      setSlider({});
      setPhase(hasAny(base) || hasAny(pass) ? 'review' : 'setup');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [b.state?.paused]);

  // ---- keyboard: Space starts and stops, 1-8 are the outputs, Q W E R the sounds
  const spaceDown = useRef(false);
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === ' ') {
        // a focused control (the board's Stop, a Hold to test, Keep it…) keeps its own Space
        const el = e.target instanceof HTMLElement ? e.target : null;
        if (el && !el.closest('[data-rec-main]') && el.closest('button, a, summary, [role="button"], [role="tab"], [role="checkbox"], [role="switch"], [role="menuitem"]')) return;
        spaceDown.current = true;
        e.preventDefault();
        if (e.repeat) return;
        const ph = phaseRef.current;
        if (ph === 'setup') start(); else if (ph === 'rec' || ph === 'count') finish(); else if (ph === 'play') stopPlaying();
        return;
      }
      if (e.repeat) return;
      const n = Number(e.key);
      if (n >= 1 && n <= outputs.length) { e.preventDefault(); press(outputs[n - 1]); return; }
      const s = SOUND_KEYS.indexOf(e.key.toLowerCase());
      if (s >= 0 && soundList[s]) { e.preventDefault(); tapSound(soundList[s].n); }
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === ' ' && spaceDown.current) { spaceDown.current = false; e.preventDefault(); } // the Start button must not also "click"
      const n = Number(e.key);
      if (n >= 1 && n <= outputs.length) letGo(outputs[n - 1]);
    };
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up, true);
    return () => { window.removeEventListener('keydown', down, true); window.removeEventListener('keyup', up, true); };
  });

  if (!canDrive) return <Alert severity="warning" action={<Button onClick={onClose}>Close</Button>}>This board's outputs cannot be switched from Studio, so it cannot record an effect. Use the form instead.</Alert>;

  // ---- what is on now, from what is tapped or playing (instant) and from the board (its own state)
  const boardLevel = (ch: string) => (b.state?.outputs || []).find((o: any) => String(o.channel).toLowerCase() === ch)?.level ?? 0;
  const playingLevel = (ch: string) => {
    let l = 0;
    for (const e of playing?.timeline || []) { if (e.at > now) break; if (e.target === ch) l = e.level; }
    return l;
  };
  const isOn = (ch: string) => (held[ch] && held[ch].cutAt === undefined) || (slider[ch] || 0) > 0 || playingLevel(ch) > 0;
  const total = all(base, pass);
  const recording = phase === 'rec' || phase === 'count';
  const shown: Plan = phase === 'play' && playing ? playing.plan
    : recording ? plan(base, { maxOnMs: maxOn, trimLead: false })
    : plan(total, { maxOnMs: maxOn, trimLead: phase === 'review' ? trimLead : false });
  const liveBars = phase === 'rec' ? Object.entries(held).map(([t, h]) => ({ target: t, start: h.start, end: h.cutAt ?? now, cut: h.cutAt !== undefined })) : [];
  const rows: string[] = offered.filter((o: string) => shown.segments.some((s) => s.target === o) || liveBars.some((x) => x.target === o) || (recording && pass.holds.some((h) => h.target === o)));
  const span = Math.max(4000, shown.lengthMs + 500, phase === 'rec' ? now + 1000 : 0);
  const pct = (ms: number) => `${(100 * ms) / span}%`;
  const words = (n: number) => `${(n / 1000).toFixed(1)} s`;

  return (
    <Box component="section" aria-label="Record effect" data-testid="record-effect" sx={{ border: 2, borderColor: recording ? 'error.main' : 'primary.main', borderRadius: 3, p: { xs: 1.5, sm: 2 } }}>
      <Stack spacing={2}>
        <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap" useFlexGap>
          <Typography variant="h6" component="h3" sx={{ flexGrow: 1 }}>Record effect</Typography>
          <Button variant="outlined" onClick={() => cancelRef.current()} disabled={saving} aria-keyshortcuts="Escape" data-testid="record-cancel">Cancel</Button>
        </Stack>
        <Typography color="text.secondary">
          {phase === 'setup' && (hasAny(base)
            ? 'Press Start: what you did before plays on the board, and you add more on top.'
            : 'Pick what starts it and the outputs to use, press Start, then tap or hold the buttons and slide the levels. The board does each one as you do it. Press Stop when you are done and the board does it all back.')}
          {phase === 'count' && 'Get ready…'}
          {phase === 'rec' && 'Tap or hold the buttons, slide the levels. Press Stop (or Space) when you are done.'}
          {phase === 'play' && 'The board is doing it back…'}
          {phase === 'review' && `That is what ${b.info?.name || 'the board'} will do when ${trigger.toUpperCase()} is pressed. Keep it, try again, or add more on top.`}
        </Typography>

        {phase === 'setup' && (
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems={{ sm: 'center' }}>
            <TextField select label="What starts it" value={trigger} onChange={(e) => setTrigger(e.target.value)} sx={{ minWidth: 260 }}
              disabled={hasAny(base)}>
              {inputs.map((i: string) => (
                <MenuItem key={i} value={i.toLowerCase()} disabled={!inputOk(i)}>
                  {labels[i.toLowerCase()] ? `${labels[i.toLowerCase()]} (${i})` : i}{inputWhy(i) ? ` — ${inputWhy(i)}` : inputOk(i) && heldNow(i) ? ' — reads pressed right now' : ''}
                </MenuItem>))}
              <MenuItem value="boot" disabled>When the board starts — not in Record effect yet: write it in the script (lines above the first “wait for”)</MenuItem>
            </TextField>
            <FormControlLabel control={<Checkbox checked={countIn} onChange={(e) => setCountIn(e.target.checked)} />} label="Count 3, 2, 1 first" />
          </Stack>
        )}
        {phase === 'setup' && heldNow(trigger) && (
          <Alert severity="warning" data-testid="record-trigger-held">
            {trigger.toUpperCase()} reads “pressed” right now. If nothing is wired to it, it can float like this, and the effect would not start until it reads “let go”. Pick another input, or wire a button or sensor to it first.
          </Alert>
        )}
        {phase === 'setup' && offered.length > 0 && (
          <Box component="fieldset" sx={{ border: 0, p: 0, m: 0 }}>
            <Typography component="legend" variant="subtitle2">Outputs to use</Typography>
            <FormGroup row data-testid="record-outputs">
              {offered.map((o) => (
                <FormControlLabel key={o} label={`${named(o, labels)}${dimmable(o) ? ' · dims' : ''}`}
                  control={<Checkbox checked={outputs.includes(o)} onChange={(e) => setUse(e.target.checked ? offered.filter((x) => x === o || outputs.includes(x)) : outputs.filter((x) => x !== o))} />} />
              ))}
            </FormGroup>
          </Box>
        )}

        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
          {phase === 'setup' && <Button variant="contained" color="error" size="large" onClick={start} disabled={paused || !b.online || (!outputs.length && !soundList.length)} sx={{ minWidth: 160, minHeight: 56, fontSize: '1.2rem' }} aria-keyshortcuts="Space" data-rec-main>Start</Button>}
          {recording && <Button variant="contained" color="error" size="large" onClick={finish} sx={{ minWidth: 160, minHeight: 56, fontSize: '1.2rem' }} aria-keyshortcuts="Space" data-rec-main>Stop</Button>}
          {phase === 'play' && <Button variant="outlined" size="large" onClick={stopPlaying} sx={{ minHeight: 56 }}>Stop playing</Button>}
          {phase === 'count' && <Typography aria-live="assertive" sx={{ fontSize: '2.5rem', fontWeight: 800, px: 2 }} data-testid="count-in">{count}</Typography>}
          {phase === 'rec' && <Typography aria-live="off" sx={{ fontVariantNumeric: 'tabular-nums', fontSize: '1.3rem', fontWeight: 700 }} data-testid="rec-clock">● {words(now)}</Typography>}
          {(phase === 'setup' || recording) && <Typography variant="body2" color="text.secondary">Keys: Space starts and stops, Esc cancels{outputs.length ? `, 1-${Math.min(outputs.length, 9)} the outputs` : ''}{soundList.length ? `, ${SOUND_KEYS.slice(0, soundList.length).join(' ').toUpperCase()} the sounds` : ''}.</Typography>}
        </Stack>

        {phase !== 'review' && (
          <Box role="group" aria-label="Outputs" sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 1 }}>
            {outputs.map((ch: string, i: number) => {
              const on = isOn(ch);
              const lvl = boardLevel(ch);
              const cut = held[ch]?.cutAt !== undefined;
              const hold = (
                <Button key={ch} data-rec-main data-testid={`tap-${ch.toUpperCase()}`} variant={on ? 'contained' : 'outlined'} color={cut ? 'warning' : 'primary'}
                  disabled={phase !== 'rec' || !b.online || paused} aria-pressed={on} aria-keyshortcuts={i < 9 ? String(i + 1) : undefined}
                  sx={{ minHeight: 88, flexDirection: 'column', touchAction: 'none', userSelect: 'none', textTransform: 'none', fontSize: '1.05rem', lineHeight: 1.2 }}
                  onPointerDown={(e) => { if (e.button !== 0) return; (e.currentTarget as Element).setPointerCapture?.(e.pointerId); press(ch); }}
                  onPointerUp={() => letGo(ch)} onPointerCancel={() => letGo(ch)} onLostPointerCapture={() => letGo(ch)} onContextMenu={(e) => e.preventDefault()}>
                  <span style={{ fontWeight: 700 }}>{named(ch, labels)}</span>
                  <span style={{ fontSize: '0.8rem', opacity: 0.85 }} data-testid="board-says">
                    {cut ? 'off: max on-time' : `board: ${lvl <= 0 ? 'off' : dimmable(ch) && lvl < 1000 ? `${Math.round(lvl / 10)} %` : 'on'}`}{i < 9 ? ` · key ${i + 1}` : ''}
                  </span>
                </Button>
              );
              if (!dimmable(ch)) return hold;
              return (
                <Stack key={ch} spacing={0.5}>
                  {hold}
                  <Box sx={{ px: 1.5 }}>
                    <Slider size="small" value={slider[ch] || 0} min={0} max={100} step={5} disabled={phase !== 'rec' || !b.online || paused}
                      onChange={(_, v) => slide(ch, v as number)} valueLabelDisplay="auto" valueLabelFormat={(v) => `${v} %`}
                      aria-label={`${named(ch, labels)} level`} data-testid={`level-${ch.toUpperCase()}`} />
                  </Box>
                </Stack>
              );
            })}
            {soundList.map((s, i) => (
              <Button key={`s${s.n}`} data-rec-main data-testid={`tap-sound-${s.n}`} variant="outlined" color="secondary" disabled={phase !== 'rec' || !b.online || paused}
                aria-keyshortcuts={SOUND_KEYS[i].toUpperCase()} onClick={() => tapSound(s.n)}
                sx={{ minHeight: 88, flexDirection: 'column', textTransform: 'none', fontSize: '1.05rem', lineHeight: 1.2 }}>
                <span style={{ fontWeight: 700 }}>Play {s.label}</span>
                <span style={{ fontSize: '0.8rem', opacity: 0.85 }}>tap · key {SOUND_KEYS[i].toUpperCase()}</span>
              </Button>
            ))}
          </Box>
        )}

        {(rows.length > 0 || shown.sounds.length > 0) && (
          <Box role="img" aria-label={`Timeline: ${shown.segments.length} on${shown.segments.length === 1 ? '' : 's'}${shown.sounds.length ? ` and ${shown.sounds.length} sound${shown.sounds.length === 1 ? '' : 's'}` : ''}, ${words(shown.lengthMs)} long`} data-testid="timeline">
            {rows.map((ch) => (
              <Box key={ch} sx={{ display: 'grid', gridTemplateColumns: { xs: '84px 1fr', sm: '140px 1fr' }, alignItems: 'center', gap: 1, mb: 0.5 }}>
                <Typography variant="body2" noWrap title={named(ch, labels)}>{named(ch, labels)}</Typography>
                <Box sx={{ position: 'relative', height: 22, bgcolor: 'action.hover', borderRadius: 1, overflow: 'hidden' }}>
                  {shown.segments.filter((s) => s.target === ch).map((s, k) => (
                    <Box key={k} sx={{ position: 'absolute', top: 2, bottom: 2, left: pct(s.start), width: pct(s.end - s.start), bgcolor: s.cut ? 'warning.main' : 'primary.main', borderRadius: 0.5, opacity: phase === 'rec' ? 0.45 : 1 }} />
                  ))}
                  {liveBars.filter((x) => x.target === ch).map((x, k) => (
                    <Box key={`l${k}`} sx={{ position: 'absolute', top: 2, bottom: 2, left: pct(x.start), width: pct(Math.max(30, x.end - x.start)), bgcolor: x.cut ? 'warning.main' : 'error.main', borderRadius: 0.5 }} />
                  ))}
                  {pass.holds.filter((h) => h.target === ch && recording).map((h, k) => (
                    <Box key={`p${k}`} sx={{ position: 'absolute', top: 2, bottom: 2, left: pct(h.start), width: pct(Math.max(30, h.end - h.start)), bgcolor: h.cut ? 'warning.main' : 'error.main', borderRadius: 0.5 }} />
                  ))}
                  {(phase === 'rec' || phase === 'play') && <Box sx={{ position: 'absolute', top: 0, bottom: 0, left: pct(now), width: 2, bgcolor: 'text.primary' }} />}
                </Box>
              </Box>
            ))}
            {(shown.sounds.length > 0 || pass.sounds.length > 0) && (
              <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '84px 1fr', sm: '140px 1fr' }, alignItems: 'center', gap: 1 }}>
                <Typography variant="body2">Sounds</Typography>
                <Box sx={{ position: 'relative', height: 22, bgcolor: 'action.hover', borderRadius: 1, overflow: 'hidden' }}>
                  {[...shown.sounds, ...(phase === 'rec' ? pass.sounds : [])].map((s: SoundTap, k) => (
                    <Box key={k} title={`sound ${s.sound}`} sx={{ position: 'absolute', top: 3, left: pct(s.at), width: 16, height: 16, borderRadius: '50%', bgcolor: 'secondary.main', color: 'secondary.contrastText', fontSize: 11, textAlign: 'center', lineHeight: '16px' }}>{s.sound}</Box>
                  ))}
                </Box>
              </Box>
            )}
          </Box>
        )}

        {phase === 'review' && (
          <Stack spacing={2}>
            {script.notes.map((n) => <Alert key={n} severity="warning">{n}</Alert>)}
            <FormControlLabel control={<Checkbox checked={trimLead} onChange={(e) => setTrimLead(e.target.checked)} />}
              label="Start straight away when it is triggered (leave out the quiet bit before the first tap)" />
            <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
              <Button size="large" variant="outlined" onClick={() => playBack(total)} disabled={paused || !b.online}>Play it again</Button>
              <Button size="large" variant="outlined" onClick={more}>Add more on top</Button>
              <Button size="large" variant="outlined" color="warning" onClick={again}>Try again</Button>
            </Stack>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'center' }}>
              <TextField label="Name" value={name} placeholder={suggestName(total, labels)} onChange={(e) => setName(e.target.value)} sx={{ minWidth: 280 }}
                helperText="Any name you like, so you can find it again in Your library." />
              <Button ref={keepRef} size="large" variant="contained" disabled={saving || !!script.error} onClick={save} sx={{ minHeight: 56 }}>Keep it: save and send to {b.info?.name || 'the board'}</Button>
            </Stack>
            <Box component="details">
              <Box component="summary" sx={{ cursor: 'pointer' }}>See it as an effect script</Box>
              <Box component="pre" data-testid="recorded-script" sx={{ p: 2, bgcolor: 'action.hover', borderRadius: 2, overflow: 'auto', maxHeight: 300, m: 0, mt: 1 }}>{script.text || script.error}</Box>
            </Box>
          </Stack>
        )}
        {paused && <Alert severity="warning" data-testid="record-paused">The board is stopped. Resume or restart it to record or play.</Alert>}
        {notice && <Alert severity="info" onClose={() => setNotice('')}>{notice}</Alert>}
        {(problem || (phase === 'review' && script.error)) && <Alert severity="error" onClose={problem ? () => setProblem('') : undefined}>{problem || script.error}</Alert>}
      </Stack>
      <Dialog open={asking} onClose={goBack} disableRestoreFocus aria-labelledby="record-discard-title" data-testid="record-discard">
        <DialogTitle id="record-discard-title">Discard this recording?</DialogTitle>
        <DialogContent>
          <DialogContentText>What you recorded is thrown away and nothing is saved. Everything it turned on is already back to how it was.</DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={goBack} autoFocus>No, go back</Button>
          <Button onClick={discard} color="error" variant="contained">Discard</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
