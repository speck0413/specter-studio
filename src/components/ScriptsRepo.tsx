// Script sources on screen: the Settings section (add a source, Save new scripts here, Auto save per source),
// Get latest / Back up everything for all sources and per source, the status bar item, the palette commands,
// the "where should this be saved?" question and the one dialog for anything git cannot sort out by itself.
// The work is in the core (core/src/sources.rs, core/src/gitsync.rs).
import { useEffect, useMemo, useState } from 'react';
import { Alert, Box, Button, Checkbox, Chip, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, FormControl, IconButton, Radio, RadioGroup, Stack, Switch, TextField, Tooltip, Typography } from '@mui/material';
import CloudDownload from '@mui/icons-material/CloudDownload';
import CloudUpload from '@mui/icons-material/CloudUpload';
import { call, onEvent } from '../api';
import { useStore } from '../store';
import { useNav } from '../nav';
import { useBoardActions } from './actions';
import { saveNewEffect } from '../library';
import { sectionSx } from './section';
import type { Command } from '../shell/CommandPalette';
import {
  applyAnswer, AUTO_SAVE_QUIET_TEXT, Destination, getRepoState, RepoAnswer, RepoState, setDestinationChooser, setRepoState, SourcePrefs,
  SourceStatus, sourceLine, STATUS_REFRESH_MS, statusLine, subscribeRepo, writable,
} from '../scriptsRepo';

export function useRepoState(): RepoState {
  const [s, set] = useState(getRepoState());
  useEffect(() => subscribeRepo(set), []);
  return s;
}

export async function refreshSources(folder: string) {
  if (!folder) return;
  try {
    const sources = await call('sources_list', { folder });
    setRepoState((s) => ({ ...s, sources }));
  } catch { /* the device service is away: the next refresh tries again */ }
}

/** Get latest / Back up everything for one source (`id`) or all of them, one operation at a time. */
async function runSources(folder: string, op: 'get' | 'backup', id?: string): Promise<RepoAnswer | null> {
  if (!folder || getRepoState().busy) return null;
  setRepoState((s) => ({ ...s, busy: `${op}:${id || '*'}`, done: '' }));
  let a: RepoAnswer;
  try {
    a = await call(op === 'get' ? 'sources_get_latest' : 'sources_backup', { folder, ...(id ? { id } : {}) });
  } catch (e: any) {
    a = { ok: false, message: String(e.message || e) };
  }
  setRepoState((s) => applyAnswer({ ...s, busy: '' }, a, false));
  await refreshSources(folder);
  return a;
}

function useSourceActions() {
  const { prefs, bumpLibrary } = useStore();
  const folder = prefs.workspace;
  return {
    getLatest: async (id?: string) => { const a = await runSources(folder, 'get', id); if (a?.changed !== false) bumpLibrary(); },
    backup: async (id?: string) => { const a = await runSources(folder, 'backup', id); if (a?.changed) bumpLibrary(); },
  };
}

/** Get latest and Back up everything for every source (Settings, Your library's side bar). */
export function ScriptsRepoButtons({ stacked }: { stacked?: boolean }) {
  const s = useRepoState();
  const act = useSourceActions();
  if (!s.sources.length) return null;
  const canBackUp = writable(s.sources).length > 0;
  return (
    <Stack direction={stacked ? 'column' : { xs: 'column', sm: 'row' }} spacing={1} data-testid="scripts-repo-buttons">
      <Button variant="outlined" fullWidth={stacked} disabled={!!s.busy} onClick={() => void act.getLatest()}>{s.busy === 'get:*' ? 'Getting the latest…' : 'Get latest'}</Button>
      {canBackUp && <Button variant="outlined" fullWidth={stacked} disabled={!!s.busy} onClick={() => void act.backup()}>{s.busy === 'backup:*' ? 'Backing up…' : 'Back up everything'}</Button>}
    </Stack>
  );
}

