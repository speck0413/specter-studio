// Where things are kept, where firmware releases come from (the official GitHub releases unless changed under
// Advanced), and the look.
import { useState } from 'react';
import { Alert, Box, Button, FormControlLabel, MenuItem, Stack, Switch, TextField, Typography } from '@mui/material';
import { call, pickFolder } from '../api';
import { useStore } from '../store';
import FleetServerSettings from '../components/FleetServer';
import { ScriptsRepoSettings } from '../components/ScriptsRepo';
import GitExtensions from '../components/GitExtensions';
import AutomationSettings from '../components/Automation';
import { sectionSx, sectionsSx } from '../components/section';
import { THEME_IDS, THEMES, ThemePref, ZOOM_CHOICES } from '../theme';
import { keyLabel } from '../shell/keys';
import { fingerprint, offersBoardFiles, perms } from '../components/pluginPerms';
import PluginConsent from '../components/PluginConsent';
import { ExtensionLogo } from '../props/icons';
import { waitingFirmwarePlugins, GENERIC_NAME } from '../firmware';

/** Theme and text size (also: the theme button in the top bar, the status bar, the command palette, Ctrl +/-). */
function Appearance() {
  const { prefs, setPrefs } = useStore();
  return (
    <Box sx={sectionSx} data-testid="appearance">
      <Typography variant="h6" component="h3">Look</Typography>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={3} sx={{ mt: 2 }}>
        <TextField select label="Theme" value={prefs.theme || 'system'} onChange={(e) => setPrefs({ theme: e.target.value as ThemePref })} sx={{ minWidth: 260 }}
>
          <MenuItem value="system">Follow the computer (Light or Dark)</MenuItem>
          {THEME_IDS.map((t) => <MenuItem key={t} value={t}>{THEMES[t].label}</MenuItem>)}
        </TextField>
        <TextField select label="Text size" value={prefs.zoom || 100} onChange={(e) => setPrefs({ zoom: Number(e.target.value) })} sx={{ minWidth: 160 }}>
          {ZOOM_CHOICES.map((z) => <MenuItem key={z} value={z}>{z} %{z === 100 ? ' (normal)' : ''}</MenuItem>)}
        </TextField>
      </Stack>
      <FormControlLabel sx={{ mt: 1 }} control={<Switch checked={prefs.triggerFlash !== false} onChange={(e) => setPrefs({ triggerFlash: e.target.checked })} data-testid="trigger-flash-setting" />}
        label="Dashboard: show an effect's icon over its board's card for a moment when it starts" />
      <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
        Bigger or smaller text anywhere: {keyLabel('Mod+=')} and {keyLabel('Mod+-')}, or hold {keyLabel('Mod')} and turn the mouse wheel; {keyLabel('Mod+0')} goes back to normal. Studio remembers both.
      </Typography>
    </Box>
  );
}

function FolderRow({ label, help, value, onPick }: { label: string; help: string; value: string; onPick: (v: string) => void }) {
  return (
    <Box sx={sectionSx}>
      <Typography variant="h6" component="h3">{label}</Typography>
      <Typography color="text.secondary" gutterBottom>{help}</Typography>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'center' }}>
        <Typography sx={{ fontWeight: 600, wordBreak: 'break-all', flexGrow: 1 }}>{value || 'not chosen'}</Typography>
        <Button variant="outlined" onClick={async () => { const f = await pickFolder(label, value); if (f) onPick(f); }}>Choose…</Button>
      </Stack>
    </Box>
  );
}

/** The firmware types besides the stock one: from allowed extensions, and the extensions that offer one but are
 * not allowed yet (Allow here: a firmware-only extension has no tab of its own to ask on). */
const offersAny = (p: any) => (Array.isArray(p.firmware) && p.firmware.length > 0) || offersBoardFiles(perms(p).boardFiles);

function FirmwareTypes() {
  const { prefs, setPrefs, plugins } = useStore();
  const [asking, setAsking] = useState<any>(null);
  const waiting = waitingFirmwarePlugins(plugins, prefs.pluginConsent);
  const offered = plugins.filter((p) => offersAny(p) && !waiting.includes(p));
  if (!offered.length && !waiting.length) return null;
  // its firmware types by name, then what else it offers for boards
  const names = (p: any) => {
    const b = perms(p).boardFiles;
    return [...(p.firmware || []).map((f: any) => f.name),
      ...(b.board_packages.length ? [`${b.board_packages.length} board package${b.board_packages.length === 1 ? '' : 's'}`] : []),
      ...b.profiles.map((f) => `the profile ${f.name}`), ...b.scripts.map((f) => `the script ${f.name}`)].join(', ');
  };
  return (
    <Box sx={{ mt: 2 }} data-testid="firmware-types">
      <Typography sx={{ fontWeight: 600 }}>Firmware types</Typography>
      <Typography color="text.secondary" gutterBottom>Each board gets the updates of the firmware it runs. {GENERIC_NAME} comes from the source above; extensions can add others, with their own lists. Extensions can also offer board packages, profiles and scripts. You choose them when you put firmware on a new board, or with “Change board package / setup…” on a board's page.</Typography>
      {offered.map((p) => <Stack key={p.id} direction="row" spacing={1} alignItems="center"><ExtensionLogo id={p.id} size={20} /><Typography>{names(p)}: from the extension “{p.name || p.id}”.</Typography></Stack>)}
      {waiting.map((p) => (
        <Stack key={p.id} direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'center' }}>
          <Typography>{names(p)}: offered by the extension “{p.name || p.id}”, not allowed yet.</Typography>
          <Button variant="outlined" onClick={() => setAsking(p)}>Allow…</Button>
        </Stack>
      ))}
      {/* the extension's whole consent screen: allowing it allows everything its plugin.json asks for */}
      {asking && <PluginConsent plugin={asking} onAnswer={(ok) => { if (ok) setPrefs({ pluginConsent: { ...(prefs.pluginConsent || {}), [asking.id]: fingerprint(asking) } }); setAsking(null); }} />}
    </Box>
  );
}

