// Every board in one grid: online, what it runs, and whether the library or a release has something newer.
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { call, onEvent } from '../api';
import { Accordion, AccordionDetails, AccordionSummary, Alert, Box, Button, Card, CardActions, CardContent, Checkbox, Chip, Paper, Stack, Tooltip, Typography } from '@mui/material';
import ExpandMore from '@mui/icons-material/ExpandMore';
import { Board, useStore } from '../store';
import { boardKind, conflicts, firmwareBadge, scriptBadge, supportsScripts } from '../words';
import AddBoard from '../components/AddBoard';
import { useBoardActions, ActionMessage } from '../components/actions';
import { useNav } from '../nav';
import { keyLabel } from '../shell/keys';
import { FreshBanner } from '../components/StartFresh';
import RunCounts from '../dashboard/RunCounts';
import { topicLabel } from '../dashboard/events';
import { CardFill, CardLook } from '../props/PropCard';

// one card per board, re-drawn only when that board (or its selection) changes: with many boards the others stay
const BoardCard = memo(function BoardCard({ b, onOpen: open, selected, onSelect: select, onSettings, advanced }: { b: Board; onOpen: (key: string) => void; selected: boolean; onSelect: (key: string, v: boolean) => void; onSettings: () => void; advanced: boolean }) {
  const onOpen = () => open(b.key);
  const onSelect = (v: boolean) => select(b.key, v);
  const act = useBoardActions();
  const sb = scriptBadge(b);
  const fb = firmwareBadge(b);
  const busy = act.busy[b.key];
  const fwOut = b.firmware?.plan?.out_of_date && !(b.lastUpdate && b.lastUpdate.version === b.firmware?.plan?.latest);
  return (
    <Card variant="outlined" sx={{ height: '100%', display: 'flex', flexDirection: 'column', position: 'relative', isolation: 'isolate' }} data-testid={`board-${b.info?.name}`}>
      <CardFill label={topicLabel(b.info?.name || b.key)} script={b.script?.text} boardKey={b.key} paramsSeq={b.paramsSeq} name={b.info?.name || b.key} />
      <CardContent sx={{ flexGrow: 1, pb: 1 }}>
        <Stack direction="row" alignItems="center" spacing={0.5}>
          <Checkbox checked={selected} onChange={(e) => onSelect(e.target.checked)} inputProps={{ 'aria-label': `Select ${b.info?.name || b.key}` }} sx={{ ml: -1, my: -0.5 }} />
          <Box aria-hidden sx={{ width: 10, height: 10, flexShrink: 0, borderRadius: '50%', bgcolor: b.online ? 'success.main' : 'text.disabled' }} />
          <Typography variant="subtitle1" component="h3" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexGrow: 1 }}>{b.info?.name || b.key}</Typography>
          <CardLook label={topicLabel(b.info?.name || b.key)} script={b.script?.text} boardKey={b.key} paramsSeq={b.paramsSeq} />
        </Stack>
        <Typography variant="body2" color="text.secondary">{b.online ? 'Connected' : 'Not answering (trying again)'} · {boardKind(b.info)}</Typography>
        {advanced && <Typography variant="body2" color="text.secondary">{b.key} · {b.info?.fw} {b.info?.fw_version} ({b.info?.fw_build})</Typography>}
        <Box sx={{ mt: 0.5 }}><RunCounts name={b.info?.name || b.key} state={b.state} compact /></Box>
        <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" sx={{ mt: 1.5 }} alignItems="flex-start">
          <Tooltip title={fb.help} describeChild><Chip size="small" color={fb.tone} label={fb.label} variant={fb.tone === 'default' ? 'outlined' : 'filled'} /></Tooltip>
          <Tooltip title={sb.help} describeChild><Chip size="small" color={sb.tone} label={sb.label} variant={sb.tone === 'default' ? 'outlined' : 'filled'} data-testid="script-badge" /></Tooltip>
          {b.state?.paused && <Chip color="error" label="Stopped: triggers are ignored" />}
          {b.otherDevice && <Alert severity="error" sx={{ py: 0 }} data-testid="other-device">{b.otherDevice}</Alert>}
          {(b.shows || []).filter((x) => x.enabled).length > 0 && <Typography variant="body2" color="text.secondary">Shows on the board: {(b.shows || []).filter((x) => x.enabled).map((x) => x.name).join(', ')}</Typography>}
          {conflicts(b).length > 0 && <Alert severity="warning" sx={{ py: 0 }}>{conflicts(b)[0]}</Alert>}
          {b.firmware?.plan?.error && !b.adapter && <Button size="small" onClick={onSettings}>Cannot check for firmware updates: why?</Button>}
        </Stack>
        <FreshBanner b={b} compact />
        {b.update && !['valid', 'rolled_back', 'failed'].includes(b.update.phase) && <Alert severity="info" sx={{ mt: 1 }}>Updating: {b.update.phase}…</Alert>}
        {busy && <Alert severity="info" sx={{ mt: 1 }}>{busy}</Alert>}
      </CardContent>
      <CardActions sx={{ flexWrap: 'wrap', gap: 1, px: 2, pb: 2, pt: 0, '& > :not(style) ~ :not(style)': { ml: 0 } }}>
        <Button variant="contained" color="error" onClick={() => act.stop(b.key)} aria-label={`Stop ${b.info?.name || b.key}`} disabled={!b.online}>Stop</Button>
        <Button variant="contained" onClick={onOpen} aria-label={`Open ${b.info?.name || b.key}`}>Open</Button>
        {supportsScripts(b) && <Button onClick={async () => { const n = await act.pickEffect(`Send an effect to ${b.info?.name}`); if (n) await act.sendEffect(b.key, n); }}>Send an effect…</Button>}
        {b.scriptStatus?.status === 'older' && <Button disabled={!!busy} onClick={() => act.sendEffect(b.key, b.scriptStatus.name)}>Update effect script</Button>}
        {(b.scriptStatus?.status === 'unknown' || b.scriptStatus?.status === 'changed') && <Button onClick={() => act.saveBoardScript(b.key)}>Save to library</Button>}
        {fwOut && <Button disabled={!!busy} onClick={() => act.updateFirmware(b.key)}>Update firmware</Button>}
        {!supportsScripts(b) && !fwOut && <Typography variant="body2" sx={{ px: 1 }}>Update the firmware to use effect scripts.</Typography>}
      </CardActions>
    </Card>
  );
}, (a, n) => a.selected === n.selected && a.advanced === n.advanced && a.onOpen === n.onOpen && a.onSelect === n.onSelect && a.onSettings === n.onSettings && sameCard(a.b, n.b));

