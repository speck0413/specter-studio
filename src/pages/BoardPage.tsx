// One board: live inputs and outputs, its effect script, settings, backups, activity; in advanced mode also
// the raw protocol console.
import { useEffect, useRef, useState } from 'react';
import { Alert, Box, Button, Chip, List, ListItem, ListItemText, Menu, MenuItem, Paper, Stack, Tab, Tabs, Typography, useMediaQuery, useTheme } from '@mui/material';
import ArrowDropDown from '@mui/icons-material/ArrowDropDown';
import ChevronRight from '@mui/icons-material/ChevronRight';
import { call, pickFile, rpc } from '../api';
import { useStore } from '../store';
import BoardScriptLink from '../components/ScriptLink';
import { actionHelp, boardKind, firmwareBadge, scriptBadge, supportsScripts, ACTIVITY_EMPTY } from '../words';
import BoardScript from '../components/BoardScript';
import { useBoardActions, ActionMessage, RESUME_NOTE } from '../components/actions';
import LivePanel from '../components/LivePanel';
import SettingsPanel from '../components/SettingsPanel';
import ProtocolConsole from '../components/ProtocolConsole';
import Plotter from '../components/Plotter';
import WiringGuide from '../components/WiringGuide';
import NewEffect, { Choice } from '../components/NewEffect';
import RecordEffect, { Recorded } from '../record/RecordEffect';
import TryNow from '../components/TryNow';
import ShowsPanel from '../components/ShowsPanel';
import { saveNewEffect, takenNote } from '../library';
import { boardAddress } from '../wifi';
import { useNav } from '../nav';
import Splitter from '../shell/Splitter';
import RunCounts from '../dashboard/RunCounts';
import { BoardSetup } from '../components/FirmwareType';
import { takesPackages } from '../boardPackages';
import { FreshBanner } from '../components/StartFresh';
import { boardPackageName, firmwarePlugins } from '../firmware';

function BackupPanel({ boardKey }: { boardKey: string }) {
  const { prefs } = useStore(); // file names only in advanced mode
  const act = useBoardActions();
  const [list, setList] = useState<any[]>([]);
  const load = () => { if (prefs.backups) call('backups', { folder: prefs.backups }).then(setList).catch(() => setList([])); };
  useEffect(load, [prefs.backups]);
  return (
    <Stack spacing={2}>
      <Typography>A backup keeps the board's settings, shows and effect script (never passwords) in a file in {prefs.backups || 'your backups folder'}.</Typography>
      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
        <Button variant="contained" onClick={async () => { await act.backup(boardKey); load(); }}>Back up now</Button>
        <Button variant="outlined" onClick={async () => { const f = await pickFile('Choose a backup file (.json), for example the starter kit'); if (f) await act.restore(boardKey, f); }}>Restore from a file…</Button>
      </Stack>
      <Typography variant="body2" color="text.secondary">“Restore from a file” also loads a ready-made setup someone gave you, such as the starter kit from the wiring guides.</Typography>
      <List aria-label="Backups">
        {list.map((f) => (
          <ListItem key={f.path} secondaryAction={<Button onClick={() => act.restore(boardKey, f.path)}>Restore to this board</Button>}>
            <ListItemText primary={f.name} secondary={`${f.modified ? new Date(f.modified * 1000).toLocaleString() : ''}${prefs.advanced ? ` · ${f.file}` : ''}`} />
          </ListItem>
        ))}
      </List>
    </Stack>
  );
}