/** What the default release source is called on screen. */
export const OFFICIAL_RELEASES = 'the Specter Proptroller releases on GitHub';

export default function Settings() {
  const { prefs, setPrefs } = useStore();
  const [releases, setReleases] = useState(prefs.releases);
  const [msg, setMsg] = useState<{ tone: 'success' | 'info' | 'error'; text: string } | null>(null);
  const check = async (source: string, betas = prefs.betas === true) => {
    try {
      const m = await call('manifest', { source, betas, fresh: true });
      setPrefs({ releases: source });
      // kinds of board with an update (the USB first-flash images of the same boards are not more kinds)
      const kinds = new Set(m.images.filter((i: any) => i.first_flash !== true).map((i: any) => i.mcu)).size;
      // a pre-release with Allow betas off: no full release is out yet, so the test version is what there is
      const test = m.prerelease ? (betas ? ' It is a beta (a test version).' : ' It is a test version: no full release is out yet.') : '';
      setMsg({ tone: 'success', text: `Found firmware ${m.version} (${kinds} board type${kinds === 1 ? '' : 's'}).${test}` });
    } catch (e: any) {
      const text = String(e.message || e);
      if (text === 'there is no firmware release there yet') {
        // a real source with nothing published yet: keep it, Studio looks again later
        setPrefs({ releases: source });
        setMsg({ tone: 'info', text: 'No firmware release has been published there yet. Studio looks again from time to time.' });
      } else setMsg({ tone: 'error', text });
    }
  };
  const official = !prefs.releases;
  return (
    <Stack spacing={1}>
      <Typography variant="h5" component="h2">Settings</Typography>
      <Box sx={sectionsSx}>
      <Appearance />
      <FolderRow label="Your library folder" help="Your effects and your own firmware. Put it in a Dropbox, Google Drive or OneDrive folder to share it between computers."
        value={prefs.workspace} onPick={async (f) => setPrefs({ workspace: await call('workspace_init', { folder: f }) })} />
      <ScriptsRepoSettings />
      <FolderRow label="Backups folder" help="Where “Back up” saves each board's settings and effects." value={prefs.backups} onPick={(f) => setPrefs({ backups: f })} />
      <Box sx={sectionSx}>
        <Typography variant="h6" component="h3">Firmware updates</Typography>
        <Typography gutterBottom data-testid="release-source">
          {official ? <>New firmware comes from {OFFICIAL_RELEASES}.</> : <>New firmware comes from <Box component="span" sx={{ fontWeight: 600, wordBreak: 'break-all' }}>{prefs.releases}</Box>.</>}
        </Typography>
        <FormControlLabel control={<Switch checked={prefs.betas === true} data-testid="allow-betas"
          onChange={(e) => { setPrefs({ betas: e.target.checked }); void check(prefs.releases, e.target.checked); }} />}
          label="Allow betas (test versions before they are released)" />
        <Typography color="text.secondary" gutterBottom>Checking needs the internet. Without it, download a release folder on another computer and choose it here (turn on Advanced).</Typography>
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
          <Button variant="outlined" onClick={() => check(prefs.releases)}>Check now</Button>
          {!official && <Button onClick={() => { setReleases(''); void check(''); }}>Use the official releases</Button>}
        </Stack>
        {prefs.advanced && (
          <Box sx={{ mt: 2 }}>
            <Typography color="text.secondary" gutterBottom>Advanced: get firmware from somewhere else: a GitHub releases page, the web address of a release list (proptroller-firmware.json), or a folder that holds one.</Typography>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
              <TextField fullWidth label="Release list (web address or folder)" value={releases} placeholder="the official releases" onChange={(e) => setReleases(e.target.value)} />
              <Button variant="outlined" onClick={async () => { const f = await pickFolder('Folder with the firmware release', releases); if (f) setReleases(f); }}>Folder…</Button>
              <Button variant="contained" sx={{ whiteSpace: 'nowrap', flexShrink: 0 }} onClick={() => check(releases.trim())}>Use it</Button>
            </Stack>
          </Box>
        )}
        {msg && <Alert severity={msg.tone} sx={{ mt: 1 }}>{msg.text}</Alert>}
        <FirmwareTypes />
      </Box>
      <FleetServerSettings />
      <GitExtensions />
      <AutomationSettings />
      <Box sx={sectionSx}>
        <Typography variant="h6" component="h3" gutterBottom>Start again</Typography>
        <Button variant="outlined" onClick={() => setPrefs({ firstRunDone: false })}>Show the welcome steps again</Button>
      </Box>
      </Box>
    </Stack>
  );
}
