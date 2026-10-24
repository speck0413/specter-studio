// The firmware choice (firmware.ts, boardPackages.ts): a firmware image (the generic image per chip, or a type an
// allowed extension adds), a board package (the board's pin map: a preset built into the generic image, or a file
// an extension offers), and an optional profile and script. Used for a new board's install over USB and on a
// board's page (Change board package / setup…). Updates never use it: they follow the type the board reports.
import { useEffect, useState } from 'react';
import { Alert, Box, Button, Checkbox, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, ListItemText, MenuItem, Stack, TextField, Typography } from '@mui/material';
import Usb from '@mui/icons-material/Usb';
import { call, fileStampLocal, pickFolder } from '../api';
import { useStore } from '../store';
import { boardKind } from '../words';
import { boardOf, Catalog, DEFAULT_BOARD, firstFlashBoards, GENERIC, NO_FIRMWARE_YET, switchWords, typeName, typeOptions, TypeOption } from '../firmware';
import {
  BoardAnswer, BoardFiles, Choice, choiceName, DEFAULT_PRESET, fileArg, fileChoices, IMAGE_HAS_ITS_BOARD, KEEP, NO_FILES, NO_PACKAGES, NONE,
  AFTER_RESTART_LATER, packageArg, packageChoices, releasePresets, sendSetup, sendWhenBack, takesPackages, writesImage,
} from '../boardPackages';
import { useBoardActions } from './actions';

export function FirmwareTypeSelect({ options, value, onChange, label = 'Firmware image' }: { options: TypeOption[]; value: string; onChange: (fw: string) => void; label?: string }) {
  return (
    <TextField select label={label} value={options.some((o) => o.fw === value) ? value : ''} onChange={(e) => onChange(e.target.value)} sx={{ minWidth: 240 }}
      data-testid="firmware-type" SelectProps={{ renderValue: (v) => options.find((o) => o.fw === v)?.name || '' }}>
      {options.map((o) => (
        <MenuItem key={o.fw} value={o.fw} disabled={o.disabled}>
          <ListItemText primary={o.name} secondary={o.note || undefined} />
        </MenuItem>
      ))}
    </TextField>
  );
}

function ChoiceSelect({ label, choices, value, onChange, testid, disabled }: { label: string; choices: Choice[]; value: string; onChange: (v: string) => void; testid: string; disabled?: boolean }) {
  return (
    <TextField select label={label} value={choices.some((c) => c.value === value) ? value : ''} onChange={(e) => onChange(e.target.value)} sx={{ minWidth: 240 }}
      data-testid={testid} disabled={disabled} SelectProps={{ renderValue: (v) => choiceName(choices, String(v)) }}>
      {choices.map((c) => (
        <MenuItem key={c.value} value={c.value} disabled={c.disabled}>
          <ListItemText primary={c.name} secondary={c.note || undefined} />
        </MenuItem>
      ))}
    </TextField>
  );
}

/** Every type's list, merged by the device layer (reloaded when the sources change). */
function useCatalog(open: boolean) {
  const { firmwareArgs, prefs, plugins } = useStore();
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!open) return;
    setError('');
    call('firmware_catalog', firmwareArgs()).then(setCatalog).catch((e) => setError(String(e.message || e)));
  }, [open, firmwareArgs, prefs.releases, prefs.betas, prefs.pluginConsent, plugins]);
  return { catalog, error };
}

/** The board packages, profiles and scripts the allowed extensions offer (board_files). */
function useBoardFiles(open: boolean) {
  const { firmwareArgs, prefs, plugins } = useStore();
  const [files, setFiles] = useState<BoardFiles>(NO_FILES);
  useEffect(() => {
    if (!open) return;
    call('board_files', firmwareArgs()).then(setFiles).catch(() => setFiles(NO_FILES));
  }, [open, firmwareArgs, prefs.pluginConsent, plugins]);
  return files;
}

export interface SetupValue { pkg: string; profile: string; script: string; defaults: boolean }

