// A board's settings, with the labels, groups, ranges and help the board itself supplies. Secrets are typed,
// never shown or read back (empty = keep the old one).
import { useEffect, useRef, useState } from 'react';
import { optionWords } from '../words';
import { Alert, Box, Button, FormControlLabel, MenuItem, Stack, Switch, TextField, Typography } from '@mui/material';
import { rpc } from '../api';
import { settingsMeta, unsavedSettings } from '../drafts';
import { Board, useStore } from '../store';
import WifiNetworkField from './WifiNetworkField';
import { StartFreshSection } from './StartFresh';
import { needsPassword, WifiNetwork } from '../wifi';

// What a beginner sees: the name, what is connected where, Wi-Fi, the page lock and the sound volume. The rest
// (timings, roles, watchdogs, MQTT, DMX...) is under "More settings" and in Advanced mode.
const BEGINNER_KEYS = new Set(['name', 'page_lock', 'pin', 'wifi_ssid', 'wifi_pass', 'ambient_volume', 'trigger_volume', 'volume']);
const beginner = (p: any) => BEGINNER_KEYS.has(p.key) || p.group === 'Names';
// the board's own help texts are written for makers; in beginner mode the ones with technical words are left out
const TECHNICAL = /JSON|protocol|MQTT|DMX|\bACKs?\b|checksum|hash|baud|\bms\b|_|SHOW-SCRIPT|\.md\b|\bGPIO|PWM/i;

// changes not saved yet, per board: they survive going to another tab or page (never lose work), and closing
// the desktop window asks first
const unsaved = unsavedSettings;

/** A time the board keeps in milliseconds (unit ms, a key ending _ms): shown and typed in seconds. A profile's own
 * unit (an alias) stays as it is, like on the board's page. */
export const isMs = (p: any) => p?.type === 'int' && p.unit === 'ms' && /_ms$/.test(p.key);

