// Every way to reach a board, in plain words: find it on the network, type its address, join the board's own
// Wi-Fi, plug it in with USB, put firmware on a new board over USB, or try a practice board on this computer.
import { useState } from 'react';
import { Alert, Box, Button, CircularProgress, List, ListItemButton, ListItemText, MenuItem, Stack, TextField, Typography } from '@mui/material';
import Search from '@mui/icons-material/Search';
import Usb from '@mui/icons-material/Usb';
import Wifi from '@mui/icons-material/Wifi';
import Computer from '@mui/icons-material/Computer';
import { call } from '../api';
import { useStore } from '../store';
import { boardKind, connectError, practiceName } from '../words';
import { UsbInstall } from './FirmwareType';

/** What Studio says when a USB board on an ESP32 serial chip does not answer. */
export const BLANK_BOARD = "This board doesn't answer like a Specter board yet. It may have no Specter firmware. Put firmware on it?";

export default function AddBoard({ onAdded }: { onAdded?: (key: string) => void }) {
  const { connect, connectSerial, startSim, boards, prefs } = useStore();
  const [found, setFound] = useState<any[] | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [address, setAddress] = useState('');
  const [ports, setPorts] = useState<any[] | null>(null);
  const [port, setPort] = useState('');
  // a USB board that did not answer like a Specter board (it may have no firmware): offered the USB install
  const [blank, setBlank] = useState('');
  const [installPort, setInstallPort] = useState('');

  const run = async (what: string, f: () => Promise<string | void>) => {
    setBusy(what);
    setError('');
    try {
      const k = await f();
      if (k) onAdded?.(k);
    } catch (e: any) {
      setError(String(e.message || e));
    } finally {
      setBusy('');
    }
  };

  const nextPractice = () => practiceName(Object.values(boards).map((b) => b.info?.name || ''));

  return (
    <Stack spacing={2}>
      {error && <Alert severity="error" onClose={() => setError('')}>{error}</Alert>}
      <Box>
        <Button variant="contained" startIcon={busy === 'find' ? <CircularProgress size={18} /> : <Search />} disabled={!!busy}
          onClick={() => run('find', async () => setFound(await call('discover', { timeout_ms: 2000 })))}>
          Find boards on my network
        </Button>
        {found && (found.length === 0
          ? <Typography sx={{ mt: 1 }}>No boards answered. Check the board is on and on the same Wi-Fi, or try the other ways below.</Typography>
          : <List component="div" dense aria-label="Boards found">
            {found.map((f) => (
              <ListItemButton key={f.id + f.address} disabled={!!boards[f.address]} onClick={() => run('c', () => connect(f.address))}>
                <ListItemText primary={f.name || f.id} secondary={`${boardKind(f)}${prefs.advanced ? ` · ${f.address} · ${f.via}` : ''}${boards[f.address] ? ' · added' : ''}`} />
              </ListItemButton>
            ))}
          </List>)}
      </Box>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} component="form" onSubmit={(e) => { e.preventDefault(); void run('addr', () => connect(address.trim()).catch((e: any) => { throw new Error(connectError(String(e.message || e), address)); })); }}>
        <TextField label="Board address" placeholder="192.168.1.50 or front-door.local" value={address} onChange={(e) => setAddress(e.target.value)} sx={{ flexGrow: 1 }} />
        <Button type="submit" variant="outlined" disabled={!address || !!busy}>Add</Button>
      </Stack>
      <Box>
        <Button variant="outlined" startIcon={<Wifi />} disabled={!!busy} onClick={() => run('ap', () => connect('192.168.4.1'))}>
          Connect through the board's own Wi-Fi
        </Button>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
          Every board makes its own Wi-Fi called “Proptroller-…” (password: “password”), and it is always there, also while the board is on your Wi-Fi. Join it from this computer first, then press the button.
        </Typography>
      </Box>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'center' }}>
        <Button variant="outlined" startIcon={<Usb />} disabled={!!busy} onClick={() => run('ports', async () => { const p = await call('serial_ports'); setPorts(p); setPort(p[0]?.path || ''); })}>
          Plugged in with USB
        </Button>
        {ports && (ports.length === 0 ? <Typography>No USB boards found. Plug the board in and press again.</Typography> : <>
          <TextField select label="USB port" value={port} onChange={(e) => setPort(e.target.value)} sx={{ minWidth: 240 }}>
            {ports.map((p) => <MenuItem key={p.path} value={p.path}>{p.what} ({p.path})</MenuItem>)}
          </TextField>
          <Button variant="contained" disabled={!port || !!busy} onClick={() => { setBlank(''); void run('usb', () => connectSerial(port).catch((e: any) => {
            // no answer from a chip ESP32 boards use: most likely a board without Specter firmware
            if (ports.find((p) => p.path === port)?.esp_bridge) { setBlank(port); return ''; }
            throw e;
          })); }}>Connect</Button>
          <Button disabled={!port || !!busy} onClick={() => setInstallPort(port)}>Put firmware on a board (USB)</Button>
        </>)}
      </Stack>
      {blank && <Alert severity="info" action={<Button color="inherit" onClick={() => { setError(''); setInstallPort(blank); setBlank(''); }}>Put firmware on it…</Button>}>{BLANK_BOARD}</Alert>}
      <UsbInstall key={installPort || 'usb'} startPort={installPort || undefined} />
      <Box>
        <Button variant="outlined" startIcon={<Computer />} disabled={!!busy} onClick={() => run('sim', () => startSim(nextPractice()))}>
          Add a practice board (on this computer)
        </Button>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
          A practice board behaves like a real one, so you can try effects before you wire anything.
        </Typography>
      </Box>
    </Stack>
  );
}
