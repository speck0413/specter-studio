// The show at a glance: every board with its runs tonight (since it was powered on), lifetime runs and when it
// last ran; the fleet's total for tonight; a live feed of runs and other events (from boards with a direct
// session and boards reporting to Studio's MQTT server), filterable, with pause and clear; and past nights.
// Desktop density like every view (src/theme.ts: small headers, 4 px steps, flat outlined surfaces); every colour
// comes from the theme, so it reads in all six themes.
import { useEffect, useMemo, useState } from 'react';
import { Box, Button, Card, CardContent, Chip, FormControl, InputLabel, MenuItem, Paper, Select, Stack, Tooltip, Typography } from '@mui/material';
import { call, onEvent } from '../api';
import { useStore } from '../store';
import { useNav } from '../nav';
import { boardKind, firmwareBadge, scriptBadge } from '../words';
import { useFeed } from '../dashboard/feed';
import { countsOf, FEED_TYPES, topicLabel, type FeedEvent, type FeedType } from '../dashboard/events';
import { groupNights, type Night } from '../dashboard/nights';
import RunCounts, { useNow } from '../dashboard/RunCounts';
import { CardFill, CardLook, TriggerFlash } from '../props/PropCard';

interface Tile { key: string; name: string; online: boolean; state: any; status?: any; kind: string; badges: { label: string; tone: any }[]; direct: boolean; label: string; script?: string; paramsSeq?: number }

/** Boards Studio talks to, and boards that only report over MQTT (once each). */
function useTiles(): Tile[] {
  const { boards } = useStore();
  const [fleet, setFleet] = useState<any[]>([]);
  useEffect(() => {
    const load = () => call('mqtt_boards').then((l) => setFleet(l || [])).catch(() => setFleet([]));
    void load();
    return onEvent((e: any) => { if (e.kind === 'fleet') void load(); });
  }, []);
  return useMemo(() => {
    const direct: Tile[] = Object.values(boards).map((b) => {
      const f = firmwareBadge(b), s = scriptBadge(b);
      return { key: b.key, name: b.info?.name || b.key, online: b.online, state: b.state, kind: boardKind(b.info), badges: [f, s], direct: true, label: topicLabel(b.info?.name || b.key), script: b.script?.text, paramsSeq: b.paramsSeq };
    });
    const labels = new Set(direct.map((t) => topicLabel(t.name)));
    const viaMqtt: Tile[] = fleet.filter((f) => !labels.has(topicLabel(f.name))).map((f) => ({
      key: f.key, name: f.state?.name || f.name, online: !!f.online, state: f.state, status: f.status, kind: 'reports over MQTT', badges: [], direct: false, label: topicLabel(f.name || f.state?.name || f.key),
    }));
    return [...direct, ...viaMqtt].sort((a, b) => a.name.localeCompare(b.name));
  }, [boards, fleet]);
}

