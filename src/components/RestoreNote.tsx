// After a crash (or a kill, or the computer shutting down) with unsaved work: one calm note that lists what came
// back, with Keep / Discard each, and the two versions side by side when an effect was saved elsewhere since.
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Alert, AlertTitle, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Stack, Typography } from '@mui/material';
import { call, nowLocal } from '../api';
import { hotExit, Restored } from '../hotexit';
import { dropDraft, getDraft } from '../drafts';
import { useStore } from '../store';

/** Re-renders when restored items change. */
export function useHotExit() {
  return useSyncExternalStore((f) => hotExit.subscribe(f), () => hotExit.version);
}

function plural(n: number, one: string) {
  return `${n} ${one}${n === 1 ? '' : 's'}`;
}

function Row({ item, onCompare }: { item: Restored; onCompare: (name: string) => void }) {
  const { prefs, bumpLibrary } = useStore();
  const [err, setErr] = useState('');
  let text: string;
  let actions: JSX.Element;
  if (item.kind === 'effect' && item.conflict) {
    text = `The effect “${item.name}”: it was saved again since then, so there are two versions.`;
    actions = <Button size="small" variant="outlined" onClick={() => onCompare(item.name)}>Compare and pick…</Button>;
  } else if (item.kind === 'effect' && item.missing) {
    text = `The effect “${item.name}”: it is no longer in your library.`;
    actions = (
      <>
        <Button size="small" variant="outlined" onClick={async () => {
          try {
            await call('library_save', { folder: prefs.workspace, name: item.name, text: item.text, now: nowLocal() });
            dropDraft(item.name);
            hotExit.keep(item);
            bumpLibrary();
          } catch (e: any) { setErr(String(e.message || e)); }
        }}>Save it to your library</Button>
        <Button size="small" onClick={() => hotExit.discard(item)}>Discard</Button>
      </>
    );
  } else if (item.kind === 'effect') {
    text = `The effect “${item.name}”: not saved yet. Open it in Your library and press Save to keep it there.`;
    actions = (
      <>
        <Button size="small" variant="outlined" onClick={() => hotExit.keep(item)}>Keep</Button>
        <Button size="small" onClick={() => hotExit.discard(item)}>Discard</Button>
      </>
    );
  } else {
    const n = Object.keys(item.edits).length;
    text = item.board
      ? `The settings of ${item.name}: ${plural(n, 'change')} not sent to the board yet. Open the board's Settings to send them.`
      : `The settings of ${item.name}: ${plural(n, 'change')} not sent yet. They come back when ${item.name} is connected.`;
    actions = (
      <>
        <Button size="small" variant="outlined" onClick={() => hotExit.keep(item)}>Keep</Button>
        <Button size="small" onClick={() => hotExit.discard(item)}>Discard</Button>
      </>
    );
  }
  const label = item.kind === 'effect' ? `effect ${item.name}` : `settings of ${item.name}`;
  return (
    <Box data-testid={`restored-${label}`}>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'center' }}>
        <Typography sx={{ flexGrow: 1 }}>{text}</Typography>
        <Stack direction="row" spacing={1} role="group" aria-label={label}>{actions}</Stack>
      </Stack>
      {err && <Typography color="error" variant="body2">{err}</Typography>}
    </Box>
  );
}

function Compare({ name, onClose }: { name: string; onClose: () => void }) {
  const item = hotExit.effectItem(name);
  if (!item) return null;
  const pane = (title: string, text: string, testid: string) => (
    <Box sx={{ minWidth: 0 }}>
      <Typography variant="subtitle1" component="h3" sx={{ fontWeight: 700 }}>{title}</Typography>
      <Box component="pre" data-testid={testid} sx={{ m: 0, p: 1.5, border: 1, borderColor: 'divider', borderRadius: 1, bgcolor: 'action.hover', overflow: 'auto', maxHeight: 360, fontSize: 14, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{text}</Box>
    </Box>
  );
  return (
    <Dialog open onClose={onClose} maxWidth="lg" fullWidth>
      <DialogTitle>Two versions of “{name}”</DialogTitle>
      <DialogContent>
        <Typography gutterBottom>Your library has a newer save of this effect than the changes Studio kept for you. Pick the one to keep.</Typography>
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 2 }}>
          {pane('Your unsaved changes (from last time)', getDraft(name) ?? item.text, 'compare-mine')}
          {pane('In your library now', item.library ?? '', 'compare-library')}
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Decide later</Button>
        <Button onClick={() => { hotExit.useLibrary(item); onClose(); }}>Use the library's version</Button>
        <Button variant="contained" onClick={() => { hotExit.keepMine(item); onClose(); }}>Keep my changes</Button>
      </DialogActions>
    </Dialog>
  );
}

export default function RestoreNote() {
  const { prefs, boards } = useStore();
  useHotExit();
  const [compare, setCompare] = useState<string | null>(null);
  // last time's unsaved work, once the library folder is known
  useEffect(() => { if (prefs.workspace) void hotExit.restore(prefs.workspace); }, [prefs.workspace]);
  useEffect(() => hotExit.onCompare(setCompare), []);
  // restored settings go to their board when it connects
  useEffect(() => {
    if (!hotExit.pending.size) return;
    for (const b of Object.values(boards)) if (b.info) hotExit.boardConnected(b.key, b.info.id, b.info.name);
  }, [boards, hotExit.version]);
  const items = hotExit.restored;
  return (
    <>
      {items.length > 0 && (
        <Alert severity="info" sx={{ mb: 2 }} data-testid="restore-note">
          <AlertTitle>Restored your unsaved changes from last time</AlertTitle>
          <Typography gutterBottom>Studio closed before they were saved, so it kept them for you. Keep them or discard them:</Typography>
          <Stack spacing={1}>{items.map((it) => <Row key={it.kind === 'effect' ? `e:${it.name}` : `s:${it.id}`} item={it} onCompare={setCompare} />)}</Stack>
        </Alert>
      )}
      {compare && <Compare name={compare} onClose={() => setCompare(null)} />}
    </>
  );
}