// a card shows nothing of the live state but "stopped": inputs and outputs changing many times a second (each
// one a new state object) leave the cards alone
function sameCard(a: Board, b: Board) {
  if (a === b) return true;
  if (!!a.state?.paused !== !!b.state?.paused) return false;
  // the run counters (RunCounts): they change with a run, not with every input
  for (const k of ['runs_since_power_on', 'runs_lifetime', 'last_run_uptime_ms']) if (a.state?.[k] !== b.state?.[k]) return false;
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof Board>) {
    if (k === 'state' || k === 'log' || k === 'pressed') continue;
    if (a[k] !== b[k]) return false;
  }
  return true;
}

/** All boards at a glance (the Boards view with no board open). `addSeq` changes: unfold "Add a board" (the side
 * bar's + and the command palette's "Find or add boards"). */
export default function Boards({ addSeq = 0 }: { addSeq?: number }) {
  const { boards, prefs } = useStore();
  const act = useBoardActions();
  const nav = useNav();
  const onOpen = useCallback((k: string) => nav.openBoard(k), [nav.openBoard]); // eslint-disable-line react-hooks/exhaustive-deps
  const onSettings = useCallback(() => nav.go({ view: 'settings' }), [nav.go]); // eslint-disable-line react-hooks/exhaustive-deps
  const list = Object.values(boards).sort((a, b) => String(a.info?.name).localeCompare(String(b.info?.name)));
  const [adding, setAdding] = useState(list.length === 0 || addSeq > 0);
  // once boards are there (the welcome steps added some), the Add panel folds away
  const has = list.length > 0;
  useEffect(() => { if (has && !addSeq) setAdding(false); }, [has]); // eslint-disable-line react-hooks/exhaustive-deps
  const addRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (addSeq) { setAdding(true); setTimeout(() => addRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 50); } }, [addSeq]);
  const outdated = list.filter((b) => b.firmware?.plan?.out_of_date);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const chosen = list.filter((b) => sel.has(b.key));
  const select = useCallback((k: string, v: boolean) => setSel((s) => { const n = new Set(s); if (v) n.add(k); else n.delete(k); return n; }), []);
  return (
    <Stack spacing={3}>
      <Stack direction="row" alignItems="center" spacing={2} flexWrap="wrap" useFlexGap>
        <Typography variant="h5" component="h2" sx={{ flexGrow: 1 }}>Boards</Typography>
        {outdated.length > 1 && <Button variant="outlined" disabled={Object.keys(act.busy).length > 0} onClick={async () => { if (await act.confirm(`Update the firmware on all ${outdated.length} boards?`, 'Each board restarts with the new firmware, one after another. Settings and effects are kept.', 'Update all')) for (const b of outdated) await act.updateFirmware(b.key, true); }}>Update firmware on all {outdated.length} boards</Button>}
        {list.length > 0 && <Button variant="outlined" onClick={() => list.forEach((b) => act.backup(b.key))}>Back up all boards</Button>}
      </Stack>
      {chosen.length > 0 && (
        <Paper variant="outlined" sx={{ p: 1.5, display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center' }} role="region" aria-label="Selected boards">
          <Typography sx={{ fontWeight: 700, mr: 1 }}>{chosen.length} selected</Typography>
          <Button variant="contained" onClick={async () => { const n = await act.pickEffect(`Send an effect to ${chosen.length} board${chosen.length > 1 ? 's' : ''}`); if (n && await act.okToInterrupt(chosen.map((b) => b.key), `Sending “${n}”`)) for (const b of chosen) await act.sendEffect(b.key, n, true); }}>Send an effect…</Button>
          {chosen.some((b) => b.firmware?.plan?.out_of_date) && <Button variant="outlined" onClick={async () => { const l = chosen.filter((b) => b.firmware?.plan?.out_of_date); if (await act.confirm(`Update the firmware on ${l.length} board${l.length > 1 ? 's' : ''}?`, 'Each board restarts with the new firmware, one after another. Settings and effects are kept.', 'Update')) for (const b of l) await act.updateFirmware(b.key, true); }}>Update firmware</Button>}
          <Button variant="outlined" onClick={() => chosen.forEach((b) => act.backup(b.key))}>Back up</Button>
          <Button onClick={() => setSel(new Set())}>Clear selection</Button>
        </Paper>
      )}
      <ActionMessage />
      <SwitchPending />
      {list.length === 0 && <Typography data-testid="boards-empty">No boards yet. Start with <b>Add a practice board</b> below: it works like a real board, so you can try everything first. Real boards on your network show up with <b>Find boards on my network</b>.</Typography>}
      {list.length > 0 && <Typography variant="body2" color="text.secondary" data-testid="boards-hint">Open a board here or in the list on the left to see its inputs and outputs and change its effect and settings. Right-click a board on the left for more. {keyLabel('Mod+Shift+P')} finds any board, effect or command.</Typography>}
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 260px), 1fr))', gap: 2 }}>
        {list.map((b) => <BoardCard key={b.key} b={b} onOpen={onOpen} selected={sel.has(b.key)} onSelect={select} onSettings={onSettings} advanced={prefs.advanced} />)}
      </Box>
      <ReportingBoards known={list.map((b) => b.info?.name)} />
      <Accordion expanded={adding} onChange={(_, v) => setAdding(v)} ref={addRef}>
        <AccordionSummary expandIcon={<ExpandMore />}><Typography variant="h6" component="h3">Add a board</Typography></AccordionSummary>
        <AccordionDetails><AddBoard /></AccordionDetails>
      </Accordion>
    </Stack>
  );
}

