// "Your library": every effect script and every firmware of your own, in one list; pick one to edit it.
import { useEffect, useRef, useState } from 'react';
import { Alert, Box, Button, Chip, Dialog, DialogContent, DialogTitle, Divider, List, ListItemButton, ListItemText, ListSubheader, Menu, MenuItem, Stack, Typography } from '@mui/material';
import Add from '@mui/icons-material/Add';
import { call } from '../api';
import { useStore } from '../store';
import { useBoardActions } from '../components/actions';
import EffectEditor from './EffectEditor';
import FirmwareEditor from './FirmwareEditor';
import PatternEditor from './PatternEditor';
import { EXAMPLE_PATTERNS, STARTER_PATTERN } from '../patterns/examples';
import { cleanPatternName, parseEpe } from '../patterns/epe';
import NewEffect from '../components/NewEffect';
import { freeName, saveNewEffect, takenNote } from '../library';
import { dropDraft, moveDraft } from '../drafts';
import { Loc, useNav } from '../nav';
import { keyLabel } from '../shell/keys';
import { SideBarBody, SideBarContent, SideBarHeader } from '../shell/SideBar';
import { ScriptsRepoButtons, SourceButtons, useRepoState } from '../components/ScriptsRepo';
import { chooseCopyDestination, qualify, sourceOf, titleOf } from '../scriptsRepo';
import { PropIcon, resolveIcon } from '../props/icons';

const STARTER = 'effect my effect:\n  wait for trig1\n  out1 = on\n  wait 2\n  out1 = off\n';

/** Your library: its list in the side bar (effects, own firmware, sounds), the open one in the work area. What is
 * open is part of where you are (`loc.item`): picking one is a step Back can undo. */
