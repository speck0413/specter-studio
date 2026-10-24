// Serial monitor and plotter, the Arduino way: pick the port (friendly names), the speed, and watch what the
// board prints; send a line; it reconnects by itself after a reset or an upload.
import { useEffect, useRef, useState } from 'react';
import { Alert, Box, Button, FormControlLabel, MenuItem, Stack, Switch, Tab, Tabs, TextField, Typography } from '@mui/material';
import Refresh from '@mui/icons-material/Refresh';
import { call, onEvent } from '../api';
import Plotter from '../components/Plotter';
import { useStore } from '../store';

const BAUDS = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];

export default function SerialMonitor() {
  const { prefs } = useStore();
  const [ports, setPorts] = useState<any[]>([]);
  const [drives, setDrives] = useState<any[]>([]);
  const [port, setPort] = useState('');
  const [baud, setBaud] = useState(115200);
  const [open, setOpen] = useState('');
  const [status, setStatus] = useState('');
  const [lines, setLines] = useState<{ t: number; text: string }[]>([]);
  const [stamps, setStamps] = useState(false);
  const [auto, setAuto] = useState(true);
  const [send, setSend] = useState('');
  const [tab, setTab] = useState('monitor');
  const [error, setError] = useState('');
  const box = useRef<HTMLDivElement>(null);

  const refresh = async () => {
    const p = await call('serial_ports').catch(() => []);
    setPorts(p);
    setDrives(await call('bootsel_drives').catch(() => []));
    if (!port && p[0]) setPort(p[0].path);
  };
  useEffect(() => { void refresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);
  useEffect(() => onEvent((e: any) => {
    if (e.kind !== 'serial' || e.path !== open) return;
    if (e.status) setStatus(e.status);
    else setLines((l) => [...l.slice(-1999), { t: Date.now(), text: e.line }]);
  }), [open]);
  useEffect(() => { if (auto && box.current) box.current.scrollTop = box.current.scrollHeight; }, [lines, auto]);
  useEffect(() => () => { if (open) void call('monitor_close', { path: open }); }, [open]);

  const connect = async () => {
    setError('');
    try {
      await call('monitor_open', { path: port, baud });
      setOpen(port);
      setStatus('connected');
    } catch (e: any) {
      setError(String(e.message || e));
    }
  };
  const disconnect = async () => { await call('monitor_close', { path: open }); setOpen(''); setStatus(''); };
  const sendLine = async () => { if (!send) return; await call('monitor_send', { path: open, line: send }); setLines((l) => [...l, { t: Date.now(), text: `> ${send}` }]); setSend(''); };
  const time = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour12: false }) + '.' + String(t % 1000).padStart(3, '0');

  return (
    <Stack spacing={2}>
      <Typography variant="h5" component="h2">Serial monitor</Typography>
      {!open && <Typography color="text.secondary" data-testid="serial-hint">Plug a board in with USB, pick its port and press Connect: what it prints shows up here, and the Plotter draws its numbers.</Typography>}
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={1} alignItems={{ md: 'center' }}>
        <TextField select label="Port" value={port} onChange={(e) => setPort(e.target.value)} sx={{ minWidth: 320 }} disabled={!!open}>
          {ports.map((p) => <MenuItem key={p.path} value={p.path}>{p.what} on {p.path}</MenuItem>)}
          {ports.length === 0 && <MenuItem value="" disabled>No boards plugged in</MenuItem>}
        </TextField>
        {prefs.advanced && <TextField label="Port path" value={port} onChange={(e) => setPort(e.target.value)} disabled={!!open} />}
        <Button startIcon={<Refresh />} onClick={refresh} disabled={!!open}>Look again</Button>
        <TextField select label="Speed (baud)" value={baud} onChange={(e) => setBaud(Number(e.target.value))} sx={{ minWidth: 140 }} disabled={!!open}>
          {BAUDS.map((b) => <MenuItem key={b} value={b}>{b}</MenuItem>)}
        </TextField>
        {open ? <Button variant="outlined" onClick={disconnect}>Disconnect</Button> : <Button variant="contained" onClick={connect} disabled={!port}>Connect</Button>}
        {status && <Typography role="status">{status}</Typography>}
      </Stack>
      {drives.map((d) => <Alert key={d.path} severity="info">{d.what} ({d.path}): ready for a first firmware upload.</Alert>)}
      {error && <Alert severity="error" onClose={() => setError('')}>{error}</Alert>}
      <Tabs value={tab} onChange={(_, v) => setTab(v)}>
        <Tab value="monitor" label="Monitor" />
        <Tab value="plot" label="Plotter" />
      </Tabs>
      {tab === 'monitor' && <>
        <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap">
          <FormControlLabel control={<Switch checked={stamps} onChange={(e) => setStamps(e.target.checked)} />} label="Show times" />
          <FormControlLabel control={<Switch checked={auto} onChange={(e) => setAuto(e.target.checked)} />} label="Scroll with new lines" />
          <Button onClick={() => setLines([])}>Clear</Button>
        </Stack>
        <Box ref={box} component="pre" aria-label="Serial output" aria-live="off" data-testid="serial-output"
          sx={{ m: 0, p: 2, height: 'max(320px, calc(100vh - 380px))', overflow: 'auto', bgcolor: 'action.hover', borderRadius: 1, fontSize: 'body1.fontSize', fontFamily: 'monospace' }}>
          {lines.map((l) => (stamps ? `${time(l.t)}  ${l.text}` : l.text)).join('\n')}
        </Box>
        <Stack direction="row" spacing={1} component="form" onSubmit={(e) => { e.preventDefault(); void sendLine(); }}>
          <TextField fullWidth label="Send a line" value={send} onChange={(e) => setSend(e.target.value)} disabled={!open} />
          <Button type="submit" variant="contained" disabled={!open || !send}>Send</Button>
        </Stack>
      </>}
      {tab === 'plot' && (open
        ? <><Typography color="text.secondary">Print numbers on each line, like “21.5 40” or “temp:21.5 hum:40”, and they are drawn here.</Typography><Plotter source={{ serial: open }} /></>
        : <Typography>Connect to a port first.</Typography>)}
    </Stack>
  );
}