export default function Dashboard() {
  const tiles = useTiles();
  const nav = useNav();
  const total = tiles.reduce((n, t) => n + (countsOf(t.state, t.status)?.tonight || 0), 0);
  const online = tiles.filter((t) => t.online).length;
  return (
    <Stack spacing={3}>
      <Stack direction="row" alignItems="center" spacing={2} flexWrap="wrap" useFlexGap>
        <Typography variant="h5" component="h2" sx={{ flexGrow: 1 }}>Dashboard</Typography>
        <Paper variant="outlined" sx={{ px: 1.5, py: 0.75 }} data-testid="fleet-tonight">
          <Typography variant="body2" color="text.secondary">Runs tonight, all boards</Typography>
          <Typography variant="h3" component="p" sx={{ fontVariantNumeric: 'tabular-nums' }} aria-label={`${total} runs tonight on all boards`}>{total}</Typography>
          <Typography variant="body2" color="text.secondary">{online} of {tiles.length} boards online</Typography>
        </Paper>
      </Stack>
      <Typography variant="body2" color="text.secondary">
        Tonight counts since each board was powered on. Lifetime runs are kept on the board, through restarts and firmware updates.
      </Typography>
      {tiles.length === 0 && <Typography>No boards yet. Add one on the Boards page, or let boards report to this computer (Settings).</Typography>}
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 240px), 1fr))', gap: 1 }} aria-label="Boards" role="list">
        {tiles.map((t) => (
          <Card key={t.key} variant="outlined" role="listitem" data-testid={`tile-${t.name}`} sx={{ position: 'relative', isolation: 'isolate' }}>
            <CardFill label={t.label} script={t.script} boardKey={t.direct ? t.key : undefined} paramsSeq={t.paramsSeq} name={t.name} />
            <TriggerFlash label={t.label} script={t.script} name={t.name} />
            <CardContent sx={{ p: 1.5, '&:last-child': { pb: 1.5 } }}>
              <Stack direction="row" alignItems="center" spacing={1}>
                <Box aria-hidden sx={{ width: 10, height: 10, borderRadius: '50%', flexShrink: 0, bgcolor: t.online ? 'success.main' : 'text.disabled' }} />
                <Typography variant="subtitle1" component="h3" sx={{ flexGrow: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}</Typography>
                <CardLook label={t.label} script={t.script} boardKey={t.direct ? t.key : undefined} paramsSeq={t.paramsSeq} size={20} />
                {t.direct && <Button size="small" onClick={() => nav.openBoard(t.key)} aria-label={`Open ${t.name}`}>Open</Button>}
              </Stack>
              <Typography variant="body2" color="text.secondary" gutterBottom>{t.online ? 'Online' : 'Offline'} · {t.kind}</Typography>
              <RunCounts name={t.name} state={t.state} status={t.status} compact />
              {!countsOf(t.state, t.status) && <Typography variant="body2" color="text.secondary">This board's firmware does not count runs: update it to see them.</Typography>}
              {t.badges.length > 0 && (
                <Stack direction="row" spacing={0.5} useFlexGap flexWrap="wrap" sx={{ mt: 1 }}>
                  {t.badges.map((b, i) => <Chip key={i} size="small" color={b.tone} label={b.label} variant={b.tone === 'default' ? 'outlined' : 'filled'} />)}
                </Stack>
              )}
            </CardContent>
          </Card>
        ))}
      </Box>
      <EventFeed boards={tiles.map((t) => t.name)} />
      <PastNights />
    </Stack>
  );
}

function EventFeed({ boards }: { boards: string[] }) {
  const f = useFeed();
  const [board, setBoard] = useState('');
  const [types, setTypes] = useState<Set<FeedType>>(new Set(FEED_TYPES.map((x) => x.type)));
  const [paused, setPaused] = useState<FeedEvent[] | null>(null);
  const shownFrom = paused ?? f.events;
  const list = shownFrom.filter((e) => (!board || e.board === board) && types.has(e.type)).slice(-300).reverse();
  const waiting = paused ? f.events.length - paused.length : 0;
  const names = [...new Set([...boards, ...f.events.map((e) => e.board)])].sort();
  const toggle = (t: FeedType) => setTypes((s) => { const n = new Set(s); if (n.has(t)) n.delete(t); else n.add(t); return n; });
  return (
    <Paper variant="outlined" sx={{ p: 1.5 }} component="section" aria-label="Event feed">
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mb: 1 }}>
        <Typography variant="h6" component="h3" sx={{ flexGrow: 1 }}>Events</Typography>
        <FormControl size="small" sx={{ minWidth: 160 }}>
          <InputLabel id="feed-board">Board</InputLabel>
          <Select labelId="feed-board" label="Board" value={board} onChange={(e) => setBoard(e.target.value)} inputProps={{ 'data-testid': 'feed-board' }}>
            <MenuItem value="">All boards</MenuItem>
            {names.map((n) => <MenuItem key={n} value={n}>{n}</MenuItem>)}
          </Select>
        </FormControl>
        <Button variant="outlined" onClick={() => setPaused(paused ? null : f.events)} aria-pressed={!!paused}>{paused ? `Resume${waiting > 0 ? ` (${waiting} new)` : ''}` : 'Pause'}</Button>
        <Button onClick={() => { f.clear(); setPaused(null); }}>Clear</Button>
      </Stack>
      <Stack direction="row" spacing={0.5} useFlexGap flexWrap="wrap" sx={{ mb: 1 }} role="group" aria-label="Show these events">
        {FEED_TYPES.map((x) => <Chip key={x.type} size="small" label={x.label} clickable onClick={() => toggle(x.type)} color={types.has(x.type) ? 'primary' : 'default'}
          variant={types.has(x.type) ? 'filled' : 'outlined'} aria-pressed={types.has(x.type)} />)}
      </Stack>
      {paused && <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>Paused: new events are kept and shown when you resume.</Typography>}
      <Box component="ol" aria-label="Events, newest first" data-testid="feed" sx={{ listStyle: 'none', p: 0, m: 0, maxHeight: 'max(240px, calc(100vh - 480px))', overflow: 'auto' }}>
        {list.map((e, i) => (
          <Box component="li" key={`${e.t}-${i}`} data-type={e.type} sx={{ display: 'flex', gap: 1.5, py: 0.25, borderBottom: 1, borderColor: 'divider', alignItems: 'baseline' }}>
            <Typography component="span" variant="body2" sx={{ fontFamily: 'monospace', color: 'text.secondary', flexShrink: 0 }}>{new Date(e.t).toLocaleTimeString()}</Typography>
            <Typography component="span" variant="body2" sx={{ fontWeight: 600, flexShrink: 0 }}>{e.board}</Typography>
            <Typography component="span" variant="body2" color={e.type === 'error' ? 'error' : undefined} sx={{ flexGrow: 1 }}>{e.text}</Typography>
            {e.type === 'run' && e.runs_tonight !== undefined && <Tooltip title="Runs tonight / lifetime runs on this board"><Typography component="span" variant="body2" color="text.secondary">#{e.runs_tonight} · {e.runs_lifetime?.toLocaleString()}</Typography></Tooltip>}
            {e.via === 'mqtt' && <Chip size="small" variant="outlined" label="MQTT" />}
          </Box>
        ))}
        {list.length === 0 && <li><Typography variant="body2" color="text.secondary">Nothing yet. Runs, boards coming online or going offline, settings changes and errors show up here as they happen.</Typography></li>}
      </Box>
    </Paper>
  );
}

