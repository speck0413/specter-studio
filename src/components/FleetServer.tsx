// Studio as the fleet server: boards report to this computer (MQTT) and "Share with others" (a read-only page on
// the local network). Settings sections, plus the background work that starts them (and the connection to another
// server, set up under Automation) and feeds the shared page.
import { sectionSx } from './section';
import { useEffect, useRef, useState } from 'react';
import { Alert, Box, Button, FormControlLabel, Stack, Switch, TextField, Typography } from '@mui/material';
import { call } from '../api';
import { useStore } from '../store';
import { boardKind, firmwareBadge, scriptBadge } from '../words';
import { feed } from '../dashboard/feed';
import { countsOf, topicLabel } from '../dashboard/events';

import { bridgePrefs } from '../automation';

/** Starts what the person turned on, and keeps the shared page up to date. Mounted once (App). */
export function FleetServerWork() {
  const { prefs, boards } = useStore();
  const p = prefs as any;
  useEffect(() => {
    void (async () => {
      if (p.collect) await call('mqtt_start', { port: p.collectPort || 1883 }).catch(() => {});
      if (p.bridge?.on) await call('bridge_start', { ...bridgePrefs(p.bridge), secret: 'bridge-password' }).catch(() => {});
      if (p.share) {
        // the password is read from the keychain by the device layer (secret); older device layers took it here
        const password = await call('secret_get', { name: 'viewer-password' }).catch(() => null);
        await call('viewer_start', { port: p.sharePort || 8765, secret: 'viewer-password', ...(password ? { password } : {}) }).catch(() => {});
      }
    })();
    // once, at start; the Settings page starts and stops them afterwards
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // the shared page gets what Studio shows: on every change, and again every 3 s (a page that just opened, or a
  // sharing that just started, never waits for the next change)
  // worked out only while sharing is on (and then at most every 200 ms), never on every board change
  const boardsRef = useRef(boards);
  boardsRef.current = boards;
  const summary = () => Object.values(boardsRef.current).map((b) => {
    const f = firmwareBadge(b);
    const s = scriptBadge(b);
    const c = countsOf(b.state);
    return { name: b.info?.name || b.key, online: b.online, kind: boardKind(b.info), firmware: f.label, firmware_warn: f.tone === 'warning', script: s.label, script_warn: s.tone === 'warning',
      outputs: (b.state?.outputs || []).map((o: any) => ({ channel: o.alias || o.channel, level: o.level })),
      // the run counters and when it last ran (ms since 1970), for the shared page
      runs_tonight: c?.tonight ?? null, runs_lifetime: c?.lifetime ?? null, last_run: feed.lastRun[topicLabel(b.info?.name || b.key)]?.at ?? null };
  });
  const publish = () => { if (p.share) void call('viewer_publish', { boards: summary() }).catch(() => {}); };
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => { if (p.share && !pending.current) pending.current = setTimeout(() => { pending.current = null; publish(); }, 200); }, [boards, p.share]); // eslint-disable-line
  useEffect(() => () => { if (pending.current) clearTimeout(pending.current); }, []);
  useEffect(() => { const t = setInterval(publish, 3000); return () => clearInterval(t); }, [p.share]); // eslint-disable-line
  return null;
}

export default function FleetServerSettings() {
  const { prefs, setPrefs, boards, change } = useStore();
  const p = prefs as any;
  const [share, setShare] = useState<{ url?: string; error?: string } | null>(null);
  const [password, setPassword] = useState('');
  const [mq, setMq] = useState<any>(null);
  const [msg, setMsg] = useState<{ tone: 'success' | 'error' | 'info'; text: string } | null>(null);
  const refresh = () => call('mqtt_status').then(setMq).catch(() => setMq(null));
  useEffect(() => { void refresh(); const t = setInterval(refresh, 3000); return () => clearInterval(t); }, []);

  const toggleShare = async (on: boolean) => {
    if (!on) { await call('viewer_stop'); setPrefs({ share: false } as any); setShare(null); return; }
    try {
      // the password lives in the system keychain; Studio's device layer reads it there itself
      if (password) await call('secret_set', { name: 'viewer-password', value: password }).catch((e) => { setMsg({ tone: 'error', text: `The system keychain did not keep the password (${String(e.message || e)}). The page uses it until Studio closes.` }); });
      const r = await call('viewer_start', { port: p.sharePort || 8765, secret: 'viewer-password', ...(password ? { password } : {}) });
      setPrefs({ share: true, sharePort: r.port } as any);
      setShare({ url: r.url });
    } catch (e: any) { setShare({ error: String(e.message || e) }); }
  };
  const shareUrl = share?.url || (p.share ? `http://${mq?.address || 'this-computer'}:${p.sharePort || 8765}/` : '');

  const startCollect = async () => {
    try {
      const r = await call('mqtt_start', { port: p.collectPort || 1883 });
      setPrefs({ collect: true, collectPort: r.port } as any);
      await refresh();
    } catch (e: any) { setMsg({ tone: 'error', text: String(e.message || e) }); }
  };
  const pointHere = async (key: string) => {
    const r = await change(key, { op: 'set_params', values: [{ key: 'mqtt_broker', value: mq.address }, { key: 'mqtt_port', value: mq.port }] });
    setMsg(r.ok ? { tone: 'success', text: `${boards[key]?.info?.name} will report to this computer after it restarts.` } : { tone: 'error', text: r.error?.message || 'the board refused' });
  };
  return (
    <>
      <Box sx={sectionSx}>
        {msg && <Alert severity={msg.tone} onClose={() => setMsg(null)} sx={{ mb: 2 }}>{msg.text}</Alert>}
        <Typography variant="h6" component="h3">Share with others</Typography>
        <Typography color="text.secondary" gutterBottom>Anyone on this network can watch the boards (online, effect, firmware) from a phone or laptop. They cannot change anything.</Typography>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'center' }}>
          <FormControlLabel control={<Switch checked={!!p.share} onChange={(e) => void toggleShare(e.target.checked)} inputProps={{ 'aria-label': 'Share with others' }} />} label={p.share ? 'Sharing' : 'Not shared'} />
          {!p.share && <TextField type="password" label="View password (optional)" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />}
        </Stack>
        {p.share && shareUrl && <Typography sx={{ mt: 1 }}>Open <b data-testid="share-url">{shareUrl}</b> on the other device.</Typography>}
        {share?.error && <Alert severity="error" sx={{ mt: 1 }}>{share.error}</Alert>}
      </Box>
      <Box sx={sectionSx}>
        <Typography variant="h6" component="h3">Boards report to this computer</Typography>
        <Typography color="text.secondary" gutterBottom>Boards send their status here, even from another part of the building. Leave Studio open while the show runs.</Typography>
        {!mq ? <Stack direction="row" spacing={1} alignItems="center">
          {prefs.advanced && <TextField label="Port" type="number" size="small" value={p.collectPort || 1883} onChange={(e) => setPrefs({ collectPort: Number(e.target.value) } as any)} sx={{ width: 120 }} />}
          <Button variant="outlined" onClick={startCollect}>Start</Button>
        </Stack> : (
          <Stack spacing={1}>
            <Typography>Running: boards report to <b>{mq.address}</b>{prefs.advanced ? ` port ${mq.port} (MQTT)` : ''}.</Typography>
            {Object.values(boards).filter((b) => !b.sim && b.online).map((b) => (
              <Box key={b.key}><Button onClick={() => pointHere(b.key)}>Make {b.info?.name} report here</Button></Box>
            ))}
          </Stack>
        )}
      </Box>
    </>
  );
}