/** The board package, profile and script dropdowns (and whether the package's own defaults apply). */
function SetupFields({ pkgChoices, files, value, onChange, why, showDefaults }: { pkgChoices: Choice[]; files: BoardFiles; value: SetupValue; onChange: (v: SetupValue) => void; why?: string; showDefaults?: boolean }) {
  const set = (k: Partial<SetupValue>) => onChange({ ...value, ...k });
  return (
    <Stack spacing={1} data-testid="board-setup-fields">
      {why ? <Typography color="text.secondary" data-testid="board-package-why">{why}</Typography>
        : <ChoiceSelect label="Board package" choices={pkgChoices} value={value.pkg} onChange={(pkg) => set({ pkg })} testid="board-package" />}
      {!why && showDefaults && value.pkg !== KEEP && (
        <FormControlLabel control={<Checkbox checked={value.defaults} onChange={(e) => set({ defaults: e.target.checked })} />}
          label="Also start with the board package's own settings, profile and script (Wi-Fi is kept)" />
      )}
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
        <ChoiceSelect label="Profile" choices={fileChoices(files.profiles)} value={value.profile} onChange={(profile) => set({ profile })} testid="board-profile" />
        <ChoiceSelect label="Script" choices={fileChoices(files.scripts)} value={value.script} onChange={(script) => set({ script })} testid="board-script" />
      </Stack>
    </Stack>
  );
}