/** One source's own two buttons (small, beside its group in the library's side bar). */
export function SourceButtons({ source }: { source: SourceStatus }) {
  const s = useRepoState();
  const act = useSourceActions();
  return (
    <Box component="span" sx={{ display: 'inline-flex' }}>
      <Tooltip title={`Get latest for ${source.id}`}><span><IconButton size="small" aria-label={`Get latest for ${source.id}`} disabled={!!s.busy} onClick={() => void act.getLatest(source.id)}><CloudDownload fontSize="small" /></IconButton></span></Tooltip>
      {!source.read_only && <Tooltip title={`Back up ${source.id}`}><span><IconButton size="small" aria-label={`Back up ${source.id}`} disabled={!!s.busy} onClick={() => void act.backup(source.id)}><CloudUpload fontSize="small" /></IconButton></span></Tooltip>}
    </Box>
  );
}

const sourcePrefs = (p: any): SourcePrefs => p.scriptSources || {};

/** Settings: the script sources. One field to add the first (the usual case); more under Advanced. */
export function ScriptsRepoSettings() {
  const { prefs, setPrefs, bumpLibrary } = useStore();
  const act = useBoardActions();
  const s = useRepoState();
  const [text, setText] = useState('');
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<{ source: SourceStatus; anyway: boolean } | null>(null);
  const folder = prefs.workspace;
  const sp = sourcePrefs(prefs);
  const setSp = (p: Partial<SourcePrefs>) => setPrefs({ scriptSources: { ...sp, ...p } });
  useEffect(() => { void refreshSources(folder); }, [folder]);
  const list = s.sources;
  const showAdd = list.length === 0 || prefs.advanced;

  const add = async () => {
    if (!folder || !text.trim() || adding) return;
    let pv: any;
    try {
      pv = await call('sources_preview', { folder, source: text.trim() });
    } catch (e: any) {
      setRepoState((st) => applyAnswer(st, { ok: false, message: String(e.message || e) }, false));
      return;
    }
    if (!(await act.confirm('Add this script source?', `Studio copies ${pv.url} (using the sign-in saved on this computer) into ${pv.path}. Its scripts show in Your library under “${pv.folder}”. Nothing in your library is changed or deleted.`, 'Add'))) return;
    setAdding(true);
    setRepoState((st) => ({ ...st, busy: 'add', done: '' }));
    try {
      const a = await call('sources_add', { folder, source: text.trim() });
      setRepoState((st) => applyAnswer({ ...st, busy: '', sources: a.sources || st.sources }, a, false));
      if (a.ok) {
        setText('');
        // the first writable source becomes the place for new scripts
        const added = (a.sources || []).find((x: SourceStatus) => x.id === a.id);
        if (!sp.saveNew && added && !added.read_only) setSp({ saveNew: a.id });
        bumpLibrary();
        await offerCopy(a.id, added);
      }
    } finally {
      setAdding(false);
      setRepoState((st) => ({ ...st, busy: '' }));
    }
  };
  // Remove: Studio's copy of the source only; changes not backed up keep it, unless "delete anyway" is ticked
  const remove = async (x: SourceStatus, anyway: boolean) => {
    setRemoving(null);
    try {
      const r = await call('sources_remove', { folder, id: x.id, anyway });
      if (!r.removed) {
        setRepoState((st) => applyAnswer(st, { ok: false, message: `“${x.id}” has ${r.changes} change${r.changes === 1 ? '' : 's'} not backed up, so it was not removed. Back it up first, or tick “Delete anyway”.` }, false));
        return;
      }
      setSp({ auto: (sp.auto || []).filter((i) => i !== x.id), saveNew: sp.saveNew === x.id ? undefined : sp.saveNew });
      setRepoState((st) => ({ ...st, done: `Removed “${x.id}” from your library. The repository itself is untouched.` }));
      bumpLibrary();
      await refreshSources(folder);
    } catch (e: any) {
      setRepoState((st) => applyAnswer(st, { ok: false, message: String(e.message || e) }, false));
    }
  };
  // the library's own scripts stay where they are; they can be copied into the new source (never moved)
  const offerCopy = async (id: string, added?: SourceStatus) => {
    if (!added || added.read_only) return;
    const lib: any[] = await call('library_list', { folder }).catch(() => []);
    const own = lib.filter((e) => !e.source);
    if (!own.length) return;
    if (!(await act.confirm(`Copy your ${own.length} script${own.length === 1 ? '' : 's'} into “${id}”?`, `Your library has ${own.length} script${own.length === 1 ? '' : 's'} of its own (not in a source). Copying puts a copy of each into “${id}”, so the next backup sends them to the repository. The originals stay where they are.`, 'Copy them'))) return;
    for (const e of own) await saveNewEffect(folder, e.name, await call('library_read', { folder, name: e.name }), { dest: id });
    bumpLibrary();
    await refreshSources(folder);
  };

  return (
    <Box sx={sectionSx} data-testid="scripts-repo">
      <Typography variant="h6" component="h3">Scripts repository</Typography>
      <Typography color="text.secondary" gutterBottom>
        Keep your effect scripts on GitHub, GitLab, Bitbucket or your own server: get the latest from there and back everything up to it.
        Studio uses the sign-in already saved on this computer (by GitHub Desktop or a similar app). It never asks for or keeps a password or token.
        For anything more, use GitHub Desktop or a similar app.{prefs.advanced ? ' (Studio runs the git program on this computer, with your own settings.)' : ''}
      </Typography>
      {list.map((x) => (
        <Box key={x.id} data-testid={`source-${x.id}`} sx={{ py: 1, borderTop: 1, borderColor: 'divider' }}>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'center' }}>
            <Typography sx={{ fontWeight: 600, flexGrow: 1, wordBreak: 'break-all' }}>{x.id}{x.repo && x.repo !== x.id ? ` (${x.repo})` : ''}</Typography>
            {x.read_only && <Chip size="small" label="read-only" />}
            <SourceButtons source={x} />
            <Button size="small" color="error" disabled={!!s.busy} onClick={() => setRemoving({ source: x, anyway: false })}>Remove…</Button>
          </Stack>
          <Typography variant="body2" data-testid={`source-status-${x.id}`}>{sourceLine(x)}</Typography>
          {prefs.advanced && x.url && <Typography variant="caption" color="text.secondary" sx={{ wordBreak: 'break-all' }}>{x.url}</Typography>}
          {x.read_only && (
            <Typography variant="body2" color="text.secondary">
              Studio cannot back up to this source (you may not have permission, or this computer is not signed in to it). Get latest still works; “Save a copy to…” puts a script into one of your own sources.{' '}
              <Button size="small" onClick={async () => { await call('sources_check_write', { folder, id: x.id }).catch(() => null); await refreshSources(folder); }}>Check again</Button>
            </Typography>
          )}
          {!x.read_only && (
            <FormControlLabel label="Auto save to GitHub" control={<Switch size="small" checked={!!sp.auto?.includes(x.id)}
              onChange={(e) => setSp({ auto: e.target.checked ? [...(sp.auto || []), x.id] : (sp.auto || []).filter((i) => i !== x.id) })} inputProps={{ 'aria-label': `Auto save ${x.id} to GitHub` }} />} />
          )}
        </Box>
      ))}
      {writable(list).length > 1 && (
        <FormControl sx={{ mt: 1 }}>
          <Typography id="save-new-here">Save new scripts here:</Typography>
          <RadioGroup row aria-labelledby="save-new-here" value={sp.saveNew || ''} onChange={(e) => setSp({ saveNew: e.target.value })}>
            {writable(list).map((x) => <FormControlLabel key={x.id} value={x.id} control={<Radio size="small" />} label={x.id} />)}
          </RadioGroup>
        </FormControl>
      )}
      {list.length > 0 && <Box sx={{ my: 1 }}><ScriptsRepoButtons /></Box>}
      {list.some((x) => !x.read_only) && <Typography variant="body2" color="text.secondary">Auto save: after you save in Studio, it waits {AUTO_SAVE_QUIET_TEXT} and then backs that source up. If that does not work, the status bar says so.</Typography>}
      {showAdd && (
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ mt: 1.5 }}>
          <TextField fullWidth label={list.length ? 'Add another script source' : 'Repository'} placeholder="you/my-scripts, or https://…" value={text} onChange={(e) => setText(e.target.value)}
            helperText="owner/repo for GitHub, gitlab:group/repo, bitbucket:owner/repo, or the full address your server shows under Clone." onKeyDown={(e) => { if (e.key === 'Enter') void add(); }} />
          <Button variant="contained" sx={{ alignSelf: { sm: 'flex-start' }, mt: { sm: 1 }, flexShrink: 0 }} disabled={!text.trim() || !!s.busy || !folder} onClick={() => void add()}>
            {s.busy === 'add' ? 'Adding…' : list.length ? 'Add' : 'Connect'}
          </Button>
        </Stack>
      )}
      {!showAdd && <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>More sources (a friend's scripts, a team's) can be added with Advanced turned on.</Typography>}
      {removing && (() => {
        const x = removing.source;
        const unsaved = x.read_only ? 0 : x.changes || 0;
        return (
          <Dialog open onClose={() => setRemoving(null)} fullWidth maxWidth="sm" aria-labelledby="remove-source">
            <DialogTitle id="remove-source">Remove “{x.id}”?</DialogTitle>
            <DialogContent>
              <Typography gutterBottom>This deletes Studio's copy of this source ({x.path}). The repository itself is not touched; you can add it again later.</Typography>
              {unsaved > 0 && <>
                <Alert severity="warning" sx={{ my: 1 }}>{unsaved} change{unsaved === 1 ? ' is' : 's are'} not backed up. Press Back up first to keep {unsaved === 1 ? 'it' : 'them'}.</Alert>
                <FormControlLabel control={<Checkbox checked={removing.anyway} onChange={(e) => setRemoving({ ...removing, anyway: e.target.checked })} />} label="Delete anyway (those changes are lost)" />
              </>}
            </DialogContent>
            <DialogActions>
              <Button onClick={() => setRemoving(null)}>Cancel</Button>
              <Button variant="contained" color="error" disabled={unsaved > 0 && !removing.anyway} onClick={() => void remove(x, removing.anyway)}>Remove</Button>
            </DialogActions>
          </Dialog>
        );
      })()}
      {s.done && <Alert severity="success" sx={{ mt: 1 }} onClose={() => setRepoState((st) => ({ ...st, done: '' }))}>{s.done}</Alert>}
    </Box>
  );
}