export default function Workspace({ dark, loc }: { dark: boolean; loc: Loc }) {
  const { prefs, libraryVersion, bumpLibrary } = useStore();
  const act = useBoardActions();
  const nav = useNav();
  const [effects, setEffects] = useState<any[]>([]);
  const [firmware, setFirmware] = useState<any[]>([]);
  const [sounds, setSounds] = useState<Record<string, number>>({});
  const [patterns, setPatterns] = useState<any[]>([]);
  const [sel, setSel] = useState<{ kind: 'effect' | 'firmware' | 'pattern'; name: string; text?: string } | null>(null);
  const [patternExamples, setPatternExamples] = useState(false);
  const [pmenu, setPmenu] = useState<{ name: string; x: number; y: number } | null>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const [examples, setExamples] = useState<any[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [menu, setMenu] = useState<{ name: string; x: number; y: number } | null>(null);
  const ws = prefs.workspace;
  const repo = useRepoState();
  // the library's own scripts first, then each script source as its own group
  const groups: { id: string; items: any[] }[] = [{ id: '', items: effects.filter((e) => !e.source) }, ...repo.sources.map((s) => ({ id: s.id, items: effects.filter((e) => e.source === s.id) }))];
  const saveCopy = async (n: string) => {
    const dest = await chooseCopyDestination(n);
    if (dest === null) return;
    try {
      const r = await saveNewEffect(ws, titleOf(n), await call('library_read', { folder: ws, name: n }), { dest });
      bumpLibrary();
      setNote(r.renamed ? takenNote(titleOf(n), titleOf(r.name)) : '');
      openEffect(r.name);
    } catch (e: any) { setError(String(e.message || e)); }
  };

  useEffect(() => {
    if (!ws) return;
    call('library_list', { folder: ws }).then(setEffects).catch((e) => setError(String(e.message || e)));
    call('library_projects', { folder: ws }).then(setFirmware).catch(() => setFirmware([]));
    call('sounds', { folder: ws }).then(setSounds).catch(() => setSounds({}));
    call('pattern_list', { folder: ws }).then(setPatterns).catch(() => setPatterns([]));
  }, [ws, libraryVersion]);

  const load = async (name: string) => {
    try { setSel({ kind: 'effect', name, text: await call('library_read', { folder: ws, name }) }); } catch (e: any) { setError(String(e.message || e)); }
  };
  // what is open follows where you are (a pick here, "Open in Your library" from a board, Back and Forward)
  useEffect(() => {
    if (!ws) return;
    if (!loc.item) setSel(null);
    else if (loc.item.kind === 'effect') void load(loc.item.name);
    else if (loc.item.kind === 'pattern') { const n = loc.item.name; call('pattern_read', { folder: ws, name: n }).then((text) => setSel({ kind: 'pattern', name: n, text })).catch((e) => setError(String(e.message || e))); }
    else setSel({ kind: 'firmware', name: loc.item.name });
  }, [loc.item?.kind, loc.item?.name, loc.seq, ws]); // eslint-disable-line react-hooks/exhaustive-deps
  const openEffect = (name: string) => nav.go({ view: 'library', item: { kind: 'effect', name } });
  // the command palette's "New effect…"
  useEffect(() => { if (loc.add) setCreating(true); }, [loc.add, loc.seq]);
  const newEffect = async (text = STARTER, suggested = '', given = '') => {
    const name = given || (await act.askName('Name your new effect', suggested));
    if (!name) return;
    try {
      const r = await saveNewEffect(ws, name, text);
      bumpLibrary();
      setNote(r.renamed ? takenNote(name, r.name) : '');
      openEffect(r.name);
    } catch (e: any) { setError(String(e.message || e)); }
  };
  // LED patterns (src/patterns/): a new one never replaces one that is there (" 2", " 3"... as for effects)
  const openPattern = (name: string) => nav.go({ view: 'library', item: { kind: 'pattern', name } });
  const savePattern = async (asked: string, text: string): Promise<string> => {
    const list: any[] = await call('pattern_list', { folder: ws });
    const name = freeName(list.filter((p) => !p.source).map((p) => p.title), cleanPatternName(asked) || 'my pattern');
    await call('pattern_save', { folder: ws, name, text, new: true });
    bumpLibrary();
    setNote(name !== asked.trim() ? `There is already a pattern called “${asked.trim()}” in your library, so this one is called “${name}”. Nothing was replaced.` : '');
    return name;
  };
  const newPattern = async (text = STARTER_PATTERN, suggested = '') => {
    const name = await act.askName('Name your new pattern', suggested);
    if (!name) return;
    try { openPattern(await savePattern(name, text)); } catch (e: any) { setError(String(e.message || e)); }
  };
  const importPattern = async (file: File) => {
    try {
      const p = parseEpe(await file.text());
      const name = await savePattern(p.name, p.source);
      openPattern(name);
    } catch (e: any) { setError(String(e.message || e)); }
  };
  const newFirmware = async () => {
    const name = await act.askName('Name your new firmware');
    if (!name) return;
    try {
      const p = await call('firmware_new', { folder: ws, name });
      bumpLibrary();
      nav.go({ view: 'library', item: { kind: 'firmware', name: p.name } });
    } catch (e: any) { setError(String(e.message || e)); }
  };

  if (!ws) return <Alert severity="info">Choose your library folder in Settings first.</Alert>;
  return (
    <Box>
      <SideBarContent inline>
        <SideBarHeader title="Your library" />
        <Stack spacing={1.5} sx={{ px: 3, pb: 2 }}>
          <Button variant="contained" startIcon={<Add />} onClick={() => setCreating(true)} fullWidth>New effect</Button>
          <Button variant="outlined" onClick={async () => setExamples(await call('examples'))} fullWidth>Start from an example</Button>
          <ScriptsRepoButtons stacked />
        </Stack>
        <SideBarBody label="Your library">
          {groups.map((g) => { const src = repo.sources.find((s) => s.id === g.id); return (g.id === '' || src) && (
          <List key={g.id || '-'} component="div" disablePadding aria-label={g.id ? `Effects in ${g.id}` : 'Effects'} data-testid={g.id ? `source-group-${g.id}` : undefined}
            subheader={<ListSubheader component="div" disableSticky sx={{ px: 3, display: 'flex', alignItems: 'center', gap: 1 }}>
              <Box component="span" sx={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{g.id ? `${g.id}${src?.read_only ? ' (read-only)' : ''}` : repo.sources.length ? 'Effects on this computer' : 'Effects'}</Box>
              {src && <SourceButtons source={src} />}
            </ListSubheader>}>
            {g.items.map((e) => (
              <ListItemButton key={e.name} selected={sel?.kind === 'effect' && sel.name === e.name} onClick={() => openEffect(e.name)} sx={{ px: 3 }}
                onContextMenu={(ev) => { ev.preventDefault(); setMenu({ name: e.name, x: ev.clientX, y: ev.clientY }); }}
                onKeyDown={(ev) => { if (ev.key === 'ContextMenu' || (ev.shiftKey && ev.key === 'F10')) { ev.preventDefault(); const r = ev.currentTarget.getBoundingClientRect(); setMenu({ name: e.name, x: r.left + 24, y: r.bottom }); } }}
                aria-current={sel?.kind === 'effect' && sel.name === e.name ? 'page' : undefined}>
                <Box sx={{ mr: 1.5, display: 'inline-flex' }}><PropIcon icon={e.icon} color={e.color} size={22} tooltip={false} label={`${resolveIcon(e.icon).label} icon`} testId="library-icon" /></Box>
                <ListItemText primary={e.title ?? e.name} secondary={e.saved ? `saved ${e.saved}` : undefined}
                  slotProps={{ primary: { noWrap: true }, secondary: { noWrap: true, variant: 'caption' } } as any} />
                {e.source && <Chip size="small" variant="outlined" label={e.source} sx={{ ml: 1, maxWidth: 96 }} aria-label={`from ${e.source}`} />}
              </ListItemButton>
            ))}
            {g.items.length === 0 && <Typography variant="body2" color="text.secondary" sx={{ px: 3 }}>{g.id ? 'No scripts in this source yet.' : 'No effects yet. Press New effect, or Start from an example.'}</Typography>}
          </List>); })}
          <List component="div" disablePadding aria-label="LED patterns" data-testid="pattern-list"
            subheader={<ListSubheader component="div" disableSticky sx={{ px: 3 }}>LED patterns</ListSubheader>}>
            {patterns.map((p) => (
              <ListItemButton key={p.name} selected={sel?.kind === 'pattern' && sel.name === p.name} onClick={() => openPattern(p.name)} sx={{ px: 3 }}
                aria-current={sel?.kind === 'pattern' && sel.name === p.name ? 'page' : undefined}
                onContextMenu={(ev) => { ev.preventDefault(); setPmenu({ name: p.name, x: ev.clientX, y: ev.clientY }); }}
                onKeyDown={(ev) => { if (ev.key === 'ContextMenu' || (ev.shiftKey && ev.key === 'F10')) { ev.preventDefault(); const r = ev.currentTarget.getBoundingClientRect(); setPmenu({ name: p.name, x: r.left + 24, y: r.bottom }); } }}>
                <ListItemText primary={p.title} slotProps={{ primary: { noWrap: true } } as any} />
                {p.source && <Chip size="small" variant="outlined" label={p.source} sx={{ ml: 1, maxWidth: 96 }} aria-label={`from ${p.source}`} />}
              </ListItemButton>
            ))}
            {patterns.length === 0 && <Typography variant="body2" color="text.secondary" sx={{ px: 3 }}>Patterns colour an LED strip, light by light. Make one and watch it in the preview.</Typography>}
          </List>
          <Stack direction="row" spacing={1} sx={{ px: 2, flexWrap: 'wrap', rowGap: 1 }}>
            <Button startIcon={<Add />} onClick={() => void newPattern()}>New pattern</Button>
            <Button onClick={() => setPatternExamples(true)}>Examples</Button>
            <Button onClick={() => importInput.current?.click()}>Import a pattern file…</Button>
            <input ref={importInput} type="file" accept=".epe" hidden data-testid="pattern-import"
              onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void importPattern(f); }} />
          </Stack>
          {prefs.advanced && <>
          <List component="div" disablePadding subheader={<ListSubheader component="div" disableSticky sx={{ px: 3 }}>Your own firmware</ListSubheader>} aria-label="Firmware">
            {firmware.map((f) => (
              <ListItemButton key={f.name} selected={sel?.kind === 'firmware' && sel.name === f.name} onClick={() => nav.go({ view: 'library', item: { kind: 'firmware', name: f.name } })} sx={{ px: 3 }}>
                <ListItemText primary={f.name} secondary={f.version ? `version ${f.version}` : 'not built yet'} slotProps={{ secondary: { variant: 'caption' } } as any} />
              </ListItemButton>
            ))}
          </List>
          <Button startIcon={<Add />} onClick={newFirmware} sx={{ mx: 2 }}>New firmware</Button></>}
          <List component="div" disablePadding subheader={<ListSubheader component="div" disableSticky sx={{ px: 3 }}>Sounds</ListSubheader>} aria-label="Sounds">
            {Object.entries(sounds).sort((x, y) => x[1] - y[1]).map(([n, i]) => <ListItemText key={n} sx={{ px: 3 }} primary={`${i} · ${n}`} />)}
            {Object.keys(sounds).length === 0 && <Typography variant="body2" color="text.secondary" sx={{ px: 3 }}>Scripts play sounds by number. The SD card tool puts your sounds on the card in order and can keep its list here.</Typography>}
          </List>
          <Typography variant="caption" component="p" color="text.secondary" sx={{ px: 3, mt: 3, wordBreak: 'break-all' }}>Folder: {ws}</Typography>
        </SideBarBody>
      </SideBarContent>
      <Box sx={{ minWidth: 0 }}>
        {error && <Alert severity="error" onClose={() => setError('')} sx={{ mb: 2 }}>{error}</Alert>}
        {note && <Alert severity="info" onClose={() => setNote('')} sx={{ mb: 2 }} data-testid="name-taken">{note}</Alert>}
        {!sel && (
          <Stack spacing={2} sx={{ maxWidth: 640 }} data-testid="library-empty">
            <Typography variant="h5" component="h2">Your library</Typography>
            <Typography>Pick an effect in the list on the left to change it, try it on a practice board and send it to boards.</Typography>
            <Typography color="text.secondary">New here? Press <b>Start from an example</b>, or <b>New effect</b> to say what a prop should do. {keyLabel('Mod+Shift+P')} finds any effect, board or command.</Typography>
          </Stack>
        )}
        {sel?.kind === 'effect' && <EffectEditor name={sel.name} initial={sel.text || ''} dark={dark} onSaved={() => {}}
          onChanged={(n) => { bumpLibrary(); if (n) nav.replace({ item: { kind: 'effect', name: n }, seq: (loc.seq || 0) + 1 }); else nav.replace({ item: undefined }); }} />}
        {sel?.kind === 'pattern' && <PatternEditor key={sel.name} name={sel.name} initial={sel.text || ''} dark={dark} onSaved={bumpLibrary}
          readOnly={!!repo.sources.find((s) => s.id === sourceOf(sel.name))?.read_only} />}
        {sel?.kind === 'firmware' && <FirmwareEditor project={firmware.find((f) => f.name === sel.name)} dark={dark} />}
      </Box>
      {menu && (() => {
        const n = menu.name;
        const run = (f: () => Promise<unknown> | unknown) => () => { setMenu(null); void Promise.resolve(f()).catch((err: any) => setError(String(err?.message || err))); };
        return (
          <Menu open onClose={() => setMenu(null)} anchorReference="anchorPosition" anchorPosition={{ top: menu.y, left: menu.x }} MenuListProps={{ 'aria-label': `What to do with “${n}”` }}>
            <MenuItem onClick={run(() => openEffect(n))}>Open</MenuItem>
            <MenuItem onClick={run(() => saveCopy(n))}>Save a copy to…</MenuItem>
            <MenuItem onClick={run(async () => { const to = await act.askName(`Rename “${titleOf(n)}”`, titleOf(n)); const full = to ? qualify(sourceOf(n), to) : ''; if (full && full !== n) { await call('library_rename', { folder: ws, from: n, to: full }); moveDraft(n, full); bumpLibrary(); if (sel?.name === n) nav.replace({ item: { kind: 'effect', name: full } }); } })}>Rename…</MenuItem>
            <MenuItem onClick={run(async () => { const to = await act.askName(`Copy “${titleOf(n)}” as`, `${titleOf(n)} (copy)`); if (to) { const r = await saveNewEffect(ws, to, await call('library_read', { folder: ws, name: n }), { dest: n.includes('/') && !repo.sources.find((s) => s.id === n.split('/')[0])?.read_only ? n.split('/')[0] : undefined }); bumpLibrary(); openEffect(r.name); } })}>Duplicate…</MenuItem>
            <Divider />
            <MenuItem sx={{ color: 'error.main' }} onClick={run(async () => { if (await act.confirm(`Delete “${n}”?`, 'It moves to the trash folder inside your library (.specter/trash), so it can be got back. Boards running it keep running it.', 'Delete')) { await call('library_delete', { folder: ws, name: n }); dropDraft(n); bumpLibrary(); if (sel?.name === n) nav.replace({ item: undefined }); } })}>Delete…</MenuItem>
          </Menu>
        );
      })()}
      {pmenu && (() => {
        const n = pmenu.name;
        const run = (f: () => Promise<unknown> | unknown) => () => { setPmenu(null); void Promise.resolve(f()).catch((err: any) => setError(String(err?.message || err))); };
        return (
          <Menu open onClose={() => setPmenu(null)} anchorReference="anchorPosition" anchorPosition={{ top: pmenu.y, left: pmenu.x }} MenuListProps={{ 'aria-label': `What to do with the pattern “${n}”` }}>
            <MenuItem onClick={run(() => openPattern(n))}>Open</MenuItem>
            <MenuItem onClick={run(async () => { const to = await act.askName(`Rename “${titleOf(n)}”`, titleOf(n)); const full = to ? qualify(sourceOf(n), to) : ''; if (full && full !== n) { await call('pattern_rename', { folder: ws, from: n, to: full }); bumpLibrary(); if (sel?.name === n) nav.replace({ item: { kind: 'pattern', name: full } }); } })}>Rename…</MenuItem>
            <MenuItem onClick={run(async () => { const to = await act.askName(`Copy “${titleOf(n)}” as`, `${titleOf(n)} (copy)`); if (to) openPattern(await savePattern(to, await call('pattern_read', { folder: ws, name: n }))); })}>Duplicate…</MenuItem>
            <Divider />
            <MenuItem sx={{ color: 'error.main' }} onClick={run(async () => { if (await act.confirm(`Delete the pattern “${n}”?`, 'It moves to the trash folder inside your library (.specter/trash), so it can be got back.', 'Delete')) { await call('pattern_delete', { folder: ws, name: n }); bumpLibrary(); if (sel?.name === n) nav.replace({ item: undefined }); } })}>Delete…</MenuItem>
          </Menu>
        );
      })()}
      {patternExamples && (
        <Dialog open onClose={() => setPatternExamples(false)} fullWidth maxWidth="sm">
          <DialogTitle>Example patterns</DialogTitle>
          <DialogContent>
            <List component="div">
              {EXAMPLE_PATTERNS.map((x) => (
                <ListItemButton key={x.title} onClick={() => { setPatternExamples(false); void newPattern(x.text, x.title); }}>
                  <ListItemText primary={x.title} secondary={x.text.split('\n')[0].replace(/^\/\/\s*/, '')} />
                </ListItemButton>
              ))}
            </List>
          </DialogContent>
        </Dialog>
      )}
      <NewEffect open={creating} onClose={() => setCreating(false)} onCreate={(n, t) => { setCreating(false); void newEffect(t, '', n); }} />
      {examples && (
        <Dialog open onClose={() => setExamples(null)} fullWidth maxWidth="md">
          <DialogTitle>Examples</DialogTitle>
          <DialogContent>
            <List component="div">
              {examples.map((x) => (
                <ListItemButton key={x.name} onClick={() => { setExamples(null); void newEffect(x.text, x.title); }}>
                  <ListItemText primary={x.title} secondary={x.text.split('\n').find((l: string) => l.startsWith('#'))?.replace(/^#\s*/, '')} />
                </ListItemButton>
              ))}
            </List>
          </DialogContent>
        </Dialog>
      )}
    </Box>
  );
}
