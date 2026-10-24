// One effect script: text and blocks side by side (each changes the other), the board's own checker as you
// type, save to the library, try it on a practice board, send it to boards.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Box, Button, Chip, Collapse, MenuItem, Stack, TextField, Typography } from '@mui/material';
import ExpandMore from '@mui/icons-material/ExpandMore';
import ExpandLess from '@mui/icons-material/ExpandLess';
import OpenInNew from '@mui/icons-material/OpenInNew';
import ChevronRight from '@mui/icons-material/ChevronRight';
import { useNav } from '../nav';
import { call, nowLocal } from '../api';
import { useStore } from '../store';
import { useBoardActions, ActionMessage } from '../components/actions';
import { scriptToCpp } from '../effects/cppgen';
import ScriptEditor, { ScriptCheck } from '../effects/ScriptEditor';
import { EditorViewSwitch, editorView } from '../editorView';
import LivePanel from '../components/LivePanel';
import { saveNewEffect } from '../library';
import { useRepoState } from '../components/ScriptsRepo';
import { chooseCopyDestination, qualify, sourceOf, titleOf } from '../scriptsRepo';
import { dropDraft, getDraft, moveDraft, setDraft } from '../drafts';
import Plotter from '../components/Plotter';
import { hotExit } from '../hotexit';
import { useHotExit } from '../components/RestoreNote';
import { boardsRunning, dropNote, peekNote, versionSummary, VERSION_WORDS } from '../scriptLinks';
import { useSaveShortcut, SAVE_KEYS } from '../shell/save';
import { keyLabel } from '../shell/keys';
import LookPicker from '../props/LookPicker';

// the "Boards running this effect" list, open or folded as the person last left it (null: not chosen yet)
let runningOpen: boolean | null = null;

