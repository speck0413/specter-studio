// A board's effect script on its page, editable in place with the same editor as Your library (colours, blocks,
// the board's own checker, go to line). What is shown is what the board runs; an edit stays on this computer until
// it is sent to this board, saved to Your library, or both. The step to the library's copy (Open in Your library) is
// in the board page's header (components/ScriptLink.tsx); here, when they differ, a side-by-side comparison.
import { useReducer, useRef, useState } from 'react';
import { Alert, Box, Button, Stack, Typography } from '@mui/material';
import { call, nowLocal } from '../api';
import { useStore } from '../store';
import { useBoardActions } from './actions';
import { supportsScripts } from '../words';
import { saveNewEffect, scriptBody, scriptHeader, takenNote } from '../library';
import { boardScriptDrafts } from '../drafts';
import ScriptEditor, { ScriptCheck } from '../effects/ScriptEditor';
import ScriptCompare from '../effects/ScriptCompare';
import { EditorViewSwitch, editorView } from '../editorView';
import { useSaveShortcut, SAVE_KEYS } from '../shell/save';
import { keyLabel } from '../shell/keys';

const IN_LIBRARY = ['current', 'older', 'changed'];

export default function BoardScript({ boardKey, dark }: { boardKey: string; dark: boolean }) {
  const store = useStore();
  const { boards, prefs } = store;
  const act = useBoardActions();
  const b = boards[boardKey];
  const boardText: string = b?.script?.text ?? '';
  const body = scriptBody(boardText);
  const header = scriptHeader(boardText);
  const s = b?.scriptStatus;
  const name: string = s?.name || header?.name || '';
  const inLibrary = !!s && IN_LIBRARY.includes(s.status) && !!name;
  const boardName = b?.info?.name || boardKey;
  const gotoName = `board:${boardKey}`;

  // an edit not sent or saved yet survives going to another tab or page (drafts.ts); without one, the editor shows
  // what the board runs, and follows it when it changes
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const draft = boardScriptDrafts.get(boardKey);
  const text = draft ? draft.text : body;
  const edit = (v: string) => {
    if (v === body) boardScriptDrafts.delete(boardKey);
    else boardScriptDrafts.set(boardKey, { text: v, base: boardScriptDrafts.get(boardKey)?.base ?? body });
    rerender();
  };
  const forget = () => { boardScriptDrafts.delete(boardKey); rerender(); };
  const dirty = text !== body;
  const [check, setCheck] = useState<ScriptCheck | null>(null);
  const [note, setNote] = useState<{ tone: 'success' | 'info' | 'warning' | 'error'; text: string } | null>(null);
  const [compare, setCompare] = useState<{ library: string; saved?: string } | null>(null);
  const view = editorView(prefs.editorView);
  // Ctrl+S / ⌘S: what the tab's main button does (set below, once the actions exist)
  const saveKey = useRef<() => void>(() => {});
  useSaveShortcut(`Save and send the effect script to ${boardName}`, () => saveKey.current(), !!b && supportsScripts(b));

  if (!b) return null;
  if (!supportsScripts(b)) return <Alert severity="warning">This board's firmware cannot run effect scripts. Update its firmware first.</Alert>;

  /** Puts `t` in Your library: under the effect's own name (asking before it replaces a newer or different copy),
   * or under a new name for a script that is not in the library. Returns the name, or null when not saved. */
  const saveToLibrary = async (t: string, asked = false): Promise<string | null> => {
    try {
      if (inLibrary) {
        if (s.status !== 'current' && !asked && !(await act.confirm(`Replace “${name}” in Your library?`,
          `Your library has ${s.status === 'older' ? 'a newer' : 'a different'} “${name}”${s.library_saved ? ` (saved ${s.library_saved})` : ''}. Saving puts ${boardName}'s version in its place. Studio keeps the earlier version in the library's history. Not sure? Press Cancel and use “Compare with Your library” first.`, 'Replace'))) return null;
        // up to date until now: the save goes through only when the library's file is still that same version
        const base = s.status === 'current' ? await call('library_hash', { text: body }).catch(() => undefined) : undefined;
        await call('library_save', { folder: prefs.workspace, name, text: t, now: nowLocal(), ...(base ? { base_hash: base } : {}) });
        store.bumpLibrary();
        return name;
      }
      const asked2 = await act.askName(`Save ${boardName}'s effect script to Your library`, name || `${boardName} effect`);
      if (!asked2) return null;
      const r = await saveNewEffect(prefs.workspace, asked2, t);
      store.bumpLibrary();
      if (r.renamed) setNote({ tone: 'info', text: takenNote(asked2, r.name) });
      return r.name;
    } catch (e: any) {
      const m = String(e.message || e);
      setNote({ tone: 'error', text: m.startsWith('changed outside') ? `Not saved: “${name}” was changed in Your library since this board got it. Use “Compare with Your library” to see both.` : m });
      return null;
    }
  };

  const sendOnly = async () => {
    setNote(null);
    if (await act.sendEffect(boardKey, name, false, { text, gotoName })) forget();
  };
  const saveAndSend = async () => {
    setNote(null);
    const n = await saveToLibrary(text);
    if (n && await act.sendEffect(boardKey, n, false, { replacesBoardScript: true, gotoName })) forget();
  };
  const saveOnly = async (t = text, asked = false) => {
    setNote(null);
    const n = await saveToLibrary(t, asked);
    if (!n) return;
    await store.refreshScript(boardKey);
    if (t !== body) {
      forget();
      setNote({ tone: 'success', text: `Saved “${n}” to Your library. ${boardName} still runs its own version until you send it.` });
    } else setNote({ tone: 'success', text: `Saved “${n}” to Your library.` });
  };
  const openCompare = async () => {
    try { setCompare({ library: await call('library_read', { folder: prefs.workspace, name }), saved: s?.library_saved }); } catch (e: any) { setNote({ tone: 'error', text: String(e.message || e) }); }
  };
  const canSend = b.online && !!check?.ok;
  const differs = inLibrary && (s.status !== 'current' || dirty);
  // Ctrl+S / ⌘S runs the main button, Save and send; when it cannot send (the board is not answering, the script has
  // a problem) it saves to Your library only and says that the board did not get it
  saveKey.current = () => {
    if (!dirty) { setNote({ tone: 'info', text: `Nothing to save: this is the effect script ${boardName} runs.` }); return; }
    if (canSend) { void saveAndSend(); return; }
    const why = !b.online ? `${boardName} is not answering` : check && !check.ok ? 'the script has a problem to fix first' : 'the script is still being checked';
    void saveOnly().then(() => setNote((n) => (n?.tone === 'success' ? { tone: 'info', text: `${n.text} Not sent: ${why}.` } : n)));
  };

  return (
    <Stack spacing={1.5} data-testid="board-script-panel">
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
        {header && <Typography variant="body2" color="text.secondary" data-testid="board-script-header">Sent from Studio: “{header.name}”, saved {header.saved}</Typography>}
        <Box sx={{ flexGrow: 1 }} />
        {differs && <Button variant="outlined" onClick={() => void openCompare()}>Compare with Your library</Button>}
        <EditorViewSwitch value={view} onChange={(v) => store.setPrefs({ editorView: v })} />
      </Stack>
      {draft && draft.base !== body && <Alert severity="warning" action={<Button color="inherit" onClick={forget}>Use the board's script</Button>}>
        {boardName}'s effect script changed since you started editing here. Your edit is kept; send it to replace the board's, or use the board's.</Alert>}
      {note && <Alert severity={note.tone} onClose={() => setNote(null)} data-testid="board-script-message">{note.text}</Alert>}
      <Box role="group" aria-label="Effect script actions" sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, alignItems: 'center', p: 1.5, borderRadius: 2, bgcolor: 'background.paper', border: 1, borderColor: dirty ? 'primary.main' : 'divider', boxShadow: dirty ? (t) => `inset 4px 0 0 ${t.palette.primary.main}` : 'none' }} data-testid="board-script-actions">
        {dirty ? <>
          <Typography sx={{ fontWeight: 700, mr: 1 }}>Changed here, not sent yet.</Typography>
          <Button variant="contained" disabled={!canSend} onClick={() => void saveAndSend()}
            title={inLibrary ? `Saves it as “${name}” in Your library, then sends it to ${boardName}` : `Saves it in Your library under a name you choose, then sends it to ${boardName}`}>Save and send</Button>
          <Button variant="outlined" disabled={!canSend} onClick={() => void sendOnly()} title={`${boardName} gets it; Your library stays as it is`}>Send to this board only</Button>
          <Button onClick={() => void saveOnly()} title={`Your library gets it; ${boardName} keeps running its own version`}>Save to library only</Button>
          <Button color="inherit" onClick={forget}>Undo changes</Button>
          <Typography variant="body2" color="text.secondary" sx={{ flexBasis: '100%' }}>
            {inLibrary ? `Save and send keeps it as “${name}” in Your library and puts it on ${boardName}.` : `Save and send asks for a name, keeps it in Your library and puts it on ${boardName}.`}
            {!b.online ? ` ${boardName} is not answering; you can send once it answers again.` : check && !check.ok ? ' Fix the problems below before sending.' : ''}
            {` ${keyLabel(SAVE_KEYS)} does ${canSend ? 'Save and send' : 'Save to library only, for now'}.`}
          </Typography>
        </> : <>
          <Typography color="text.secondary" sx={{ mr: 1 }}>{body.trim() ? 'Type in the script or the blocks to change it.' : 'No effect script on this board yet. Type one here, or send one from Your library.'}</Typography>
          {s?.status === 'older' && <Button variant="contained" disabled={!b.online} onClick={() => void act.sendEffect(boardKey, name)}>Update to the newest “{name}”</Button>}
          {body.trim() && (s?.status === 'unknown' || s?.status === 'changed') && <Button variant="outlined" onClick={() => void saveOnly(body)}>Save it to Your library</Button>}
          <Button disabled={!b.online} onClick={async () => { const n = await act.pickEffect(`Send an effect to ${boardName}`); if (n) await act.sendEffect(boardKey, n); }}>Send another effect from Your library…</Button>
        </>}
      </Box>
      <ScriptEditor text={text} onChange={edit} dark={dark} gotoName={gotoName} checkWith={boardKey} self={boardKey} onCheck={setCheck} height="clamp(320px, 52vh, 720px)"
        footer={!b.online && <Typography variant="body2" color="text.secondary">{boardName} is not answering; you can send once it answers again.</Typography>} />
      {compare && <ScriptCompare name={name} boardName={boardName} boardText={text} libraryText={compare.library} librarySaved={compare.saved} dark={dark}
        onClose={() => setCompare(null)}
        onUseLibrary={async () => { setCompare(null); if (await act.sendEffect(boardKey, name, false, { replacesBoardScript: true })) forget(); }}
        onKeepBoard={() => { setCompare(null); void saveOnly(text, true); }} />}
    </Stack>
  );
}