// the board's own action buttons (for example "Save now"): rarely needed, so in a small menu with their help
// beside each, instead of a row of buttons and explanations at the top of every board page
// a board action that runs while it is held (newer firmware: `momentary`, for example Recover in hold mode): down
// on press, repeated while held, up on release, on leaving the button and when the window loses focus
function HoldAction({ boardKey, action }: { boardKey: string; action: any }) {
  const { change, boards, pinFor } = useStore();
  const timer = useRef<number | undefined>(undefined);
  const held = useRef(false);
  // the first press may ask for the page password; the repeats (the board's lease is 1.5 s) and the release use the
  // password Studio knows then and never ask again
  const quiet = async (down: boolean) => { const pin = await pinFor(boardKey); return rpc(boardKey, { op: 'action', key: action.key, down, ...(pin ? { pin } : {}) }).catch(() => null); };
  const up = () => { if (!held.current) return; held.current = false; window.clearInterval(timer.current); void quiet(false); };
  const down = () => {
    if (held.current) return;
    held.current = true;
    void change(boardKey, { op: 'action', key: action.key, down: true }).catch(() => null);
    timer.current = window.setInterval(() => void quiet(true), 500);
  };
  useEffect(() => { window.addEventListener('blur', up); return () => { window.removeEventListener('blur', up); up(); }; }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Button variant="outlined" sx={{ touchAction: 'none', userSelect: 'none' }} disabled={!boards[boardKey]?.online} title={actionHelp(action) || undefined}
      onPointerDown={(e) => { if (e.button === 0) { (e.target as Element).setPointerCapture?.(e.pointerId); down(); } }} onPointerUp={up} onPointerCancel={up} onLostPointerCapture={up}
      onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); down(); } }} onKeyUp={(e) => { if (e.key === ' ' || e.key === 'Enter') up(); }}
      onContextMenu={(e) => e.preventDefault()}>{action.label} (hold)</Button>
  );
}

function BoardActionsMenu({ boardKey }: { boardKey: string }) {
  const { boards, change } = useStore();
  const act = useBoardActions();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const b = boards[boardKey];
  const run = async (x: any) => {
    setAnchor(null);
    if (x.confirm && !(await act.confirm(`${x.label}?`, `This runs “${x.label}” on ${b.info?.name}.`, x.label))) return;
    const r = await change(boardKey, { op: 'action', key: x.key });
    if (!r.ok) window.alert(r.error?.message);
  };
  return (
    <>
      <Button onClick={(e) => setAnchor(e.currentTarget)} aria-haspopup="menu" aria-expanded={!!anchor} endIcon={<ArrowDropDown />}>More</Button>
      <Menu anchorEl={anchor} open={!!anchor} onClose={() => setAnchor(null)} aria-label="Board actions">
        {b.info.actions.filter((x: any) => !x.momentary).map((x: any) => (
          <MenuItem key={x.key} onClick={() => void run(x)} sx={{ whiteSpace: 'normal', maxWidth: 420 }}>
            <ListItemText primary={x.label} secondary={actionHelp(x) || undefined} slotProps={{ secondary: { 'data-testid': `action-help-${x.key}` } as any }} />
          </MenuItem>
        ))}
      </Menu>
    </>
  );
}