const DEFAULT_CHOICE = `preset:${DEFAULT_PRESET.id}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A new board (no firmware yet, or firmware to replace) plugged in with USB: pick the firmware image, the kind of
 * board, the board package, profile and script, then where it is plugged in. */
export function UsbInstall({ startPort }: { startPort?: string } = {}) {
  // `startPort`: opened for a board on that USB port (one that did not answer like a Specter board)
  const [open, setOpen] = useState(!!startPort);
  const { catalog, error } = useCatalog(open);
  const files = useBoardFiles(open);
  const [fw, setFw] = useState(GENERIC);
  const [kindKey, setKindKey] = useState(''); // board package + chip (firmware.ts BoardKind)
  const [setup, setSetup] = useState<SetupValue>({ pkg: DEFAULT_CHOICE, profile: NONE, script: NONE, defaults: true });
  const [ports, setPorts] = useState<any[]>([]);
  const [drives, setDrives] = useState<any[]>([]);
  const [where, setWhere] = useState('');
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState<{ tone: 'success' | 'error' | 'warning'; text: string } | null>(null);
  const [installed, setInstalled] = useState<{ port: string; name: string } | null>(null);
  // the name and Wi-Fi network the board had before an install that replaced its file system (put back on request)
  const [putBack, setPutBack] = useState<{ boardKey: string; name: string; ssid: string } | null>(null);
  const { firmwareArgs, connectSerial, change, prefs, setPrefs } = useStore();
  const act = useBoardActions();

  // the board on its USB port after an install: an ESP32 restarts when the port opens and needs a moment
  const reconnect = async (port: string) => {
    for (let i = 0; i < 10; i++) {
      const key = await connectSerial(port).catch(async () => { await wait(1000); return ''; });
      if (key) return key;
    }
    throw new Error('the board does not answer on its USB port yet: plug it in again and use “Plugged in with USB”, then Change board package / setup… on its page');
  };
  // after a USB install of an extension's firmware: Studio connects there and asks before the factory reset (the
  // new firmware's defaults apply only on a fresh board)
  const fresh = async () => {
    if (!installed) return;
    setBusy('Connecting…');
    try {
      const key = await reconnect(installed.port);
      if (await act.startFresh(key, installed.name)) setInstalled(null);
    } catch (e: any) {
      setMsg({ tone: 'error', text: String(e.message || e) });
    } finally {
      setBusy('');
    }
  };

  const look = async () => {
    setPorts(await call('serial_ports').catch(() => []));
    setDrives(await call('bootsel_drives').catch(() => []));
  };
  useEffect(() => { if (open) void look(); }, [open]);

  const kinds = firstFlashBoards(catalog, fw);
  const kind = kinds.find((k) => k.key === kindKey);
  useEffect(() => { if (!kinds.some((k) => k.key === kindKey)) setKindKey((startPort && kinds.find((k) => k.mcu === 'esp32-devkit')?.key) || kinds[0]?.key || ''); }, [catalog, fw]); // eslint-disable-line react-hooks/exhaustive-deps
  const mcu = kind?.mcu || '';
  const esp = mcu === 'esp32-devkit';
  const generic = fw === GENERIC;
  // the generic image goes on any board with that chip: the board package says which board it is
  const kindLabel = (k: { mcu: string; boardName: string; board: string }) => (generic && k.board === DEFAULT_BOARD ? boardKind({ mcu: k.mcu }) : `${boardKind({ mcu: k.mcu })} · ${k.boardName}`);
  const places = esp ? ports.map((p) => ({ id: p.path, label: `${p.what} (${p.path})` })) : drives.map((d) => ({ id: d.path, label: `${d.what} (${d.path})` }));
  useEffect(() => { if (!places.some((p) => p.id === where)) setWhere((startPort && places.find((p) => p.id === startPort)?.id) || places[0]?.id || ''); }, [kindKey, ports, drives]); // eslint-disable-line react-hooks/exhaustive-deps
  const name = typeName(catalog, fw);
  const image = catalog?.images.find((i) => i.fw === fw && i.first_flash === true && i.mcu === mcu && boardOf(i) === kind?.board);
  const pkgChoices = packageChoices({ presets: releasePresets(image), files, mcu });
  const pkgName = choiceName(pkgChoices, setup.pkg);
  // a package file goes on with the firmware, in the board's file system (its settings and Wi-Fi are replaced)
  const withImage = generic && writesImage(setup.pkg);
  const extras = generic && (setup.pkg !== DEFAULT_CHOICE || setup.profile !== NONE || setup.script !== NONE);

  /** Before an install that replaces the file system: what is on the board now, if it answers (a backup in the
   * backups folder, and its name and Wi-Fi network to offer back afterwards). */
  const readBefore = async (): Promise<{ name: string; ssid: string; backup: string } | null> => {
    setBusy('Reading what is on the board…');
    const key = await connectSerial(where).catch(() => '');
    if (!key) return null;
    const backup = await call('backup', { key, folder: prefs.backups, now: fileStampLocal() }).catch(() => '');
    const info = await change(key, { op: 'info' }).catch(() => null);
    const params = await change(key, { op: 'get_params' }).catch(() => null);
    const ssid = (params?.result?.values || []).find((v: any) => v.key === 'wifi_ssid')?.value;
    return { name: String(info?.result?.name || ''), ssid: typeof ssid === 'string' ? ssid : '', backup: String(backup || '') };
  };

  /** After the image is on: the board package, profile and script over the same USB session, then the restart. */
  const setUp = async (port: string) => {
    setBusy('Connecting to the board over USB…');
    const key = await reconnect(port);
    const info = (await change(key, { op: 'info' }))?.result;
    const pkgs = takesPackages(info);
    if (!pkgs && setup.pkg !== DEFAULT_CHOICE) throw new Error(`the firmware is on, but it does not take board packages yet, so the board runs its built-in one. ${NO_PACKAGES}`);
    const plan = await call('board_setup', { ...firmwareArgs(), package: pkgs ? packageArg(setup.pkg, files) : null, defaults: true, profile: fileArg(setup.profile, files.profiles), script: fileArg(setup.script, files.scripts) });
    const r = await sendSetup((req) => change(key, req), plan.requests, setBusy);
    if (plan.restart_needed) {
      setBusy('Restarting the board…');
      const rb = await change(key, plan.reboot);
      if (!rb?.ok) throw new Error(`the board did not restart: ${rb?.error?.message || 'it gave no reason'}`);
      // the profile and script the package's defaults would have replaced at that boot
      if (!(await sendWhenBack((req) => change(key, req), plan.after_restart || [], setBusy))) throw new Error(`the board did not answer after its restart. ${AFTER_RESTART_LATER}`);
    }
    return r.warnings;
  };

  const install = async () => {
    setAsking(false);
    setMsg(null);
    try {
      const before = withImage && esp ? await readBefore() : null;
      setBusy('Writing the firmware… (this takes a minute or two)');
      const r = await call('usb_install', {
        ...firmwareArgs(), fw, board: kind?.board, mcu, confirm: true, ...(esp ? { port: where } : { drive: where }),
        ...(withImage ? { setup: { package: packageArg(setup.pkg, files), profile: fileArg(setup.profile, files.profiles), script: fileArg(setup.script, files.scripts) } } : {}),
      });
      const done = `The board has the ${r.type_name} firmware ${r.version}${r.prerelease ? ' (beta, a test version)' : ''}${withImage ? ` and the board package “${pkgName}”` : ''}.`;
      if (withImage) {
        // a profile or script too big to go in beside the package: sent once the board answers
        const after: any[] = Array.isArray(r.send_after) ? r.send_after : [];
        let key = '';
        if (esp && (after.length || (before && (before.name || before.ssid)))) {
          setBusy('Connecting to the board over USB…');
          key = await reconnect(where).catch(() => '');
        }
        if (after.length && key) await sendSetup((req) => change(key, req), after, setBusy);
        const late = after.length && !key ? ' The profile and script did not fit beside the board package: send them with “Change board package / setup…” on its page once it is connected.' : '';
        setMsg({ tone: late ? 'warning' : 'success', text: `${done} It starts with the board package's own settings now. Find it on your network, add it with “Plugged in with USB”, or join its own Wi-Fi.${before?.backup ? ' What it had before is saved in your backups folder.' : ''}${late}` });
        if (key && before && (before.name || before.ssid)) setPutBack({ boardKey: key, name: before.name, ssid: before.ssid });
      } else if (extras && esp) {
        const warnings = await setUp(where);
        setMsg({ tone: warnings.length ? 'warning' : 'success', text: `${done} It has ${setup.pkg !== DEFAULT_CHOICE ? `the board package “${pkgName}”` : 'your choices'} and restarts with them now.${warnings.length ? ` Note: ${warnings.join(' ')}` : ''}` });
      } else if (extras) {
        setMsg({ tone: 'warning', text: `${done} When it has started, plug it in with USB or find it on your network, then use “Change board package / setup…” on its page to send the profile and script.` });
      } else {
        setMsg({ tone: 'success', text: `${done} It starts it now. Find it on your network, add it with “Plugged in with USB”, or join its own Wi-Fi.` });
      }
      setInstalled(esp && !generic ? { port: where, name: r.type_name } : null);
    } catch (e: any) {
      setMsg({ tone: 'error', text: String(e.message || e) });
    } finally {
      setBusy('');
    }
  };

  if (!open) {
    return (
      <Box>
        <Button variant="outlined" startIcon={<Usb />} onClick={() => setOpen(true)}>Put firmware on a new board (USB)</Button>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>For a board that has no Proptroller firmware yet, or to start a board again with other firmware.</Typography>
      </Box>
    );
  }
  return (
    <Box data-testid="usb-install">
      <Typography variant="h6" component="h3" gutterBottom>Put firmware on a new board (USB)</Typography>
      {error && <Alert severity="error" sx={{ mb: 1 }}>{error}</Alert>}
      {!catalog && !error && <CircularProgress size={20} aria-label="Reading the firmware lists" />}
      {catalog && (
        <Stack spacing={1.5}>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
            <FirmwareTypeSelect options={typeOptions(catalog, { firstFlash: true })} value={fw} onChange={setFw} />
            <TextField select label="Kind of board" value={kind ? kindKey : ''} onChange={(e) => setKindKey(e.target.value)} sx={{ minWidth: 240 }} disabled={!kinds.length}>
              {kinds.map((k) => <MenuItem key={k.key} value={k.key}>{kindLabel(k)}</MenuItem>)}
            </TextField>
          </Stack>
          {!kinds.length && (
            // never a silent grey box: say there is nothing yet, and offer a folder of firmware files
            <Alert severity="info" data-testid="no-firmware-yet" action={<Button color="inherit" onClick={async () => { const d = await pickFolder('A folder with firmware files (proptroller-firmware.json)', prefs.releases); if (d) setPrefs({ releases: d }); }}>Choose a folder…</Button>}>
              {NO_FIRMWARE_YET}
            </Alert>
          )}
          <SetupFields pkgChoices={pkgChoices} files={files} value={setup} onChange={setSetup} why={generic ? undefined : IMAGE_HAS_ITS_BOARD} />
          {withImage && <Typography variant="body2" color="text.secondary" data-testid="usb-install-replaces">The board package goes on together with the firmware, so the board starts on its own pins at once. This replaces the board's settings, shows, script and Wi-Fi: Studio saves a backup first when the board answers, and offers to put its name and Wi-Fi back afterwards.</Typography>}
          {mcu && (
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'center' }}>
              {places.length
                ? <TextField select label={esp ? 'USB port' : 'Board in BOOTSEL mode'} value={where} onChange={(e) => setWhere(e.target.value)} sx={{ minWidth: 240 }}>
                  {places.map((p) => <MenuItem key={p.id} value={p.id}>{p.label}</MenuItem>)}
                </TextField>
                : <Typography>{esp ? 'No USB boards found. Plug the board in and look again.' : 'No Pico in BOOTSEL mode found. Hold its BOOTSEL button while you plug it in, then look again.'}</Typography>}
              <Button onClick={() => void look()}>Look again</Button>
            </Stack>
          )}
          <Stack direction="row" spacing={1} alignItems="center">
            <Button variant="contained" disabled={!mcu || !where || !!busy} startIcon={busy ? <CircularProgress size={18} /> : undefined} onClick={() => setAsking(true)}>Install</Button>
            <Button onClick={() => setOpen(false)} disabled={!!busy}>Close</Button>
            {busy && <Typography data-testid="usb-install-progress">{busy}</Typography>}
          </Stack>
        </Stack>
      )}
      {msg && <Alert severity={msg.tone} sx={{ mt: 1 }} data-testid="usb-install-message">{msg.text}</Alert>}
      {installed && <Button sx={{ mt: 1 }} color="warning" disabled={!!busy} onClick={() => void fresh()}>Start fresh with this firmware's defaults…</Button>}
      <Dialog open={asking} onClose={() => setAsking(false)} aria-labelledby="usb-install-title">
        <DialogTitle id="usb-install-title">Put the {name} firmware on this board?</DialogTitle>
        <DialogContent>
          <Typography gutterBottom>The firmware on the board ({kind ? kindLabel(kind) : ''}{where ? `, ${where}` : ''}) is replaced by the {name} firmware. Later updates follow the {name} firmware.</Typography>
          {withImage
            ? <Typography>It gets the board package “{pkgName}” at the same time. Its settings, shows, script and Wi-Fi are replaced by the board package's own: Studio saves a backup first when the board answers, and you can put its name and Wi-Fi back afterwards (you type the Wi-Fi password again).</Typography>
            : <Typography>Its stored settings and Wi-Fi stay on the board, and the new firmware uses what it can read.{extras ? ` Then Studio sends ${setup.pkg !== DEFAULT_CHOICE ? `the board package “${pkgName}”` : 'your choices'} over USB and restarts the board.` : ''}</Typography>}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setAsking(false)}>Cancel</Button>
          <Button variant="contained" onClick={() => void install()}>Install</Button>
        </DialogActions>
      </Dialog>
      {putBack && <PutBack {...putBack} onDone={(text) => { setPutBack(null); if (text) setMsg({ tone: 'success', text }); }} />}
    </Box>
  );
}