function PastNights() {
  const { prefs } = useStore();
  const f = useFeed();
  const now = useNow(60000);
  const [list, setList] = useState<{ night: string }[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [detail, setDetail] = useState<Night[] | null>(null);
  useEffect(() => {
    if (prefs.workspace) call('nights_list', { folder: prefs.workspace }).then((l) => setList(l || [])).catch(() => setList([]));
  }, [prefs.workspace, now, f.cursor?.night]);
  useEffect(() => {
    if (!open || !prefs.workspace) { setDetail(null); return; }
    call('nights_read', { folder: prefs.workspace, night: open }).then((evs) => setDetail(groupNights(evs || []))).catch(() => setDetail([]));
  }, [open, prefs.workspace, f.cursor?.lastRun]);
  if (!prefs.workspace) return <Typography variant="body2" color="text.secondary">Choose your library folder (Settings) to keep a log of each night.</Typography>;
  return (
    <Paper variant="outlined" sx={{ p: 1.5 }} component="section" aria-label="Past nights">
      <Typography variant="h6" component="h3">Nights</Typography>
      <Typography variant="body2" color="text.secondary" gutterBottom>A night starts with the first run after four quiet hours and is named after its evening, so a show from 7 pm to 2 am is one night.</Typography>
      {list.length === 0 && <Typography variant="body2">No nights logged yet.</Typography>}
      <Stack direction="row" spacing={0.5} useFlexGap flexWrap="wrap">
        {list.map((n) => <Chip key={n.night} size="small" label={new Date(`${n.night}T12:00:00`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}
          clickable color={open === n.night ? 'primary' : 'default'} onClick={() => setOpen(open === n.night ? null : n.night)} data-testid={`night-${n.night}`} />)}
      </Stack>
      {open && detail && (
        <Box sx={{ mt: 1.5 }} data-testid="night-detail">
          {detail.length === 0 && <Typography variant="body2">No runs that night.</Typography>}
          {detail.map((n, i) => (
            <Box key={i} sx={{ mb: 1 }}>
              <Typography variant="body2" sx={{ fontWeight: 600 }}>{n.runs} runs, {new Date(n.first).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} to {new Date(n.last).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</Typography>
              <Box component="table" sx={{ borderCollapse: 'collapse', '& td': { pr: 3, py: 0.25 } }}>
                <tbody>{Object.entries(n.boards).sort((a, b) => b[1] - a[1]).map(([b, c]) => <tr key={b}><td>{b}</td><td>{c}</td></tr>)}</tbody>
              </Box>
            </Box>
          ))}
        </Box>
      )}
    </Paper>
  );
}
