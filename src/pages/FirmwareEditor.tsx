// A firmware of your own (plain Arduino setup() and loop() on the Proptroller library). One Upload button:
// builds it for the chosen board and puts it there, over Wi-Fi (an update that rolls back if it fails) or USB.
import { useEffect, useRef, useState } from 'react';
import { Alert, Box, Button, Chip, Dialog, FormControlLabel, Switch, DialogActions, DialogContent, DialogTitle, LinearProgress, MenuItem, Stack, TextField, Typography } from '@mui/material';
import CodeEditor from '../components/CodeEditor';
import { call, onEvent } from '../api';
import { useStore } from '../store';
import { setupMonaco } from '../effects/monaco';
import { inFlight, sketchDrafts } from '../drafts';
import { sketchFromSaved, STARTER } from '../cpp/cppBlocks';
import CppBlocksView from '../cpp/CppBlocksView';
import { EditorViewSwitch, editorView, showsBlocks, showsScript } from '../editorView';

setupMonaco();

type Target = { id: string; label: string; args: Record<string, unknown>; usb: boolean };

export default function FirmwareEditor({ project, dark }: { project: any; dark: boolean }) {
  const { boards, prefs, bumpLibrary, setPrefs } = useStore();
  const view = editorView(prefs.editorView);
  const [text, setText] = useState('');
  const [saved, setSaved] = useState('');
  const [targets, setTargets] = useState<Target[]>([]);
  const [to, setTo] = useState('');
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<Target | null>(null);
  const [pio, setPio] = useState<boolean | null>(null);
  const [msg, setMsg] = useState<{ tone: 'success' | 'error' | 'info'; text: string } | null>(null);
  // blocks mode: the workspace is saved beside the sketch (<name>.blocks.json) and the sketch is made from it
  const [blocks, setBlocks] = useState<unknown | null>(null);
  const [blocksSaved, setBlocksSaved] = useState<string>('');
  const [blocksKey, setBlocksKey] = useState(0);
  const blocksFile = project ? project.main.replace(/\.ino$/, '.blocks.json') : '';

  const loadedFor = useRef(''); // the sketch the editor's text belongs to (nothing is kept before it has loaded)
  useEffect(() => {
    if (!project) return;
    loadedFor.current = '';
    setBlocks(null);
    setMsg(null);
    void (async () => {
      try {
        const t = await call('file_read', { folder: prefs.workspace, path: project.main });
        setSaved(t);
        // unsaved edits from before (another page, another sketch): they come back as they were
        const d = sketchDrafts.get(project.name);
        if (d) {
          setText(d.text);
          if (d.saved !== t) setMsg({ tone: 'info', text: 'Your unsaved changes are back. The saved sketch was changed elsewhere since: Save replaces it with yours.' });
          if (d.blocks) { setBlocks(d.blocks); setBlocksSaved(d.blocksSaved); setBlocksKey((k) => k + 1); }
          loadedFor.current = project.name;
          return;
        }
        setText(t);
        const b = await call('file_read', { folder: prefs.workspace, path: blocksFile }).then(JSON.parse).catch(() => null);
        if (b) {
          if (sketchFromSaved(b) === t) { setBlocks(b); setBlocksSaved(JSON.stringify(b)); setBlocksKey((k) => k + 1); }
          else setMsg({ tone: 'info', text: 'This sketch was changed by hand, so it opens as text. Turning Blocks on again replaces the sketch with what its blocks make.' });
        }
        loadedFor.current = project.name;
      } catch (e: any) {
        setMsg({ tone: 'error', text: String(e.message || e) });
      }
    })();
  }, [project?.main]); // eslint-disable-line react-hooks/exhaustive-deps
  // unsaved edits are kept outside this page (drafts.ts): leaving it, or closing, never loses them
  useEffect(() => {
    if (!project || loadedFor.current !== project.name) return;
    const isDirty = text !== saved || (!!blocks && JSON.stringify(blocks) !== blocksSaved);
    if (isDirty) sketchDrafts.set(project.name, { text, blocks, saved, blocksSaved });
    else sketchDrafts.delete(project.name);
  }, [project?.name, text, blocks, saved, blocksSaved]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { call('pio_status').then((s) => setPio(s.installed)).catch(() => setPio(false)); }, []);
  useEffect(() => onEvent((e: any) => { if (e.kind === 'build' && e.project === project?.name) setLog((l) => [...l.slice(-400), e.line]); }), [project?.name]);

  const findTargets = async () => {
    const t: Target[] = Object.values(boards).filter((b) => !b.sim && b.online).map((b) => ({ id: b.key, label: `Over Wi-Fi: ${b.info?.name}`, args: { key: b.key }, usb: false }));
    for (const p of await call('serial_ports').catch(() => [])) if (/ESP32/.test(p.what)) t.push({ id: p.path, label: `Over USB: ${p.what} on ${p.path}`, args: { port: p.path, board: 'esp32dev' }, usb: true });
    for (const d of await call('bootsel_drives').catch(() => [])) t.push({ id: d.path, label: `Over USB: ${d.what}`, args: { drive: d.path, board: /2350/.test(d.board) ? 'pico2w' : 'picow' }, usb: true });
    setTargets(t);
  };
  useEffect(() => { void findTargets(); }, [boards]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!project) return null;
  const running = Object.values(boards).filter((b) => b.firmware?.custom?.name === project.name);

  // throws when the sketch could not be written (go() reports it); the Save button reports it itself
  const save = async () => {
    await call('file_write', { folder: prefs.workspace, path: project.main, text });
    if (blocks) {
      const j = JSON.stringify(blocks, null, 1);
      await call('file_write', { folder: prefs.workspace, path: blocksFile, text: j });
      setBlocksSaved(JSON.stringify(blocks));
    }
    setSaved(text);
    sketchDrafts.delete(project.name);
  };
  const saveButton = async () => {
    try { await save(); } catch (e: any) { setMsg({ tone: 'error', text: `Not saved: ${String(e.message || e)}. Your changes are still here.` }); }
  };
  const useBlocks = async (on: boolean) => {
    if (!on) { setBlocks(null); return; }
    const old = await call('file_read', { folder: prefs.workspace, path: blocksFile }).then(JSON.parse).catch(() => null);
    const start = old || STARTER;
    if (!window.confirm('Use blocks? The sketch is replaced by what the blocks make (Save keeps it).')) return;
    setBlocks(start);
    setText(sketchFromSaved(start) || text);
    setBlocksKey((k) => k + 1);
  };
  const dirty = text !== saved || (!!blocks && JSON.stringify(blocks) !== blocksSaved);
  const go = async (args: Record<string, unknown>, what: string) => {
    setBusy(true);
    setLog([]);
    setMsg({ tone: 'info', text: `${what}… The first build downloads the board's tools and can take several minutes.` });
    const id = `firmware:${project.name}:${Math.random()}`;
    inFlight.set(id, `${what.toLowerCase()} “${project.name}”`);
    try {
      if (dirty) await save();
      const r = await call('firmware_upload', { folder: prefs.workspace, name: project.name, ...args });
      setMsg({ tone: 'success', text: r.message });
      bumpLibrary();
    } catch (e: any) {
      setMsg({ tone: 'error', text: String(e.message || e) });
    } finally {
      inFlight.delete(id);
      setBusy(false);
    }
  };
  const upload = () => {
    const t = targets.find((x) => x.id === to);
    if (!t) return;
    setConfirm(t); // over USB or Wi-Fi, the board's firmware is replaced: ask first, naming the board
  };

  return (
    <Stack spacing={2}>
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
        <Typography variant="h5" component="h2" sx={{ flexGrow: 1 }}>{project.name}{dirty ? ' (not saved)' : ''}</Typography>
        <Chip label={project.version ? `version ${project.version}` : 'not built yet'} />
        <FormControlLabel control={<Switch checked={!!blocks} onChange={(e) => void useBlocks(e.target.checked)} />} label="Blocks" />
        {!!blocks && <EditorViewSwitch value={view} onChange={(v) => setPrefs({ editorView: v })} script="Sketch" />}
        <Button variant="outlined" onClick={saveButton} disabled={!dirty}>Save</Button>
      </Stack>
      {pio === false && (
        <Alert severity="info" action={<Button disabled={busy} onClick={async () => { setBusy(true); try { await call('pio_install'); setPio(true); } catch (e: any) { setMsg({ tone: 'error', text: String(e.message || e) }); } finally { setBusy(false); } }}>Install it</Button>}>
          Building your own firmware needs PlatformIO, a free tool (a few hundred MB download). Install it now?
        </Alert>
      )}
      {msg && <Alert severity={msg.tone} onClose={() => setMsg(null)}>{msg.text}</Alert>}
      {busy && <Box><LinearProgress /><Typography variant="body2" sx={{ mt: 0.5, fontFamily: 'monospace' }} noWrap>{log[log.length - 1] || ''}</Typography></Box>}
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: blocks && view === 'both' ? '1fr 1fr' : '1fr' }, gap: 2 }}>
        {!!blocks && showsBlocks(view) && <Box sx={{ height: 480, border: 1, borderColor: 'divider', borderRadius: 2, overflow: 'hidden' }}>
          <CppBlocksView key={blocksKey} initial={blocks} dark={dark} onChange={(b, code) => { setBlocks(b); setText(code); }} />
        </Box>}
        {(!blocks || showsScript(view)) && <Box sx={{ height: 480, border: 1, borderColor: 'divider', borderRadius: 2, overflow: 'hidden' }} data-testid="sketch-text">
          <CodeEditor language="cpp" dark={dark} value={text} onChange={setText}
            options={{ minimap: { enabled: false }, readOnly: !!blocks, wordWrap: blocks ? 'on' : 'off' }} />
        </Box>}
      </Box>
      <Typography variant="body2" color="text.secondary">Keyboard: in the text editor Tab adds spaces; press Ctrl+M, then Tab, to move on.</Typography>
      {!!blocks && <Typography variant="body2" color="text.secondary">The sketch on the right is made from the blocks. To write code by hand, turn Blocks off.</Typography>}
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'center' }}>
        <TextField select label="Put it on" value={to} onChange={(e) => setTo(e.target.value)} sx={{ minWidth: 320 }} SelectProps={{ onOpen: () => void findTargets() }}>
          {targets.map((t) => <MenuItem key={t.id} value={t.id}>{t.label}</MenuItem>)}
          {targets.length === 0 && <MenuItem value="" disabled>No boards: connect one, or plug one in with USB</MenuItem>}
        </TextField>
        <Button variant="contained" size="large" disabled={busy || !to || !pio} onClick={upload}>Upload</Button>
        <Button disabled={busy || !pio} onClick={() => go({ build_only: true }, 'Building')}>Build only</Button>
      </Stack>
      <Typography>Boards running it: {running.length ? running.map((b) => `${b.info?.name} (v${b.firmware?.custom?.version})`).join(', ') : 'none'}</Typography>
      {prefs.advanced && log.length > 0 && <Box component="pre" aria-label="Build log" sx={{ p: 2, bgcolor: 'action.hover', borderRadius: 2, overflow: 'auto', maxHeight: 300, m: 0, fontSize: 'body2.fontSize' }}>{log.join('\n')}</Box>}
      {confirm && (
        <Dialog open onClose={() => setConfirm(null)}>
          <DialogTitle>Replace the firmware on {confirm.usb ? 'this board' : boards[confirm.id]?.info?.name || 'this board'}?</DialogTitle>
          <DialogContent>
            <Typography gutterBottom>{confirm.label}</Typography>
            {confirm.usb
              ? <Typography>Studio builds “{project.name}” and writes it to the board over USB. The board's settings and effects are kept. Keep the cable plugged in until it says it is done.</Typography>
              : <Typography>Studio builds “{project.name}” and sends it to {boards[confirm.id]?.info?.name || 'the board'} over Wi-Fi. Whatever the board is doing stops while it restarts; its settings and effects are kept, and it goes back to its old firmware by itself if the new one does not start.</Typography>}
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setConfirm(null)}>Cancel</Button>
            <Button variant="contained" onClick={() => { const t = confirm; setConfirm(null); void go(t.usb ? { ...t.args, confirm: true } : t.args, t.usb ? 'Building and writing over USB' : 'Building and sending over Wi-Fi'); }}>Upload</Button>
          </DialogActions>
        </Dialog>
      )}
    </Stack>
  );
}
