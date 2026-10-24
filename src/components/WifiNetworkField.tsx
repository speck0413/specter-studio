// The Wi-Fi network setting as an editable combo box (type a name, or pick one the board can see), for boards
// with the `wifi_scan` capability (PROTOCOL.md "Wi-Fi scan"). The board answers at once with the list it has and
// `scanning` while a new scan runs; Studio asks again every 1.5 s until it is done.
import { useEffect, useRef, useState } from 'react';
import { Autocomplete, Box, Button, Stack, TextField, Typography } from '@mui/material';
import { rpc } from '../api';
import { pickHint, scanStatus, signalBars, signalWords, WifiNetwork, WifiScan } from '../wifi';

const POLL_MS = 1500;
const POLL_FOR_MS = 20_000; // a scan times out on the board after 15 s

/** `savedSsid`/`passStored`: the network the board has and whether a password is stored for it. `onNetworks`: the
 * networks of each answer (Settings checks a new network's password against them before saving). */
type Props = {
  boardKey: string; label: string; value: string; help?: string; maxLength?: number; savedSsid: string; passStored: boolean;
  onChange: (v: string) => void; onNetworks?: (n: WifiNetwork[]) => void;
};

export default function WifiNetworkField({ boardKey, label, value, help, maxLength, savedSsid, passStored, onChange, onNetworks }: Props) {
  const [scan, setScan] = useState<WifiScan | null>(null);
  const [hint, setHint] = useState('');
  const [retryUntil, setRetryUntil] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const retryTimer = useRef<ReturnType<typeof setTimeout>>();
  const pollUntil = useRef(0);
  const run = useRef(0); // answers for another board, or after a newer ask, are dropped
  const asked = useRef(false);

  useEffect(() => {
    run.current++; asked.current = false; pollUntil.current = 0;
    setScan(null); setHint(''); setRetryUntil(0);
    return () => { run.current++; clearTimeout(timer.current); clearTimeout(retryTimer.current); };
  }, [boardKey]);

  const ask = async (rescan: boolean) => {
    clearTimeout(timer.current);
    const me = ++run.current;
    asked.current = true;
    let s: WifiScan;
    try {
      const r = await rpc(boardKey, rescan ? { op: 'wifi_scan', rescan: true } : { op: 'wifi_scan' });
      s = r.ok ? r.result : { networks: scan?.networks || [], error: r.error?.message || 'no answer' };
    } catch (e: any) {
      s = { networks: scan?.networks || [], error: String(e?.message || e) };
    }
    if (me !== run.current) return;
    setScan(s);
    onNetworks?.(s.networks);
    if (s.retry_ms) {
      setRetryUntil(Date.now() + s.retry_ms);
      clearTimeout(retryTimer.current);
      retryTimer.current = setTimeout(() => { if (me === run.current) setScan((x) => (x ? { ...x, retry_ms: undefined } : x)); setRetryUntil(0); }, s.retry_ms + 50);
    }
    if (s.scanning) {
      if (!pollUntil.current) pollUntil.current = Date.now() + POLL_FOR_MS;
      if (Date.now() < pollUntil.current) timer.current = setTimeout(() => void ask(false), POLL_MS);
    } else pollUntil.current = 0;
  };
  // the first look happens when the field is used, not on every visit to Settings (a real board's setup hotspot
  // pauses briefly while it scans)
  const first = () => { if (!asked.current) void ask(false); };

  const networks = scan?.networks || [];
  const waitRetry = retryUntil > Date.now();
  return (
    <Box>
      <Autocomplete<WifiNetwork, false, false, true>
        freeSolo
        options={networks}
        value={value}
        inputValue={value}
        filterOptions={(o) => o}
        getOptionLabel={(o) => (typeof o === 'string' ? o : o.ssid)}
        isOptionEqualToValue={(o, v) => o.ssid === (typeof v === 'string' ? v : v.ssid)}
        loading={!scan || !!scan.scanning}
        loadingText="Looking for networks…"
        noOptionsText={scanStatus(scan)}
        onOpen={first}
        onInputChange={(_e, v, reason) => { if (reason === 'input' || reason === 'clear') { onChange(v); setHint(''); } }}
        onChange={(_e, v) => {
          if (v && typeof v === 'object') { onChange(v.ssid); setHint(pickHint(v, passStored && v.ssid === savedSsid)); }
          else if (typeof v === 'string') onChange(v);
        }}
        renderOption={(props, n) => {
          const { key, ...rest } = props as any;
          return (
            <li key={key} {...rest} data-testid={`wifi-net-${n.ssid}`}>
              <Stack direction="row" spacing={2} sx={{ width: '100%', justifyContent: 'space-between' }}>
                <span>{n.ssid}</span>
                <Typography component="span" variant="body2" color="text.secondary">{`${signalBars(n.rssi)} ${signalWords(n.rssi)} · ${n.secured ? 'password' : 'open'}`}</Typography>
              </Stack>
            </li>
          );
        }}
        renderInput={(params) => (
          <TextField {...params} label={label} autoComplete="off" placeholder="type a name, or choose ▾" helperText={help}
            onFocus={first} inputProps={{ ...params.inputProps, maxLength }} />
        )}
      />
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 0.5 }}>
        <Typography variant="body2" color="text.secondary" role="status" data-testid="wifi-scan-status" sx={{ flexGrow: 1 }}>
          {asked.current ? scanStatus(scan) : 'Open the list to see the networks this board can find.'}
        </Typography>
        <Button size="small" disabled={!!scan?.scanning || waitRetry} onClick={() => void ask(asked.current)}>{asked.current ? 'Rescan' : 'Look for networks'}</Button>
      </Stack>
      {hint && <Typography variant="body2" color="text.secondary" aria-live="polite" data-testid="wifi-pick-hint">{hint}</Typography>}
    </Box>
  );
}