export default function EffectEditor({ name, initial, dark, onSaved, onChanged }: { name: string; initial: string; dark: boolean; onSaved: (name: string) => void; onChanged?: (name: string | null) => void }) {
  const store = useStore();
  const { prefs, boards } = store;
  const act = useBoardActions();
  const nav = useNav();
  // unsaved edits survive going to another page or effect (drafts.ts)
  const [text, setText] = useState(() => getDraft(name) ?? initial);
  const [saved, setSaved] = useState(initial);
  const savedRef = useRef(initial);
  savedRef.current = saved;
  const edit = (v: string) => { setText(v); setDraft(name, v, savedRef.current); };
  const [check, setCheck] = useState<ScriptCheck | null>(null);
  const view = editorView(prefs.editorView);
  const [tryKey, setTryKey] = useState('');
  const [msg, setMsg] = useState<{ tone: 'success' | 'error' | 'info' | 'warning'; text: string; action?: { label: string; run: () => void } } | null>(null);
  useEffect(() => {
    const draft = getDraft(name);
    setText(draft ?? initial); setSaved(initial);
    const note = peekNote(name);
    setMsg(draft !== undefined ? { tone: 'info', text: hotExit.effectItem(name) ? 'Restored your unsaved changes from last time. Press Save to keep them.' : 'Your changes here are not saved yet. Press Save to keep them.' } : note ? { tone: 'success', text: note } : null);
  }, [name, initial]);
  useEffect(() => { if (msg?.text && msg.text === peekNote(name)) dropNote(name); }, [msg, name]);
  // changes restored from last time arrive, or are kept or discarded (hotexit.ts)
  const restoredVersion = useHotExit();
  const restored = hotExit.effectItem(name);
  const seenVersion = useRef(restoredVersion);
  useEffect(() => {
    if (seenVersion.current === restoredVersion) return; // a new effect is opened by the effect above
    seenVersion.current = restoredVersion;
    setText(getDraft(name) ?? savedRef.current);
  }, [restoredVersion, name]);

  
  // every known board running this effect: by name (the device layer's match) or word for word (scriptLinks.ts)
  const running = useMemo(() => boardsRunning(boards, name, saved), [boards, name, saved]);
  const older = running.filter((r) => r.version === 'older').map((r) => r.board);
  // the list starts open for a few boards and folded for many, then stays as the person left it
  const [openPref, setOpenPref] = useState<boolean | null>(runningOpen);
  const open = openPref ?? running.length <= 3;
  const dirty = text !== saved;
  // a script from a read-only source (scriptsRepo.ts): it can be changed here, then saved as a copy in one of your own sources
  const repo = useRepoState();
  const readOnly = !!repo.sources.find((s) => s.id === sourceOf(name))?.read_only;
  const saveCopy = async () => {
    const dest = await chooseCopyDestination(name);
    if (dest === null) return;
    try { const r = await saveNewEffect(prefs.workspace, titleOf(name), text, { dest }); dropDraft(name); onChanged?.(r.name); } catch (e: any) { setMsg({ tone: 'error', text: String(e.message || e) }); }
  };

  // what the editor opened (or last saved), as the library's hash: a save never overwrites a file changed outside
  // Studio since (another window, another computer, a sync folder)
  const baseHash = useRef<string | undefined>(undefined);
  useEffect(() => { void call('library_hash', { text: saved }).then((h) => { baseHash.current = h; }).catch(() => {}); }, [name, saved]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = async (force = false) => {
    try {
      await call('library_save', { folder: prefs.workspace, name, text, now: nowLocal(), ...(force || !baseHash.current ? {} : { base_hash: baseHash.current }) });
      // what is on disk now is this text: the next save is checked against it (before any other save can start)
      baseHash.current = await call('library_hash', { text }).catch(() => undefined);
      setSaved(text);
      dropDraft(name);
      store.bumpLibrary();
      onSaved(name);
      setMsg({ tone: 'success', text: `Saved “${name}”.` });
      return true;
    } catch (e: any) {
      const m = String(e.message || e);
      if (m.startsWith('changed outside')) {
        setMsg({ tone: 'warning', text: `Not saved: “${name}” was changed outside Studio since you opened it (another window, another computer or a sync folder). Save yours over it, or copy your changes, open the effect again and add them there.`,
          action: { label: 'Save mine over it', run: () => void save(true) } });
      } else setMsg({ tone: 'error', text: m });
      return false;
    }
  };
  // Ctrl+S / ⌘S: the same as the Save button (Save a copy to… for a read-only source)
  useSaveShortcut(readOnly ? `Save a copy of “${titleOf(name)}” to…` : `Save “${name}”`, () => {
    if (readOnly) void saveCopy();
    else if (dirty) void save();
    else setMsg({ tone: 'info', text: `“${name}” is already saved.` });
  });
  const tryIt = async () => {
    // never try an old version: when the save does not go through, nothing is sent (the message says why)
    if (dirty && !(await save())) return;
    let key = tryKey;
    if (!key || !boards[key]) {
      key = Object.values(boards).find((b) => b.sim)?.key || (await store.startSim('Practice board 1'));
      setTryKey(key);
    }
    await act.sendEffect(key, name);
  };

  return (
    <Stack spacing={2}>
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
        <Box component="nav" aria-label="Where you are" sx={{ display: 'flex', alignItems: 'center', gap: 1, flexGrow: 1, minWidth: 0 }}>
          <Typography variant="body1" color="text.secondary" sx={{ whiteSpace: 'nowrap' }}>Your library</Typography>
          <ChevronRight fontSize="small" sx={{ color: 'text.secondary' }} aria-hidden />
          <Typography variant="h5" component="h2" sx={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}{dirty ? ' (not saved)' : ''}</Typography>
        </Box>
        {readOnly ? <Button variant="contained" onClick={() => void saveCopy()}>Save a copy to…</Button> : <Button variant="contained" onClick={() => void save()} disabled={!dirty} title={`Save (${keyLabel(SAVE_KEYS)})`}>Save</Button>}
        {!readOnly && <Button onClick={async () => { const t = await act.askName(`Rename “${titleOf(name)}”`, titleOf(name)); const n = t ? qualify(sourceOf(name), t) : ''; if (n && n !== name) { try { await call('library_rename', { folder: prefs.workspace, from: name, to: n }); moveDraft(name, n); onChanged?.(n); } catch (e: any) { setMsg({ tone: 'error', text: String(e.message || e) }); } } }}>Rename…</Button>}
        <Button onClick={async () => { const n = await act.askName(`Copy “${titleOf(name)}” as`, `${titleOf(name)} (copy)`); if (n) { try { const r = await saveNewEffect(prefs.workspace, n, text, readOnly || !sourceOf(name) ? {} : { dest: sourceOf(name) }); onChanged?.(r.name); } catch (e: any) { setMsg({ tone: 'error', text: String(e.message || e) }); } } }}>Duplicate…</Button>
        {!readOnly && <Button color="error" onClick={async () => { if (await act.confirm(`Delete “${name}”?`, 'It moves to the trash folder inside your library (.specter/trash), so it can be got back. Boards running it keep running it.', 'Delete')) { await call('library_delete', { folder: prefs.workspace, name }); dropDraft(name); onChanged?.(null); } }}>Delete…</Button>}
        <LookPicker text={text} onChange={edit} />
        <Button variant="outlined" onClick={tryIt} disabled={!check?.ok}>Try it on a practice board</Button>
        <EditorViewSwitch value={view} onChange={(v) => store.setPrefs({ editorView: v })} />
      </Stack>
      {readOnly && <Alert severity="info" data-testid="read-only-source">This script is in “{sourceOf(name)}”, a source Studio cannot back up to. Change it if you like, then use Save a copy to… to keep it in one of your own sources.</Alert>}
      {restored?.conflict && <Alert severity="warning" action={<Button color="inherit" onClick={() => hotExit.requestCompare(name)}>Compare and pick…</Button>}>This effect was saved again since Studio kept your unsaved changes: there are two versions.</Alert>}
      {msg && <Alert severity={msg.tone} onClose={() => setMsg(null)} data-testid="editor-message" action={msg.action && <Button color="inherit" size="small" onClick={() => { setMsg(null); msg.action!.run(); }}>{msg.action.label}</Button>}>{msg.text}</Alert>}
      <ActionMessage />
      <Box role="region" aria-labelledby="boards-running-title" data-testid="boards-running"
        sx={{ px: 1.5, py: 0.5, borderRadius: 2, bgcolor: 'action.hover' }}>
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, alignItems: 'center' }}>
          <Typography component="h3" id="boards-running-title" sx={{ m: 0 }}>
            <Button onClick={() => { runningOpen = !open; setOpenPref(runningOpen); }} disabled={running.length === 0} aria-expanded={running.length > 0 && open} aria-controls="boards-running-list"
              startIcon={open && running.length > 0 ? <ExpandLess /> : <ExpandMore />} sx={{ fontWeight: 700, color: 'text.primary' }} data-testid="boards-running-toggle">
              Boards running this effect ({running.length})
            </Button>
          </Typography>
          <Typography color="text.secondary" data-testid="boards-running-summary">{running.length ? versionSummary(running) : 'None yet. Send it to a board to see it here.'}</Typography>
          {older.length > 0 && <Button variant="contained" sx={{ ml: 'auto' }} onClick={async () => { if (!(await act.okToInterrupt(older.map((b) => b.key), `Sending “${name}”`))) return; for (const b of older) await act.sendEffect(b.key, name, true); }}>Update all {older.length} board{older.length > 1 ? 's' : ''} running an older “{name}”</Button>}
        </Box>
        <Collapse in={open && running.length > 0} unmountOnExit>
          <Box component="ul" id="boards-running-list" aria-label={`Boards running “${name}”`} sx={{ listStyle: 'none', m: 0, p: 0, pb: 1 }}>
            {running.map(({ board: b, version }) => {
              const bn = b.info?.name || b.key;
              return (
                <Box component="li" key={b.key} data-testid={`running-${bn}`} sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1, py: 0.5, borderTop: 1, borderColor: 'divider' }}>
                  <Box aria-hidden sx={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, bgcolor: b.online ? 'success.main' : 'text.disabled' }} />
                  <Typography sx={{ fontWeight: 600 }}>{bn}</Typography>
                  {!b.online && <Typography variant="body2" color="text.secondary">not answering</Typography>}
                  <Chip size="small" label={VERSION_WORDS[version]} color={version === 'same' ? 'success' : version === 'older' ? 'warning' : 'info'} />
                  <Box sx={{ flexGrow: 1 }} />
                  {version !== 'same' && <Button size="small" variant="outlined" disabled={dirty || !check?.ok || !b.online} onClick={() => void act.sendEffect(b.key, name)}
                    aria-label={`Send this version to ${bn}`} title={dirty ? 'Save it first' : `${bn} gets the version saved here`}>Send this version</Button>}
                  <Button size="small" startIcon={<OpenInNew fontSize="small" />} onClick={() => nav.openBoard(b.key, 'script')} aria-label={`Open board ${bn}`}
                    title={`Open ${bn}: its live inputs and outputs and the script it runs`}>Open board</Button>
                </Box>
              );
            })}
          </Box>
        </Collapse>
      </Box>
      <ScriptEditor text={text} onChange={edit} dark={dark} gotoName={name} onCheck={setCheck}
        footer={<SendTo name={name} disabled={dirty || !check?.ok} />} />
      {tryKey && boards[tryKey] && (
        <Box>
          <Typography variant="h6" component="h3">Practice board: press its inputs to try the effect</Typography>
          <LivePanel b={boards[tryKey]} />
          <Plotter source={{ board: tryKey }} />
          {/* the same Stop as on the board's card: a bare stop_all does not end a running effect script */}
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
            <Button variant="contained" color="error" onClick={() => act.stop(tryKey)} disabled={!boards[tryKey].online}>Stop</Button>
            {boards[tryKey].state?.paused && <Button variant="outlined" onClick={() => act.restart(tryKey)}>Start the practice board again</Button>}
          </Stack>
        </Box>
      )}
      {prefs.advanced && (
        <Box>
          <Typography variant="h6" component="h3">The same effect as C++ (beginner layer)</Typography>
          <Box component="pre" sx={{ p: 2, bgcolor: 'action.hover', borderRadius: 2, overflow: 'auto', maxHeight: 400, m: 0 }} data-testid="cpp-preview">{scriptToCpp(text)}</Box>
        </Box>
      )}
    </Stack>
  );
}

function SendTo({ name, disabled }: { name: string; disabled: boolean }) {
  const { boards } = useStore();
  const act = useBoardActions();
  const [to, setTo] = useState('');
  const list = Object.values(boards).filter((b) => b.online);
  return (
    <Stack spacing={1}>
      <TextField select size="small" label="Board" value={to} onChange={(e) => setTo(e.target.value)}>
        {list.map((b) => <MenuItem key={b.key} value={b.key}>{b.info?.name}</MenuItem>)}
      </TextField>
      <Button variant="contained" disabled={disabled || !to} onClick={() => act.sendEffect(to, name)}>Send to board</Button>
      {disabled && <Typography variant="body2" color="text.secondary">Save it (and fix any problems) before sending.</Typography>}
    </Stack>
  );
}
