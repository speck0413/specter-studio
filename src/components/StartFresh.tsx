// Start fresh where people look for it (freshStart.ts): a banner on a board's card and page when it runs another
// firmware or board package than Studio last saw, and a section in the board's Settings tab. Both open the same
// dialog: keep its name and Wi-Fi (on by default; the password typed again), forget the board package, and what the
// defaults hold when Studio can tell.
import { useEffect, useState } from 'react';
import { Alert, Box, Button, Checkbox, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, Stack, TextField, Typography } from '@mui/material';
import { call } from '../api';
import { Board, useStore } from '../store';
import { typeName } from '../firmware';
import { takesPackages } from '../boardPackages';
import { BoardDefaults, changeWords, defaultsWords, firmwareChange, hasDefaultsOp, keptKey, scriptQuestion, sigOf } from '../freshStart';
import { useBoardActions } from './actions';

const typeOf = (b: Board) => b.firmware?.plan?.type_name || typeName(null, b.info?.fw);

/** The banner: "This board now runs …", with Start fresh… and Keep mine. */
export function FreshBanner({ b, compact }: { b: Board; compact?: boolean }) {
  const { prefs, setPrefs, change } = useStore();
  const act = useBoardActions();
  const [asking, setAsking] = useState(false);
  const c = firmwareChange(prefs.firmwareSeen, prefs.freshKept, b.info);
  // the new firmware's own defaults (get_defaults): its script, asked about first
  const [defaults, setDefaults] = useState<BoardDefaults | null>(null);
  const [pkgName, setPkgName] = useState('');
  const sigKey = c ? keptKey(b.info.id, c.to) : '';
  useEffect(() => {
    setDefaults(null);
    if (!sigKey || !b.online || !hasDefaultsOp(b.info)) return;
    change(b.key, { op: 'get_defaults' }).then((r: any) => { if (r?.ok) setDefaults(r.result); }).catch(() => {});
    if (takesPackages(b.info)) change(b.key, { op: 'get_board' }).then((r: any) => { if (r?.ok && r.result.running?.source !== 'none') setPkgName(r.result.running.name); }).catch(() => {});
  }, [sigKey, b.online]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!c || b.adapter) return null;
  // what is new: the firmware type, or (same type) the board package
  const subject = c.typeChanged ? typeOf(b) : pkgName || c.to.board;
  const w = changeWords(c, typeOf(b), pkgName || undefined);
  const q = scriptQuestion(defaults, subject);
  const keep = () => {
    const s = sigOf(b.info)!;
    setPrefs({ freshKept: { ...(prefs.freshKept || {}), [keptKey(b.info.id, s)]: true }, firmwareSeen: { ...(prefs.firmwareSeen || {}), [b.info.id]: s } });
  };
  return (
    <>
      {q ? (
        // the focused question first: the new firmware's script or the board's own; the full Start fresh second
        <Alert severity="info" data-testid="fresh-banner" data-board={b.info?.name} sx={compact ? { mt: 1, py: 0 } : undefined}
          action={<Stack direction={compact ? 'column' : 'row'} spacing={0.5}>
            <Button color="inherit" size="small" variant="outlined" onClick={() => void act.useDefaultScript(b.key, subject, defaults!)} disabled={!b.online}>{q.use}</Button>
            <Button color="inherit" size="small" onClick={keep}>{q.keep}</Button>
            <Button color="inherit" size="small" onClick={() => setAsking(true)} disabled={!b.online}>{w.fresh}</Button>
          </Stack>}>
          {q.text}{q.also ? ` Using it also brings${q.also}.` : ''} Your other settings, Wi-Fi and name stay.
        </Alert>
      ) : (
        <Alert severity="info" data-testid="fresh-banner" data-board={b.info?.name} sx={compact ? { mt: 1, py: 0 } : undefined}
          action={<Stack direction={compact ? 'column' : 'row'} spacing={0.5}>
            <Button color="inherit" size="small" onClick={() => setAsking(true)} disabled={!b.online}>{w.fresh}</Button>
            <Button color="inherit" size="small" onClick={keep}>{w.keep}</Button>
          </Stack>}>
          {w.text}
        </Alert>
      )}
      {asking && <StartFreshDialog b={b} onClose={() => setAsking(false)} />}
    </>
  );
}

