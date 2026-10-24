// The board's shows (PROTOCOL.md "Shows"): the list, an example show, links ("on while held" / "on for N
// seconds when pressed"), Run / Stop per show (as on the phone page), a small editor (name, on/off, "while held" per input trigger) and recording on the
// board ("Record over" / "Add to it"). The board keeps the shows; every change goes back as the board's own
// data with only the edited fields changed. Deleting or replacing a show asks first. Older firmware: the example
// button goes away when the board does not know it, and "while held" / "Add to it" are checked after the fact
// (an older board takes the show but drops the field), never assumed.
import { useEffect, useRef, useState } from 'react';
import { Alert, Box, Button, Checkbox, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, FormGroup, MenuItem, Radio, RadioGroup, Stack, Switch, TextField, Typography } from '@mui/material';
import { rpc } from '../api';
import { Board, useStore } from '../store';
import { useBoardActions } from './actions';
import { overlaps } from '../words';
import { applyEdit, editOf, heldKept, inputTriggers, LinkMode, linkName, linkShow, lowestFreeId, ShowEdit, wantsHeld } from '../shows/shows';

const TRIGGERS = ['TRIG1', 'TRIG2', 'USER1', 'USER2', 'USER3'];
const TOO_OLD_HELD = 'This board\'s firmware is too old for “on only while held”: it would keep the outputs on after you let go. Update its firmware, or use “on for a few seconds when pressed”.';
const TOO_OLD_ADD = 'This board\'s firmware cannot add to a track yet (it would record over it). Nothing was changed. Use Record over, or update its firmware.';
// boards whose firmware has no example show to add (by id and firmware build, so an update shows the button
// again): the button stays hidden for them, also after a restart of Studio (finding that out takes a 10 s wait)
const NO_EXAMPLE = 'specter-no-example';
const noExample = new Set<string>((() => { try { return JSON.parse(localStorage.getItem(NO_EXAMPLE) || '[]'); } catch { return []; } })());
function rememberNoExample(k: string) {
  noExample.add(k);
  try { localStorage.setItem(NO_EXAMPLE, JSON.stringify([...noExample].slice(-200))); } catch { /* private window: this session only */ }
}

type Msg = { tone: 'success' | 'error' | 'info' | 'warning'; text: string } | null;

function terminalsOf(b: Board) {
  const terms: any[] = b.info?.terminals || [];
  const term = (id: string) => terms.find((t) => String(t.id).toUpperCase() === id.toUpperCase());
  const label = (id: string) => (term(id)?.label ? `${id} (${term(id).label})` : id);
  // only terminals that answer shows (an output role or the built-in effect owns the others)
  const inputs = ((b.info?.inputs || TRIGGERS) as string[]).map((i) => i.toUpperCase()).filter((i) => TRIGGERS.includes(i) && term(i)?.shows !== false);
  const outputs = ((b.info?.channels || (b.state?.outputs || []).map((o: any) => o.channel)) as string[]).map((c) => c.toUpperCase()).filter((c) => term(c)?.shows !== false);
  return { inputs, outputs, label };
}

/** Momentary: down while held, up on let go, leaving, blur and unmount (as the live tiles). */
function TapButton({ onDown, onUp, disabled }: { onDown: () => Promise<unknown>; onUp: () => Promise<unknown>; disabled?: boolean }) {
  const held = useRef(false);
  const pressing = useRef<Promise<unknown>>(Promise.resolve());
  const upRef = useRef(onUp);
  upRef.current = onUp;
  const up = useRef(() => { if (held.current) { held.current = false; void pressing.current.finally(() => upRef.current()); } }).current;
  const down = () => { held.current = true; pressing.current = onDown().catch(() => {}); };
  useEffect(() => {
    window.addEventListener('blur', up);
    return () => { window.removeEventListener('blur', up); up(); };
  }, [up]);
  return (
    <Button variant="contained" color="warning" size="large" disabled={disabled} sx={{ touchAction: 'none', userSelect: 'none' }}
      onPointerDown={(e) => { if (e.button !== 0) return; (e.target as Element).setPointerCapture?.(e.pointerId); if (!held.current) down(); }}
      onPointerUp={up} onPointerCancel={up} onLostPointerCapture={up} onBlur={up} onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => { if ((e.key === ' ' || e.key === 'Enter') && !held.current) { e.preventDefault(); down(); } }}
      onKeyUp={(e) => { if (e.key === ' ' || e.key === 'Enter') up(); }}>
      Tap (hold = on)
    </Button>
  );
}