/** After an install that replaced the board's file system: put its old name and Wi-Fi network back (the person
 * types the Wi-Fi password again: backups never hold it, and Studio never shows it). */
function PutBack({ boardKey, name, ssid, onDone }: { boardKey: string; name: string; ssid: string; onDone: (text?: string) => void }) {
  const { change } = useStore();
  const [pass, setPass] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    setErr('');
    const values = [...(name ? [{ key: 'name', value: name }] : []), ...(ssid ? [{ key: 'wifi_ssid', value: ssid }, { key: 'wifi_pass', value: pass }] : [])];
    const r = await change(boardKey, { op: 'set_params', values }).catch((e: any) => ({ ok: false, error: { message: String(e.message || e) } }));
    setBusy(false);
    if (!r?.ok) return setErr(`The board did not take them: ${r?.error?.message || 'it gave no reason'}`);
    onDone(`${name || 'The board'} has its name${ssid ? ' and Wi-Fi network' : ''} back.`);
  };
  return (
    <Dialog open onClose={() => onDone()} aria-labelledby="put-back-title">
      <DialogTitle id="put-back-title">Put back the board's name and Wi-Fi?</DialogTitle>
      <DialogContent>
        <Typography gutterBottom>Before the install the board was called “{name || 'unnamed'}”{ssid ? ` and joined the Wi-Fi network “${ssid}”` : ''}.{ssid ? ' Type that network\'s password to put it back (Studio does not keep it).' : ''}</Typography>
        {ssid && <TextField type="password" label="Wi-Fi password" value={pass} onChange={(e) => setPass(e.target.value)} fullWidth autoComplete="off" sx={{ mt: 1 }} />}
        {err && <Alert severity="error" sx={{ mt: 1 }}>{err}</Alert>}
      </DialogContent>
      <DialogActions>
        <Button onClick={() => onDone()}>Not now</Button>
        <Button variant="contained" disabled={busy} onClick={() => void go()}>Put back</Button>
      </DialogActions>
    </Dialog>
  );
}