/** Boards that report to this computer's MQTT server but have no direct session (another network, say). */
function ReportingBoards({ known }: { known: string[] }) {
  const [list, setList] = useState<any[]>([]);
  useEffect(() => {
    const load = () => call('mqtt_boards').then(setList).catch(() => setList([]));
    void load();
    return onEvent((e: any) => { if (e.kind === 'fleet') void load(); });
  }, []);
  const extra = list.filter((b) => !known.includes(b.state?.name) && !known.includes(b.name));
  if (!extra.length) return null;
  return (
    <Box>
      <Typography variant="h6" component="h3" gutterBottom>Reporting to this computer</Typography>
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 260px), 1fr))', gap: 2 }}>
        {extra.map((b) => (
          <Card key={b.key} variant="outlined" data-testid={`reporting-${b.name}`}>
            <CardContent>
              <Stack direction="row" alignItems="center" spacing={1}>
                <Box aria-hidden sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: b.online ? 'success.main' : 'text.disabled' }} />
                <Typography variant="subtitle1" component="h4">{b.state?.name || b.name}</Typography>
              </Stack>
              <Typography color="text.secondary">{b.online ? 'Online' : 'Offline'}</Typography>
              <Typography variant="body2">On now: {(b.state?.outputs || []).filter((o: any) => o.level > 0).map((o: any) => o.alias || o.channel).join(', ') || 'nothing'}</Typography>
            </CardContent>
          </Card>
        ))}
      </Box>
    </Box>
  );
}

/** A board whose firmware switch backed it up but never got its setup back (Studio closed, a crash, a failed
 * restore): said once on the Boards page, with one button that puts it back (core keeps the list, fleet.rs). */
function SwitchPending() {
  const { prefs, boards, pinFor } = useStore();
  const [list, setList] = useState<any[]>([]);
  const [msg, setMsg] = useState('');
  const load = useCallback(() => { if (prefs.workspace) call('switch_pending', { folder: prefs.workspace }).then((l) => setList(l || [])).catch(() => setList([])); }, [prefs.workspace]);
  useEffect(load, [load]);
  if (!list.length) return null;
  return (
    <>
      {list.map((e) => {
        const b = boards[e.key];
        return (
          <Alert key={e.path} severity="warning" data-testid="switch-pending"
            action={<Button color="inherit" disabled={!b?.online} onClick={async () => {
              try {
                await call('restore', { key: e.key, path: e.path, pin: await pinFor(e.key) });
                await call('switch_done', { folder: prefs.workspace, path: e.path });
                setMsg(`${e.name || e.key} has its settings, shows and effect back.`);
                load();
              } catch (err: any) { setMsg(String(err.message || err)); }
            }}>Put it back now</Button>}>
            {e.name || e.key} got new firmware{e.since ? ` (${e.since})` : ''}, but its settings, shows and effect script were not put back yet. The backup is safe in your library.{!b?.online ? ' Connect the board to put it back.' : ''}
          </Alert>
        );
      })}
      {msg && <Alert severity="info" onClose={() => setMsg('')}>{msg}</Alert>}
    </>
  );
}