export default function ShowsPanel({ boardKey }: { boardKey: string }) {
  const { boards, change, refreshShows } = useStore();
  const act = useBoardActions();
  const b = boards[boardKey];
  const [msg, setMsg] = useState<Msg>(null);
  const [editing, setEditing] = useState<{ data: any; edit: ShowEdit } | null>(null);
  const [linking, setLinking] = useState(false);
  const [recording, setRecording] = useState<{ show: number | 'new'; target: string } | null>(null);
  const [, bump] = useState(0);
  if (!b) return null;
  const caps: string[] = b.info?.capabilities || [];
  if (!caps.includes('shows')) return null;
  const boardName = b.info?.name || boardKey;
  const id = `${b.info?.id || boardKey}@${b.info?.fw_build || ''}`;
  const shows = b.shows || [];
  const { inputs, outputs, label } = terminalsOf(b);

  const ask = async (req: Record<string, unknown>) => {
    const r = await change(boardKey, req);
    if (!r.ok) throw new Error(r.error?.message || 'the board refused');
    return r.result;
  };
  const getShow = async (show: number) => (await ask({ op: 'get_show', show })).data;
  const done = async (m: Msg) => { setMsg(m); await refreshShows(boardKey); };
  const fail = (e: any) => setMsg({ tone: 'error', text: String(e.message || e) });
  // a show with "while held" is written off, read back, and only switched on when the board kept until_release
  // `isNew`: a show that is not on the board yet. It goes with `new: true`: newer firmware picks the lowest free id
  // itself and answers with the stored show (two pages adding at once never take the same id); older firmware
  // ignores the flag and uses the id sent (the lowest free one Studio saw)
  const put = async (data: any, isNew: boolean): Promise<any> => {
    const r = await ask({ op: 'put_show', data, ...(isNew ? { new: true } : {}) });
    return r?.kind === 'show' && r.data ? r.data : data;
  };
  const putChecked = async (data: any, before: any | null, isNew = false): Promise<boolean> => {
    if (!wantsHeld(data)) { await put(data, isNew); return true; }
    const stored = await put({ ...data, enabled: false }, isNew);
    const got = await getShow(stored.id);
    if (heldKept(data, got)) {
      if (data.enabled !== false) await ask({ op: 'put_show', data: { ...data, id: stored.id } });
      return true;
    }
    if (before) await ask({ op: 'put_show', data: before }); else await ask({ op: 'delete_show', show: stored.id });
    return false;
  };

  const addExample = async () => {
    setMsg({ tone: 'info', text: 'Adding the example show…' });
    // an older board answers an op it does not know with bad_request and without the request's id, so Studio
    // sees no answer at all: both mean "this firmware has no example show"
    const r = await change(boardKey, { op: 'add_example' }).catch((e: any) => ({ ok: false, error: { code: 'no_answer', message: String(e.message || e) } }));
    if (!r.ok && (r.error?.code === 'bad_request' || r.error?.code === 'no_answer')) {
      rememberNoExample(id);
      bump((n) => n + 1);
      return done({ tone: 'info', text: `${boardName}'s firmware has no example show to add. Update its firmware for it.` });
    }
    if (!r.ok) return fail(new Error(r.error?.message || 'the board refused'));
    await done({ tone: 'success', text: `Added “${r.result?.data?.name || 'the example show'}”: press ${r.result?.data?.triggers?.[0]?.input || 'TRIG1'} to try it.` });
  };
  const edit = async (show: number) => {
    try { const data = await getShow(show); setEditing({ data, edit: editOf(data) }); } catch (e) { fail(e); }
  };
  const saveEdit = async () => {
    if (!editing) return;
    const { data, edit: e } = editing;
    if (!(await act.confirm(`Change the show “${data.name}” on ${boardName}?`, 'The board\'s copy of this show is replaced by your changes.', 'Change it'))) return;
    setEditing(null);
    try {
      const next = applyEdit(data, e);
      const ok = await putChecked(next, data);
      await done(ok ? { tone: 'success', text: `Changed “${next.name}”.` } : { tone: 'warning', text: `${TOO_OLD_HELD} “${data.name}” is unchanged.` });
    } catch (err) { fail(err); }
  };
  const turnOff = async (show: number, name: string) => {
    if (!(await act.confirm(`Turn the show “${name}” off on ${boardName}?`, 'It stays on the board but no longer starts. You can turn it on again here.', 'Turn it off'))) return;
    try { const data = await getShow(show); await ask({ op: 'put_show', data: { ...data, enabled: false } }); await done({ tone: 'success', text: `“${name}” is off.` }); } catch (e) { fail(e); }
  };
  const remove = async (show: number, name: string) => {
    if (!(await act.confirm(`Delete the show “${name}” from ${boardName}?`, 'The show is removed from the board. A backup made before keeps it.', 'Delete'))) return;
    try { await ask({ op: 'delete_show', show }); await done({ tone: 'success', text: `Deleted “${name}”.` }); } catch (e) { fail(e); }
  };
  // Run and Stop, as on the phone page: the board's own refusal says why (running, cooldown, off, stopped)
  const runShow = async (show: number, name: string) => {
    const r = await change(boardKey, { op: 'run', show }).catch((e: any) => ({ ok: false, error: { message: String(e.message || e) } }));
    if (!r.ok) {
      const why = String(r.error?.message || 'the board refused');
      return setMsg({ tone: 'warning', text: `“${name}” did not start: ${why}${b.state?.paused ? ' (use Resume at the top of this page)' : ''}` });
    }
    setMsg({ tone: 'success', text: `Started “${name}”.` });
  };
  const stopShow = async (show: number, name: string) => {
    const r = await change(boardKey, { op: 'stop', show }).catch((e: any) => ({ ok: false, error: { message: String(e.message || e) } }));
    setMsg(r.ok ? { tone: 'info', text: `Stopped “${name}”.` } : { tone: 'error', text: `“${name}” did not stop: ${r.error?.message || 'the board refused'}` });
  };
  const runningNow = (show: number) => (b.state?.shows || []).some((s: any) => s.id === show && s.state === 'running');
  const makeLink = async (input: string, outs: string[], mode: LinkMode, seconds: number) => {
    setLinking(false);
    try {
      const list = (await ask({ op: 'list_shows' })).shows || [];
      const name = linkName(input, outs);
      const same = list.find((s: any) => s.name === name);
      let before: any = null;
      if (same) {
        if (!(await act.confirm(`Replace the show “${name}” on ${boardName}?`, 'A show with this name is already on the board. The new link takes its place.', 'Replace'))) return;
        before = await getShow(same.id);
      }
      const data = linkShow({ id: same ? same.id : lowestFreeId(list.map((s: any) => s.id)), input, outputs: outs, mode, seconds });
      const ok = await putChecked(data, before, !same);
      await done(ok
        ? { tone: 'success', text: mode === 'held' ? `${name}: ${outs.join(', ')} ${outs.length > 1 ? 'are' : 'is'} on while ${input} is held (at most ${seconds} s).` : `${name}: each press of ${input} turns ${outs.join(', ')} on for ${seconds} s.` }
        : { tone: 'warning', text: `${TOO_OLD_HELD} Nothing was added.` });
    } catch (e) { fail(e); }
  };

  const ov = overlaps(b);
  return (
    <Box data-testid="shows-panel">
      <Typography variant="h6" component="h3">Shows on the board</Typography>
      <Typography variant="body2" color="text.secondary" gutterBottom>A show is a timed list of what to turn on, kept on the board. {shows.length === 0 ? 'This board has no shows: wiring an input starts nothing until you add one or send an effect.' : ''}</Typography>
      {msg && <Alert severity={msg.tone} onClose={() => setMsg(null)} sx={{ mb: 1 }} data-testid="shows-message">{msg.text}</Alert>}
      <Stack spacing={0.5} aria-label="Shows" component="ul" sx={{ listStyle: 'none', p: 0, m: 0 }}>
        {shows.map((x) => (
          <Stack key={x.id} component="li" direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap data-testid={`show-${x.id}`}>
            <Typography sx={{ flexGrow: 1 }}>{x.name}{x.enabled ? '' : ' (off)'}{x.inputs.length ? ` · starts on ${x.inputs.join(', ')}` : ''}{x.held ? ' · while held' : ''}</Typography>
            {runningNow(x.id)
              ? <Button size="small" variant="outlined" aria-label={`Stop ${x.name}`} onClick={() => stopShow(x.id, x.name)} disabled={!b.online}>Stop</Button>
              : <Button size="small" variant="outlined" aria-label={`Run ${x.name}`} onClick={() => runShow(x.id, x.name)} disabled={!b.online}>Run</Button>}
            <Button size="small" onClick={() => edit(x.id)} disabled={!b.online}>Edit…</Button>
            {caps.includes('record') && <Button size="small" onClick={() => setRecording({ show: x.id, target: outputs[0] || 'OUT1' })} disabled={!b.online || !outputs.length}>Record…</Button>}
            <Button size="small" color="error" onClick={() => remove(x.id, x.name)} disabled={!b.online}>Delete</Button>
          </Stack>
        ))}
      </Stack>
      {ov.map((o) => (
        <Alert key={`${o.input}-${o.show.id}`} severity={o.intended ? 'info' : 'warning'} sx={{ mt: 1 }} data-testid="show-overlap"
          action={<Button color="inherit" size="small" onClick={() => turnOff(o.show.id, o.show.name)}>Turn the show off</Button>}>{o.text}</Alert>
      ))}
      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ mt: 1 }}>
        {!noExample.has(id) && <Button variant="outlined" onClick={addExample} disabled={!b.online}>Add an example show</Button>}
        <Button variant="outlined" onClick={() => setLinking(true)} disabled={!b.online || !inputs.length || !outputs.length}>Link an input to outputs…</Button>
        {caps.includes('record') && <Button variant="outlined" onClick={() => setRecording({ show: 'new', target: outputs[0] || 'OUT1' })} disabled={!b.online || !outputs.length}>Record a new show…</Button>}
      </Stack>
      {b.address && <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>Shows can also be made on the board's own page: open {b.address} in a browser.</Typography>}
      {editing && (
        <Dialog open onClose={() => setEditing(null)} fullWidth maxWidth="sm">
          <DialogTitle>Edit the show “{editing.data.name}”</DialogTitle>
          <DialogContent>
            <Stack spacing={2} sx={{ pt: 1 }}>
              <TextField label="Name" value={editing.edit.name} onChange={(e) => setEditing({ ...editing, edit: { ...editing.edit, name: e.target.value } })} inputProps={{ maxLength: 32 }} />
              <FormControlLabel control={<Switch checked={editing.edit.enabled} onChange={(e) => setEditing({ ...editing, edit: { ...editing.edit, enabled: e.target.checked } })} />} label="On (it starts when triggered)" />
              {inputTriggers(editing.data).map((i) => (
                <FormControlLabel key={i} control={<Checkbox checked={!!editing.edit.held[i]} onChange={(e) => setEditing({ ...editing, edit: { ...editing.edit, held: { ...editing.edit.held, [i]: e.target.checked } } })} />}
                  label={`${editing.data.triggers[i].input}: on only while held (stops when let go)`} />
              ))}
              {inputTriggers(editing.data).length > 0 && <Typography variant="body2" color="text.secondary">While held, the show runs at most its own length and stops as soon as the input is let go.</Typography>}
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setEditing(null)}>Cancel</Button>
            <Button variant="contained" onClick={saveEdit} disabled={!editing.edit.name.trim()}>Save</Button>
          </DialogActions>
        </Dialog>
      )}
      {linking && <LinkDialog inputs={inputs} outputs={outputs} label={label} onClose={() => setLinking(false)} onCreate={makeLink} />}
      {recording && <RecordOnBoard b={b} start={recording} outputs={outputs} label={label} shows={shows} onClose={async (m) => { setRecording(null); await done(m); }} />}
    </Box>
  );
}