/** The board's Settings tab: Start fresh, always there. */
export function StartFreshSection({ b }: { b: Board }) {
  const [asking, setAsking] = useState(false);
  return (
    <Box component="fieldset" sx={{ border: 1, borderColor: 'divider', borderRadius: 2, p: 2 }} data-testid="start-fresh-section">
      <Typography component="legend" sx={{ px: 1, fontWeight: 700 }}>Start fresh</Typography>
      <Typography gutterBottom>Puts back this firmware's default settings and script{takesPackages(b.info) ? ' (and its board package\'s)' : ''}: for a board that came from other firmware, or to undo everything at once.</Typography>
      <Button variant="outlined" color="warning" disabled={!b.online} onClick={() => setAsking(true)}>Start fresh (this firmware's default settings and script)…</Button>
      {asking && <StartFreshDialog b={b} onClose={() => setAsking(false)} />}
    </Box>
  );
}

/** The options, then the confirmation (actions.startFresh). */
function StartFreshDialog({ b, onClose }: { b: Board; onClose: () => void }) {
  const { change, firmwareArgs } = useStore();
  const act = useBoardActions();
  const pkgs = takesPackages(b.info);
  // firmware with `defaults` keeps the name and Wi-Fi itself (factory_reset keep_wifi): no password to type
  const selfKeeps = hasDefaultsOp(b.info);
  const [keep, setKeep] = useState(true);
  const [forget, setForget] = useState(false);
  const [pass, setPass] = useState('');
  const [net, setNet] = useState<{ name: string; ssid: string } | null>(null);
  const [pkg, setPkg] = useState<{ name: string; holds: string } | null>(null);
  useEffect(() => {
    void (async () => {
      const p = await change(b.key, { op: 'get_params' }).catch(() => null);
      const v = (k: string) => (p?.result?.values || []).find((x: any) => x.key === k)?.value;
      setNet({ name: String(b.info?.name || v('name') || ''), ssid: typeof v('wifi_ssid') === 'string' ? v('wifi_ssid') : '' });
      if (!pkgs) return;
      const g = await change(b.key, { op: 'get_board' }).catch(() => null);
      const running = g?.ok ? g.result.running : null;
      if (!running || running.source === 'none') return;
      // an extension's package file with the same id: Studio can say what its defaults hold
      const files = await call('board_files', firmwareArgs()).catch(() => null);
      const f = (files?.packages || []).find((x: any) => x.id === running.id && !x.error);
      setPkg({ name: running.name, holds: defaultsWords(f?.defaults) });
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const go = async () => {
    onClose();
    await act.startFresh(b.key, typeOf(b), pkgs && forget, keep && net ? { name: net.name, ssid: net.ssid, pass } : undefined);
  };
  return (
    <Dialog open onClose={onClose} aria-labelledby="start-fresh-title" fullWidth maxWidth="sm">
      <DialogTitle id="start-fresh-title">Start {b.info?.name} fresh</DialogTitle>
      <DialogContent>
        <Stack spacing={1.5}>
          <Typography>The board erases its settings, shows and effect script and starts with what the {typeOf(b)} firmware{pkg && !forget ? ` and its board package “${pkg.name}”` : ''} set up on a new board.</Typography>
          {pkg && !forget && <Typography color="text.secondary" data-testid="fresh-defaults">{pkg.holds ? `The board package's own defaults: ${pkg.holds}.` : 'The board package brings its own defaults, if it has any.'}</Typography>}
          <FormControlLabel control={<Checkbox checked={keep} onChange={(e) => setKeep(e.target.checked)} />} label="Keep its name and Wi-Fi" />
          {keep && net?.ssid && !selfKeeps && (
            <TextField type="password" label={`Password of “${net.ssid}”`} value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="off"
              helperText="Studio does not keep Wi-Fi passwords: type it so the board can join again (leave it empty only for an open network)." />
          )}
          {keep && <Typography variant="body2" color="text.secondary">{selfKeeps
            ? 'The board keeps them itself (and its Wi-Fi password) and comes back on your network.'
            : 'Studio gives them back once the board answers again: always over USB; over Wi-Fi only if it can still reach the board.'}</Typography>}
          {pkgs && <FormControlLabel control={<Checkbox checked={forget} onChange={(e) => setForget(e.target.checked)} />} label="Also forget the board package (back to the built-in one)" />}
          {!b.online && <Alert severity="warning">The board is not answering right now.</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" color="warning" disabled={!b.online || !net} onClick={() => void go()}>Next</Button>
      </DialogActions>
    </Dialog>
  );
}