/** On a board's page: another board package, profile or script, sent over its connection (no flashing), then a
 * confirmed restart; or another firmware image (a type an extension adds), installed over Wi-Fi after a
 * confirmation. Start fresh is a separate, confirmed action. */
export function BoardSetup({ boardKey }: { boardKey: string }) {
  const { boards, change } = useStore();
  const act = useBoardActions();
  const b = boards[boardKey];
  const [open, setOpen] = useState(false);
  const { catalog, error } = useCatalog(open);
  const files = useBoardFiles(open);
  const current = b?.info?.fw || '';
  const pkgs = takesPackages(b?.info);
  const [fw, setFw] = useState(current);
  const [board, setBoard] = useState<BoardAnswer | null>(null);
  const [boardErr, setBoardErr] = useState('');
  const [setup, setSetup] = useState<SetupValue>({ pkg: KEEP, profile: NONE, script: NONE, defaults: true });
  const [forget, setForget] = useState(false);
  // a board on USB moving to the generic image: its name and Wi-Fi network (given back after the write)
  const [net, setNet] = useState<{ name: string; ssid: string } | null>(null);
  const [pass, setPass] = useState('');
  useEffect(() => {
    if (!open) return;
    setFw(current);
    setPass('');
    setNet(null);
    if (boardKey.startsWith('serial:')) change(boardKey, { op: 'get_params' }).then((p: any) => {
      const v = (k: string) => (p?.result?.values || []).find((x: any) => x.key === k)?.value;
      setNet({ name: String(b?.info?.name || v('name') || ''), ssid: typeof v('wifi_ssid') === 'string' ? v('wifi_ssid') : '' });
    }).catch(() => setNet({ name: String(b?.info?.name || ''), ssid: '' }));
    setSetup({ pkg: KEEP, profile: NONE, script: NONE, defaults: true });
    setForget(false);
    setBoard(null);
    setBoardErr('');
    if (pkgs) change(boardKey, { op: 'get_board' }).then((r: any) => (r?.ok ? setBoard(r.result) : setBoardErr(r?.error?.message || 'the board did not say'))).catch((e: any) => setBoardErr(String(e.message || e)));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  // a board on USB takes the USB install image of a type (through its port); over Wi-Fi the update image
  const usb = boardKey.startsWith('serial:');
  const options = typeOptions(catalog, { mcu: b?.info?.mcu, board: boardOf(b?.info), current, firstFlash: usb });
  const switching = !!fw && fw !== current;
  // another image only over the air, for a board that takes updates, when there is more than the stock one
  const images = !!b?.info?.update && (catalog?.types.length || 0) > 1;
  // on USB, the generic image goes on with its board package in the same write: picked here, before the install
  const usbGeneric = usb && switching && fw === GENERIC;
  const image = catalog?.images.find((i) => i.fw === GENERIC && i.first_flash === true && i.mcu === b?.info?.mcu);
  const pkgChoices = usbGeneric ? packageChoices({ presets: board?.presets?.length ? board.presets : releasePresets(image), files, mcu: b?.info?.mcu })
    : pkgs && board ? packageChoices({ board, files })  /* get_board's mcu: the chip a package must name */ : [];
  useEffect(() => { setSetup((v) => ({ ...v, pkg: usbGeneric ? DEFAULT_CHOICE : KEEP })); }, [usbGeneric]);
  const why = switching && !usbGeneric ? 'Pick the board package after the new firmware is on.' : usbGeneric ? undefined : !pkgs ? NO_PACKAGES : boardErr ? `The board did not say which board packages it has: ${boardErr}` : undefined;
  const changes = setup.pkg !== KEEP || setup.profile !== NONE || setup.script !== NONE;
  /** The package for the USB write: a file, the Proptroller board (a fresh file system), or another built-in one as
   * the board gives it now (get_board with `preset`). */
  const usbPackage = async (): Promise<any> => {
    const arg: any = packageArg(setup.pkg, files);
    if (!arg?.preset || arg.preset === DEFAULT_PRESET.id) return arg;
    const r = await change(boardKey, { op: 'get_board', preset: arg.preset }).catch(() => null);
    if (!r?.ok || !r.result?.package) throw new Error(`the board could not give its built-in board package “${choiceName(pkgChoices, setup.pkg)}”: choose a board package file or the Proptroller board`);
    return { inline: r.result.package };
  };
  const next = async () => {
    setOpen(false);
    if (switching) {
      const from = typeName(catalog, current), to = typeName(catalog, fw);
      const w = switchWords(b?.info?.name || boardKey, from, to);
      let usbSwitch: any;
      if (usbGeneric) {
        try {
          usbSwitch = { setup: { package: await usbPackage(), profile: fileArg(setup.profile, files.profiles), script: fileArg(setup.script, files.scripts) }, keep: net ? { name: net.name, ssid: net.ssid, pass } : undefined };
        } catch (e: any) {
          await act.confirm('The board package cannot go on', String(e.message || e), 'OK');
          return;
        }
        w.text += ` It gets the board package “${choiceName(pkgChoices, setup.pkg)}” in the same write, so it starts on the right pins at once; its settings and Wi-Fi are replaced, and Studio then gives it back its name${net?.ssid ? ' and Wi-Fi' : ''}.`;
      }
      if (await act.confirm(w.title, w.text, `Install ${to}`)) await act.switchFirmware(boardKey, fw, to, usbSwitch);
      return;
    }
    await act.setupBoard(boardKey, {
      package: pkgs ? packageArg(setup.pkg, files) : null, defaults: setup.defaults,
      profile: fileArg(setup.profile, files.profiles), script: fileArg(setup.script, files.scripts),
    }, choiceName(pkgChoices, setup.pkg));
  };
  return (
    <>
      <Button onClick={() => setOpen(true)} disabled={!b?.online}>Change board package / setup…</Button>
      <Dialog open={open} onClose={() => setOpen(false)} fullWidth maxWidth="sm" aria-labelledby="board-setup-title">
        <DialogTitle id="board-setup-title">Board package and setup of {b?.info?.name}</DialogTitle>
        <DialogContent>
          <Typography gutterBottom>This board runs the {typeName(catalog, current)} firmware{board ? ` with the board package “${board.running.source === 'none' ? 'none' : board.running.name}”` : ''}. Studio sends what you pick over its connection; nothing is flashed.</Typography>
          {board?.running.problem && <Alert severity="warning" sx={{ mb: 1 }}>{board.running.problem}</Alert>}
          {error && <Alert severity="error">{error}</Alert>}
          {!catalog && !error && <CircularProgress size={20} aria-label="Reading the firmware lists" />}
          {catalog && (
            <Stack spacing={1.5} sx={{ mt: 1 }}>
              {images && <FirmwareTypeSelect options={options} value={fw} onChange={setFw} />}
              {pkgs && !board && !boardErr && !switching ? <CircularProgress size={20} aria-label="Asking the board for its board packages" />
                : <SetupFields pkgChoices={pkgChoices} files={files} value={setup} onChange={setSetup} why={why} showDefaults={!usbGeneric} />}
              {usbGeneric && net?.ssid && (
                <TextField type="password" label={`Password of “${net.ssid}”`} value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="off"
                  helperText="The board package goes on with the firmware and replaces the Wi-Fi: type the password so Studio can give the board its network back (Studio does not keep it)." />
              )}
              {pkgs && <FormControlLabel control={<Checkbox checked={forget} onChange={(e) => setForget(e.target.checked)} />} label="When starting fresh, also forget the board package" />}
            </Stack>
          )}
        </DialogContent>
        <DialogActions>
          {/* a separate, confirmed action: the firmware the board runs now starts over with its own defaults */}
          <Button color="warning" sx={{ mr: 'auto' }} disabled={!catalog} onClick={() => { setOpen(false); void act.startFresh(boardKey, typeName(catalog, current), forget); }}>Start fresh with this firmware's defaults…</Button>
          <Button onClick={() => setOpen(false)}>Cancel</Button>
          <Button variant="contained" disabled={!catalog || (switching ? !!options.find((o) => o.fw === fw)?.disabled : !changes)} onClick={() => void next()}>{switching ? 'Next' : 'Send'}</Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