export default function SettingsPanel({ b }: { b: Board }) {
  const { change, prefs, refreshFirmware } = useStore();
  const [more, setMore] = useState(false);
  const [needsRestart, setNeedsRestart] = useState(false);
  const [params, setParams] = useState<any[]>([]);
  const [values, setValues] = useState<Record<string, any>>({});
  const [stored, setStored] = useState<Record<string, boolean>>({}); // secrets: whether one is stored (newer firmware)
  const [edits, setEditsState] = useState<Record<string, any>>(() => unsaved.get(b.key) || {});
  const setEdits = (u: Record<string, any> | ((e: Record<string, any>) => Record<string, any>)) => setEditsState((old) => {
    const next = typeof u === 'function' ? u(old) : u;
    if (Object.keys(next).length) unsaved.set(b.key, next); else unsaved.delete(b.key);
    return next;
  });
  const [msg, setMsg] = useState<{ tone: 'success' | 'error' | 'info'; text: string } | null>(null);
  const [networks, setNetworks] = useState<WifiNetwork[]>([]); // what the board's last Wi-Fi scan saw
  const passInput = useRef<HTMLInputElement>(null);
  const load = async () => {
    const r = await rpc(b.key, { op: 'get_params' });
    if (!r.ok) return setMsg({ tone: 'error', text: r.error?.message || 'cannot read the settings' });
    setParams(r.result.params);
    const v: Record<string, any> = {};
    const isSet: Record<string, boolean> = {};
    for (const x of r.result.values) { v[x.key] = x.value; if (typeof x.set === 'boolean') isSet[x.key] = x.set; }
    setStored(isSet);
    setValues(v);
    // what unsaved edits started from (kept with them on disk, hotexit.ts); edits restored from last time keep theirs
    const old = settingsMeta.get(b.key);
    const typed = unsaved.get(b.key) || {};
    const kept = Object.fromEntries(Object.entries(old?.base || {}).filter(([k]) => k in typed));
    settingsMeta.set(b.key, { id: b.info?.id, name: b.info?.name, base: { ...v, ...kept }, secrets: r.result.params.filter((p: any) => p.secret).map((p: any) => p.key) });
  };
  useEffect(() => { setEditsState(unsaved.get(b.key) || {}); setNetworks([]); void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [b.key]);
  // changed elsewhere (the board's own page, another Studio, MQTT, a restore): the form shows the board's values
  // again; typed changes stay, and a typed one whose board value moved is pointed out (movedOn below)
  const seenSeq = useRef(b.paramsSeq || 0);
  useEffect(() => {
    if ((b.paramsSeq || 0) === seenSeq.current) return;
    seenSeq.current = b.paramsSeq || 0;
    if (saving.current) return; // our own save: it reloads by itself
    void load();
    setMsg({ tone: 'info', text: 'The board\'s settings were just changed somewhere else. This page now shows its new values.' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [b.paramsSeq]);
  const saving = useRef(false);

  const save = async () => {
    // a new network the board saw with a password, saved without one, would be joined as an open network (the
    // board drops the old password): say so and save nothing, as the board's own page does
    const locked = needsPassword(edits, values, networks);
    if (locked) {
      setMsg({ tone: 'error', text: `This network needs its password: type the password of “${locked}” in Wi-Fi password (leave it empty only for an open network). Nothing was saved.` });
      passInput.current?.focus();
      return;
    }
    // every change goes in one set_params, so a new network and its password arrive together
    const list = Object.entries(edits).map(([key, value]) => ({ key, value }));
    saving.current = true;
    const r = await change(b.key, { op: 'set_params', values: list }).finally(() => { setTimeout(() => { saving.current = false; }, 1000); });
    if (r.ok) {
      const reboot = params.some((p) => p.reboot && p.key in edits);
      setNeedsRestart(reboot);
      setMsg({ tone: 'success', text: reboot ? 'Saved. Some changes apply after the board restarts.' : 'Saved.' });
      setEdits({});
      await load();
      await refreshFirmware(b.key); // names and labels show at once
    } else setMsg({ tone: 'error', text: r.error?.message || 'the board refused' });
  };

  const pending = Object.keys(edits).length > 0;
  // edits restored from last time whose board value changed since they were typed
  const base = settingsMeta.get(b.key)?.base || {};
  const movedOn = Object.keys(edits).filter((k) => k in base && k in values && JSON.stringify(values[k]) !== JSON.stringify(base[k]));
  const labelOf = (k: string) => params.find((p) => p.key === k)?.label || k;
  const shown = prefs.advanced || more || b.adapter ? params : params.filter(beginner); // an adapter's device has only its own few settings
  const groups = [...new Set(shown.map((p) => p.group || 'Other'))];
  const val = (p: any) => (p.key in edits ? edits[p.key] : p.secret ? '' : values[p.key] ?? '');
  const set = (k: string, v: any) => setEdits((e) => ({ ...e, [k]: v }));
  // the board's help in plain words (beginners: without technical ones); a time in seconds says no unit here (the label has it)
  const helpOf = (p: any, secs: boolean) => [prefs.advanced || !TECHNICAL.test(p.help || '') ? p.help : '', !secs && p.unit && (prefs.advanced || p.unit !== 'ms') && `in ${p.unit}`, p.reboot && 'applies after a restart'].filter(Boolean).join(' · ');
  return (
    <Stack spacing={2}>
      {msg && <Alert severity={msg.tone} onClose={() => setMsg(null)} action={needsRestart ? <Button color="inherit" onClick={async () => { await change(b.key, { op: 'reboot' }); setNeedsRestart(false); setMsg({ tone: 'info', text: 'The board is restarting.' }); }}>Restart the board now</Button> : undefined}>{msg.text}</Alert>}
      {pending && <Alert severity="info">You have changes here that are not saved yet. Press Save settings to send them to the board.</Alert>}
      {movedOn.length > 0 && (
        <Alert severity="warning" data-testid="settings-moved-on" action={<Button color="inherit" onClick={() => setEdits((e) => Object.fromEntries(Object.entries(e).filter(([k]) => !movedOn.includes(k))))}>Use the board's values</Button>}>
          The board's own value changed since you typed these: {movedOn.map((k) => `${labelOf(k)} (the board now has ${String(values[k])}, you typed ${String(edits[k])})`).join('; ')}. Save settings uses yours.
        </Alert>
      )}
      {groups.map((g) => (
        <Box key={g} component="fieldset" sx={{ border: 1, borderColor: 'divider', borderRadius: 2, p: 2 }}>
          <Typography component="legend" sx={{ px: 1, fontWeight: 700 }}>{g}</Typography>
          <Stack spacing={2}>
            {shown.filter((p) => (p.group || 'Other') === g).map((p) => {
              const help = helpOf(p, false);
              if (p.type === 'bool') return (
                <Box key={p.key}>
                  <FormControlLabel control={<Switch checked={!!val(p)} onChange={(e) => set(p.key, e.target.checked)} />} label={p.label || p.key} />
                  {help && <Typography variant="body2" color="text.secondary">{help}</Typography>}
                </Box>
              );
              if (p.type === 'choice') return (
                <TextField key={p.key} select label={p.label || p.key} value={val(p)} helperText={help} onChange={(e) => set(p.key, e.target.value)}>
                  {(p.options || []).map((o: any) => { const v = typeof o === 'object' ? o.value : o; return <MenuItem key={v} value={v}>{typeof o === 'object' ? o.label || v : optionWords(p)[v] || v}</MenuItem>; })}
                </TextField>
              );
              if (isMs(p)) {
                // times the board keeps in milliseconds are shown and typed in seconds, as on the board's own page
                const v = val(p);
                const range = p.min !== undefined ? `${p.min / 1000} to ${p.max / 1000} s` : '';
                const noLimit = /max_on_ms$/.test(p.key) && !/no limit/i.test(p.help || '') ? '0 = no limit' : '';
                return (
                  <TextField key={p.key} type="number" label={`${p.label || p.key} (s)`} value={v === '' || v == null ? '' : Number(v) / 1000}
                    helperText={[helpOf(p, true), noLimit, range].filter(Boolean).join(' · ')}
                    inputProps={{ min: p.min !== undefined ? p.min / 1000 : undefined, max: p.max !== undefined ? p.max / 1000 : undefined, step: 'any', inputMode: 'decimal' }}
                    onChange={(e) => set(p.key, e.target.value === '' ? '' : Math.round(Number(e.target.value) * 1000))} />
                );
              }
              if (p.type === 'int') return (
                <TextField key={p.key} type="number" label={p.label || p.key} value={val(p)} helperText={[help, p.min !== undefined && `${p.min} to ${p.max}`].filter(Boolean).join(' · ')}
                  inputProps={{ min: p.min, max: p.max }} onChange={(e) => set(p.key, e.target.value === '' ? '' : Number(e.target.value))} />
              );
              // a board that can list the networks it sees: type a name, or pick one (the board's own page does the same)
              if (p.key === 'wifi_ssid' && b.info?.capabilities?.includes('wifi_scan')) return (
                <WifiNetworkField key={p.key} boardKey={b.key} label={p.label || p.key} value={String(val(p) ?? '')} help={help} maxLength={p.max_len}
                  savedSsid={String(values.wifi_ssid ?? '')} passStored={!!stored.wifi_pass} onChange={(v) => set(p.key, v)} onNetworks={setNetworks} />
              );
              // with a new network (a board that scans: firmware that drops the old password then) an empty password
              // means an open network, not "keep"
              const newNetwork = p.key === 'wifi_pass' && b.info?.capabilities?.includes('wifi_scan') && 'wifi_ssid' in edits && edits.wifi_ssid !== values.wifi_ssid;
              const secretHelp = newNetwork ? 'Type the password of the new network; leave it empty only for an open network.' : 'Type a new one to change it; leave empty to keep it.';
              return (
                <TextField key={p.key} type={p.secret ? 'password' : 'text'} label={p.label || p.key} value={val(p)} autoComplete="off"
                  inputRef={p.key === 'wifi_pass' ? passInput : undefined}
                  helperText={p.secret ? `${help ? help + ' · ' : ''}${p.key in stored ? (stored[p.key] ? '(set) ' : '(not set) ') : ''}${secretHelp}` : help}
                  inputProps={{ maxLength: p.max_len }} onChange={(e) => set(p.key, e.target.value)} />
              );
            })}
          </Stack>
        </Box>
      ))}
      {!prefs.advanced && <Box><Button onClick={() => setMore(!more)}>{more ? 'Fewer settings' : 'More settings (for experts)'}</Button></Box>}
      <Stack direction="row" spacing={1} sx={{ position: 'sticky', bottom: 8 }}>
        <Button variant="contained" disabled={!Object.keys(edits).length} onClick={save}>Save settings</Button>
        <Button disabled={!Object.keys(edits).length} onClick={() => setEdits({})}>Undo changes</Button>
      </Stack>
      {!b.adapter && <StartFreshSection b={b} />}
    </Stack>
  );
}