/** The status bar's item: all sources in one line, or the quiet note when auto save did not work. */
export function ScriptsRepoStatus({ sx }: { sx: object }) {
  const s = useRepoState();
  const nav = useNav();
  if (!s.sources.length && !s.note) return null;
  const text = s.note || `Scripts: ${statusLine(s.sources)}`;
  return (
    <Box component="button" type="button" data-testid="status-scripts-repo" title={s.note ? 'Show what happened' : 'Script sources (in Settings)'}
      onClick={() => (s.note && s.last ? setRepoState((st) => ({ ...st, dialog: st.last })) : nav.go({ view: 'settings' }))}
      sx={{ ...sx, display: 'flex', alignItems: 'center', border: 0, bgcolor: 'transparent', cursor: 'pointer', font: 'inherit' }}>
      {text}
    </Box>
  );
}

/** The palette's commands (only while there are sources). */
export function useScriptsCommands(): Command[] {
  const s = useRepoState();
  const act = useSourceActions();
  const ids = s.sources.map((x) => `${x.id}:${x.read_only ? 1 : 0}`).join('|');
  return useMemo(() => {
    if (!s.sources.length) return [];
    const out: Command[] = [
      { id: 'scripts-get', label: 'Get latest scripts', group: 'Action', also: 'git pull update sync github gitlab sources', run: () => void act.getLatest() },
    ];
    if (writable(s.sources).length) out.push({ id: 'scripts-backup', label: 'Back up everything (scripts)', group: 'Action', also: 'git push commit save sync github gitlab sources', run: () => void act.backup() });
    if (s.sources.length > 1) for (const x of s.sources) {
      out.push({ id: `scripts-get:${x.id}`, label: `Get latest: ${x.id}`, group: 'Action', also: 'git pull source', run: () => void act.getLatest(x.id) });
      if (!x.read_only) out.push({ id: `scripts-backup:${x.id}`, label: `Back up: ${x.id}`, group: 'Action', also: 'git push source', run: () => void act.backup(x.id) });
    }
    return out;
  }, [ids]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** In the background: tells the core which sources auto save, follows its answers, keeps the status line fresh,
 * asks where new scripts go, and shows the one dialog. */
export function ScriptsRepoWork() {
  const { prefs, libraryVersion, bumpLibrary } = useStore();
  const s = useRepoState();
  const act = useSourceActions();
  const folder = prefs.workspace;
  const sp = sourcePrefs(prefs);
  const autoKey = (sp.auto || []).join('|');
  useEffect(() => {
    if (!folder) return;
    void call('sources_auto', { folder, ids: sp.auto || [] }).catch(() => {});
  }, [folder, autoKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => onEvent((e) => {
    if (e.kind !== 'scripts_repo') return;
    // a button's own answer drives its dialog; events from auto save leave only the quiet note
    if (e.auto) {
      setRepoState((st) => applyAnswer(st, e.result, true));
      if (e.result?.changed) bumpLibrary();
      void refreshSources(folder);
    }
  }), [bumpLibrary, folder]);
  useEffect(() => { void refreshSources(folder); }, [folder, libraryVersion]);
  useEffect(() => { const t = setInterval(() => void refreshSources(folder), STATUS_REFRESH_MS); return () => clearInterval(t); }, [folder]);

  // "where should this be saved?"
  const [ask, setAsk] = useState<{ title: string; choices: Destination[]; value: string; resolve: (v: string | null) => void } | null>(null);
  useEffect(() => {
    setDestinationChooser((title, choices, dflt) => new Promise((resolve) => setAsk({ title, choices, value: dflt, resolve })), sp);
    return () => setDestinationChooser(null);
  }, [sp.saveNew]); // eslint-disable-line react-hooks/exhaustive-deps

  const d = s.dialog;
  const close = () => setRepoState((st) => ({ ...st, dialog: null }));
  return (
    <>
      {ask && (
        <Dialog open onClose={() => { ask.resolve(null); setAsk(null); }} fullWidth maxWidth="sm" aria-labelledby="dest-title">
          <DialogTitle id="dest-title">{ask.title}</DialogTitle>
          <DialogContent>
            <RadioGroup aria-labelledby="dest-title" value={ask.value} onChange={(e) => setAsk({ ...ask, value: e.target.value })}>
              {ask.choices.map((c) => <FormControlLabel key={c.id || '-'} value={c.id} control={<Radio />} label={c.label} />)}
            </RadioGroup>
          </DialogContent>
          <DialogActions>
            <Button onClick={() => { ask.resolve(null); setAsk(null); }}>Cancel</Button>
            <Button variant="contained" onClick={() => { ask.resolve(ask.value); setAsk(null); }}>Save</Button>
          </DialogActions>
        </Dialog>
      )}
      {d && (
        <Dialog open onClose={close} fullWidth maxWidth="sm" aria-labelledby="scripts-repo-dialog">
          <DialogTitle id="scripts-repo-dialog">Script sources</DialogTitle>
          <DialogContent><Typography data-testid="scripts-repo-message">{d.message}</Typography></DialogContent>
          <DialogActions>
            {d.kind === 'back_up_first' && <Button onClick={() => { close(); void act.backup(); }}>Back up everything</Button>}
            {folder && d.kind !== 'no_write' && <Button onClick={() => void call('open_folder', { folder: folderIn(d.message) || folder }).catch(() => {})}>Open folder</Button>}
            <Button variant="contained" onClick={close} autoFocus>OK</Button>
          </DialogActions>
        </Dialog>
      )}
    </>
  );
}

/** The folder a "needs a git client" message names ("… Folder: <path>."). */
export function folderIn(message: string): string {
  const m = /Folder: (.+)\.$/.exec(message);
  return m ? m[1] : '';
}