function LinkDialog({ inputs, outputs, label, onClose, onCreate }: { inputs: string[]; outputs: string[]; label: (id: string) => string; onClose: () => void; onCreate: (input: string, outs: string[], mode: LinkMode, seconds: number) => void }) {
  const [input, setInput] = useState(inputs[0] || 'TRIG1');
  const [outs, setOuts] = useState<string[]>(outputs.slice(0, 1));
  const [mode, setMode] = useState<LinkMode>('held');
  const [seconds, setSeconds] = useState(mode === 'held' ? 60 : 2);
  const ok = outs.length > 0 && seconds > 0 && seconds <= 600;
  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>Link an input to outputs</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <TextField select label="When this input is pressed" value={input} onChange={(e) => setInput(e.target.value)}>
            {inputs.map((i) => <MenuItem key={i} value={i}>{label(i)}</MenuItem>)}
          </TextField>
          <FormGroup aria-label="Outputs to turn on">
            <Typography variant="body2">Turn on:</Typography>
            {outputs.map((o) => <FormControlLabel key={o} label={label(o)} control={<Checkbox checked={outs.includes(o)} onChange={(e) => setOuts(e.target.checked ? [...outs, o] : outs.filter((x) => x !== o))} />} />)}
          </FormGroup>
          <RadioGroup value={mode} onChange={(e) => { const m = e.target.value as LinkMode; setMode(m); setSeconds(m === 'held' ? 60 : 2); }} aria-label="How long">
            <FormControlLabel value="held" control={<Radio />} label="On while held (off when let go)" />
            <FormControlLabel value="pulse" control={<Radio />} label="On for a few seconds when pressed" />
          </RadioGroup>
          <TextField type="number" label={mode === 'held' ? 'At most (seconds)' : 'For (seconds)'} value={seconds} inputProps={{ min: 0.1, max: 600, step: 0.5 }}
            onChange={(e) => setSeconds(Number(e.target.value))} helperText={mode === 'held' ? 'A safety limit: the outputs go off after this even while it is still held.' : undefined} />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" disabled={!ok} onClick={() => onCreate(input, outs, mode, seconds)}>Make the link</Button>
      </DialogActions>
    </Dialog>
  );
}