export default function BoardPage({ boardKey, dark, initialTab }: { boardKey: string; dark: boolean; initialTab?: string }) {
  const { boards, prefs, setPrefs, remove, change, bumpLibrary, refreshScript, refreshFirmware, plugins } = useStore();
  const act = useBoardActions();
  const nav = useNav();
  // more than the stock firmware (an allowed plugin adds a type): the board says which it runs, and it can change
  const manyTypes = firmwarePlugins(plugins, prefs.pluginConsent).length > 0;
  const onBack = () => nav.go({ view: 'boards' });
  const [tab, setTabState] = useState(initialTab || 'live');
  // the section is part of where you are: Back returns to it
  const setTab = (t: string) => { setTabState(t); nav.replace({ tab: t }); };
  useEffect(() => { if (initialTab) setTabState(initialTab); }, [initialTab, boardKey]);
  // wide windows: the live inputs and outputs stay beside the other sections (no Live tab)
  const theme = useTheme();
  const wide = useMediaQuery(theme.breakpoints.up('lg'), { noSsr: true });
  const where = wide ? 'in the Live panel' : 'below'; // where the Press buttons are
  const [making, setMaking] = useState(false);
  const [recordingEffect, setRecording] = useState(false);
  // Record effect cancelled: the focus goes back to where it was started from
  const makeButton = useRef<HTMLButtonElement>(null);
  const [backToMake, setBackToMake] = useState(false);
  useEffect(() => { if (backToMake && !recordingEffect) { makeButton.current?.focus(); setBackToMake(false); } }, [backToMake, recordingEffect]);
  const [tryHint, setTryHint] = useState('');
  const [tryOuts, setTryOuts] = useState<string[]>([]);
  const [wiring, setWiring] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, [boardKey]);
  const b = boards[boardKey];
  if (!b) return <Stack spacing={2} alignItems="flex-start"><Typography>This board is not in Studio any more.</Typography><Button variant="outlined" onClick={onBack}>All boards</Button></Stack>;
  const fb = firmwareBadge(b);
  // the protocol console exists only in advanced mode: turning it off on that tab shows Live
  const fallback = wide ? 'script' : 'live';
  const shown = (!prefs.advanced && tab === 'console') || (wide && tab === 'live') ? fallback : tab;
  // a held pause input keeps the board stopped whatever Resume does (the phone page's wording)
  const pausePin = (b.info?.terminals || []).find((t: any) => t.role === 'pause');
  const pauseHeld = !!pausePin && !!(b.state?.inputs || []).find((i: any) => String(i.input).toUpperCase() === String(pausePin.id).toUpperCase())?.active;
  const labels: Record<string, string> = {};
  for (const t of b.info?.terminals || []) if (t.label) labels[String(t.id).toUpperCase()] = t.label;
  // the one obvious path: say what the prop should do, it goes to this board, press the input to try it
  const make = async (name: string, text: string, c: Choice) => {
    setMaking(false);
    setTryHint('');
    let note = '';
    try {
      const r = await saveNewEffect(prefs.workspace, name, text);
      if (r.renamed) { note = takenNote(name, r.name) + ' '; name = r.name; }
      bumpLibrary();
    } catch (e: any) { window.alert(String(e.message || e)); return; }
    if (!wide) setTab('live');
    if (await act.sendEffect(boardKey, name)) {
      const named = (o: string) => (labels[o.toUpperCase()] ? `${o.toUpperCase()} (${labels[o.toUpperCase()]})` : o.toUpperCase());
      const what = c.also ? `${named(c.output)} and ${named(c.also)} turn` : `${named(c.output)} turns`;
      setTryOuts([c.output, c.also].filter(Boolean).map((o) => o.toUpperCase()));
      setTryHint(`${note}Try it now: hold Press on ${c.input.toUpperCase()} ${where} for a moment. ${what} on for ${c.seconds} second${c.seconds === 1 ? '' : 's'}.`);
    }
  };
  // recorded: saved under a name not yet taken, sent to this board, then pressed to try it
  const keepRecorded = async (t: Recorded) => {
    let name = t.name || 'recorded effect';
    let note = '';
    try {
      const r = await saveNewEffect(prefs.workspace, name, t.text);
      if (r.renamed) { note = takenNote(name, r.name) + ' '; name = r.name; }
      bumpLibrary();
    } catch (e: any) { window.alert(String(e.message || e)); return; }
    setTryHint('');
    if (await act.sendEffect(boardKey, name)) {
      setRecording(false);
      if (!wide) setTab('live');
      const input = t.trigger.toUpperCase();
      setTryOuts(t.outputs.map((o) => o.toUpperCase()));
      setTryHint(`${note}Try it now: ${b.sim ? `hold Press on ${input} ${where} for a moment` : `press ${labels[input] ? `${labels[input]} (${input})` : input}`}. ${b.info?.name || 'The board'} does what you tapped, every time. To change a moment of it, open it in Your library and tweak it in the script or blocks view.`);
    }
  };
  const canMake = supportsScripts(b) && !!prefs.workspace && b.online;
  const sb = scriptBadge(b);
  const addr = boardAddress(b.state?.net); // where the board answers (its name address, net.host, once it has one)
  const live = <LivePanel b={b} onWiring={setWiring} dense={wide} />;
  const zf = theme.palette.shell.zoom / 100; // kept at 100 %, grows with the text size
  const liveWidth = Math.round((prefs.livePaneWidth || 360) * zf);
  const sections = (
    <Box sx={{ minWidth: 0 }}>
      <Tabs value={shown} onChange={(_, v) => setTab(v)} variant="scrollable" aria-label="Board sections" sx={{ mb: 3, borderBottom: 1, borderColor: 'divider' }}>
        {!wide && <Tab value="live" label="Live" />}
        <Tab value="script" label="Effect script" />
        <Tab value="plot" label="Plot" />
        <Tab value="settings" label="Settings" />
        <Tab value="backup" label="Backups" />
        <Tab value="log" label="Activity" />
        {prefs.advanced && <Tab value="console" label="Protocol console" />}
      </Tabs>
      {shown === 'live' && live}
      {shown === 'script' && <Stack spacing={3}><BoardScript boardKey={boardKey} dark={dark} /><ShowsPanel boardKey={boardKey} /></Stack>}
      {shown === 'plot' && <Plotter source={{ board: boardKey }} />}
      {shown === 'settings' && <SettingsPanel b={b} />}
      {shown === 'backup' && <BackupPanel boardKey={boardKey} />}
      {shown === 'log' && (
        <Box component="ul" aria-label="Activity" sx={{ listStyle: 'none', p: 0, m: 0, fontFamily: 'monospace', fontSize: 'body2.fontSize', maxHeight: 500, overflow: 'auto' }}>
          {b.log.slice().reverse().map((l, i) => <li key={i}>{new Date(l.t).toLocaleTimeString()} {l.text}</li>)}
          {b.log.length === 0 && <li style={{ fontFamily: 'inherit' }} data-testid="activity-empty"><Typography component="span">{ACTIVITY_EMPTY}</Typography></li>}
        </Box>
      )}
      {shown === 'console' && <ProtocolConsole boardKey={boardKey} />}
    </Box>
  );
  return (
    <Stack spacing={2}>
      <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap" useFlexGap>
        <Box component="nav" aria-label="Where you are" sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flexGrow: 1, minWidth: 220 }}>
          <Button onClick={onBack} sx={{ px: 1, color: 'text.secondary' }}>All boards</Button>
          <ChevronRight fontSize="small" sx={{ color: 'text.secondary' }} aria-hidden />
          <Box aria-hidden sx={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, bgcolor: b.online ? 'success.main' : 'text.disabled', mx: 0.5 }} />
          <Typography variant="h5" component="h2" sx={{ outline: 'none', whiteSpace: 'nowrap' }} tabIndex={-1} ref={heading}>{b.info?.name}</Typography>
        </Box>
        <Button variant="contained" color="error" onClick={() => act.stop(boardKey)} disabled={!b.online}>Stop</Button>
        <Button onClick={() => act.restart(boardKey)} disabled={!b.online}>Restart</Button>
        <Button onClick={() => act.backup(boardKey)}>Back up</Button>
        {b.info?.actions?.filter((x: any) => x.momentary).map((x: any) => <HoldAction key={x.key} boardKey={boardKey} action={x} />)}
        {b.info?.actions?.some((x: any) => !x.momentary) && <BoardActionsMenu boardKey={boardKey} />}
        {b.firmware?.plan?.out_of_date && <Button variant="contained" onClick={() => act.updateFirmware(boardKey)}>Update firmware</Button>}
        {(manyTypes || takesPackages(b.info)) && <BoardSetup boardKey={boardKey} />}
        {b.sim && <Button onClick={async () => { const on = !b.online; await call('sim_power', { key: boardKey, on }).catch((e) => window.alert(String(e.message || e))); if (on) { void refreshScript(boardKey); void refreshFirmware(boardKey); } }}>{b.online ? 'Unplug (practice)' : 'Plug in again'}</Button>}
        <Button color="error" onClick={async () => { if (await act.confirm(`Remove ${b.info?.name} from Studio?`, 'Studio stops showing this board. Nothing on the board changes; you can add it again any time.', 'Remove')) { await remove(boardKey); onBack(); } }}>Remove from Studio</Button>
      </Stack>
      <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap alignItems="center">
        <Typography variant="body2" color="text.secondary">{b.online ? 'Connected' : 'Not answering (trying again)'} · {boardKind(b.info)}{manyTypes && b.firmware?.plan?.type_name ? ` · ${b.firmware.plan.type_name} firmware · ${boardPackageName(b.info, b.firmware.plan)}` : ''}{prefs.advanced ? ` · ${b.key} · ${b.info?.fw} ${b.info?.fw_version} (${b.info?.fw_build})` : ''}</Typography>
        <Chip color={fb.tone} label={fb.label} />
        <Chip color={sb.tone} label={sb.label} data-testid="script-badge" />
        <BoardScriptLink b={b} />
        {addr && <Typography variant="body2" color="text.secondary" data-testid="board-address">
          {addr.on ? `On “${addr.on}” this board is at ` : 'This board is at '}<Box component="span" sx={{ fontFamily: 'monospace', userSelect: 'all' }}>{addr.url}</Box>{addr.also ? ` (or ${addr.also})` : ''}
        </Typography>}
        {b.state?.paused && <Chip color="error" label="Stopped: triggers are ignored until you resume or restart it" />}
        {b.state?.paused && <Button variant="contained" onClick={() => act.resume([boardKey])} disabled={!b.online} title={RESUME_NOTE}>Resume</Button>}
        {b.state?.paused && <Typography variant="body2" color="text.secondary" data-testid="paused-help">{pauseHeld ? `Release the pause input ${String(pausePin.id).toUpperCase()} to go on.` : RESUME_NOTE}</Typography>}
        {canMake && !recordingEffect && <Button ref={makeButton} variant="contained" onClick={() => setMaking(true)} sx={{ ml: { sm: 'auto' } }}
          title="Pick what starts it and what turns on. It goes to this board, and you can try it here.">Make it do something…</Button>}
      </Stack>
      <RunCounts name={b.info?.name || boardKey} state={b.state} />
      {(fb.help || sb.help) && <Typography variant="body2" color="text.secondary">{[fb.help, sb.help].filter(Boolean).join(' ')}</Typography>}
      <FreshBanner b={b} />
      {b.otherDevice && <Alert severity="error" data-testid="other-device">{b.otherDevice} Studio sends it nothing (no actions, no page password) until this board answers there again; if the board moved, remove it and add it at its new address.</Alert>}
      <ActionMessage />
      {tryHint && (wide || shown === 'live') && <Alert severity="info" onClose={() => setTryHint('')} data-testid="try-hint" sx={{ fontSize: 'subtitle1.fontSize' }}>{tryHint}<TryNow b={b} outputs={tryOuts} /></Alert>}
      {act.busy[boardKey] && <Alert severity="info">{act.busy[boardKey]}</Alert>}
      {recordingEffect && <RecordEffect b={b} onSave={keepRecorded} onClose={() => { setRecording(false); setBackToMake(true); }} />}
      {recordingEffect && <LivePanel b={b} onWiring={setWiring} />}
      {!recordingEffect && (wide
        ? <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 2 }}>
            <Box sx={{ flex: 1, minWidth: 0 }}>{sections}</Box>
            <Splitter label="Live panel width" side="right" value={liveWidth} min={Math.round(260 * zf)} max={Math.round(720 * zf)} reset={Math.round(360 * zf)} onChange={(w) => setPrefs({ livePaneWidth: Math.round(w / zf) })} />
            <Paper component="aside" variant="outlined" aria-label="Live inputs and outputs" data-testid="live-pane"
              sx={{ width: liveWidth, flexShrink: 0, position: 'sticky', top: 0, maxHeight: (t) => `calc(100vh - ${t.spacing(26)})`, overflow: 'auto', p: 2, backgroundColor: (t) => t.palette.shell.sideBar }}>
              <Typography variant="overline" component="h3" color="text.secondary" sx={{ display: 'block', mb: 1 }}>Live</Typography>
              {live}
            </Paper>
          </Box>
        : sections)}
      {making && <NewEffect open onClose={() => setMaking(false)} onCreate={make} labels={labels} boardName={b.info?.name}
        onRecord={b.info?.capabilities?.includes('outputs') ? () => { setMaking(false); setTryHint(''); setRecording(true); } : undefined}
        replacing={b.script?.text ? (b.scriptStatus?.name || true) : undefined} />}
      {wiring && <WiringGuide topic={wiring} onClose={() => setWiring(null)} />}
    </Stack>
  );
}