/** Recording on the board: Record over replaces the target's cues, Add to it joins the taps with them. The
 * first tap starts the clock; Finish keeps it, Cancel (and leaving) forgets it. */
function RecordOnBoard({ b, start, outputs, label, shows, onClose }: { b: Board; start: { show: number | 'new'; target: string }; outputs: string[]; label: (id: string) => string; shows: { id: number; name: string }[]; onClose: (m: Msg) => void }) {
  const { change } = useStore();
  const [show, setShow] = useState<number | 'new'>(start.show);
  const [target, setTarget] = useState(start.target);
  const [active, setActive] = useState(false);
  const [problem, setProblem] = useState('');
  const activeRef = useRef(false);
  activeRef.current = active;
  // leaving while recording forgets the pass (never a half-recorded show)
  useEffect(() => () => { if (activeRef.current) void change(b.key, { op: 'record_abort' }); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const rec = b.state?.recording;
  const begin = async (add: boolean) => {
    setProblem('');
    const id = show === 'new' ? lowestFreeId(shows.map((s) => s.id)) : show;
    const r = await change(b.key, { op: 'record_start', show: id, target, ...(add ? { add: true } : {}) });
    if (!r.ok) return setProblem(r.error?.message || 'the board refused');
    if (add) {
      // an older board ignores `add` and would record over: check, and give up before any tap
      const st = await rpc(b.key, { op: 'state' }).catch(() => null);
      if (st?.result?.recording?.add !== true) {
        await change(b.key, { op: 'record_abort' });
        return setProblem(TOO_OLD_ADD);
      }
    }
    setActive(true);
  };
  const finish = async () => {
    const r = await change(b.key, { op: 'record_finish' });
    setActive(false);
    if (!r.ok) return onClose({ tone: 'error', text: r.error?.message || 'the board refused' });
    onClose({ tone: 'success', text: `Saved the show “${r.result?.data?.name || 'recorded'}”${r.result?.data?.triggers?.[0]?.input ? `: it starts on ${r.result.data.triggers[0].input}` : ''}.` });
  };
  const cancel = async () => {
    if (active) await change(b.key, { op: 'record_abort' });
    setActive(false);
    onClose(active ? { tone: 'info', text: 'Recording cancelled: the show is unchanged.' } : null);
  };
  const existing = show !== 'new';
  return (
    <Dialog open onClose={cancel} fullWidth maxWidth="sm">
      <DialogTitle>Record on {b.info?.name}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          {problem && <Alert severity="warning" data-testid="record-problem">{problem}</Alert>}
          {!active && <>
            <TextField select label="Show" value={String(show)} onChange={(e) => setShow(e.target.value === 'new' ? 'new' : Number(e.target.value))}>
              {shows.map((s) => <MenuItem key={s.id} value={String(s.id)}>{s.name}</MenuItem>)}
              <MenuItem value="new">A new show (starts on TRIG1)</MenuItem>
            </TextField>
            <TextField select label="Output to record" value={target} onChange={(e) => setTarget(e.target.value)}>
              {outputs.map((o) => <MenuItem key={o} value={o}>{label(o)}</MenuItem>)}
            </TextField>
            <Typography variant="body2" color="text.secondary">Record over replaces what this output does in the show. Add to it keeps that and adds your taps. The show's other outputs play along; your first tap starts the clock.</Typography>
          </>}
          {active && <>
            <Typography data-testid="recording-state">
              Recording {rec?.target || target}{rec?.add ? ' (adding to it)' : ' (recording over)'}{rec ? ` · ${(Number(rec.elapsed_ms || 0) / 1000).toFixed(1)} s · ${rec.cues ?? 0} cues` : ''}
            </Typography>
            <TapButton disabled={!b.online} onDown={() => change(b.key, { op: 'record_tap', down: true })} onUp={() => change(b.key, { op: 'record_tap', down: false })} />
          </>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={cancel}>Cancel</Button>
        {!active && <Button onClick={() => begin(false)} disabled={!b.online}>Record over</Button>}
        {!active && <Button onClick={() => begin(true)} disabled={!b.online || !existing}>Add to it</Button>}
        {active && <Button variant="contained" onClick={finish}>Finish</Button>}
      </DialogActions>
    </Dialog>
  );
}
