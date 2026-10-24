// The SD card tool: put sounds on the card for the board's sound player (a DFPlayer Mini), numbered and in the
// right order, and check a card. The card work happens in the core (core/src/sdcard); this page lists the
// sounds, picks the card, asks before anything is erased and shows the number -> file map.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert, Box, Button, Checkbox, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, IconButton,
  LinearProgress, Radio, Stack, TextField, Tooltip, Typography,
} from '@mui/material';
import ArrowUpward from '@mui/icons-material/ArrowUpward';
import ArrowDownward from '@mui/icons-material/ArrowDownward';
import DragIndicator from '@mui/icons-material/DragIndicator';
import Close from '@mui/icons-material/Close';
import { call, inTauri, onEvent, pickFiles, pickFolder, pickSavePath } from '../api';
import { useStore } from '../store';
import { useBoardActions } from '../components/actions';
import { sectionSx, sectionsSx } from '../components/section';
import { cardName, isAudio, mapText, MP3_FOLDER_MAX, move, sizeWords, soundsCsv, type MapRow } from '../sdcard/list';

interface SoundItem { id: number; path: string; name: string; description: string; ext: string; size: number; ok: boolean; why?: string | null }
interface DriveChoice {
  id: string; name: string; label: string; mount?: string | null; size: number; removable: boolean; fs: string; fs_words: string;
  can_write: boolean; why?: string | null; warn?: string | null; fake?: boolean;
}
interface CheckReport {
  files: { position: number; name: string; number: number | null; description: string; size: number }[];
  problems: { code: string; words: string; names: string[]; fixable: boolean }[];
  fs_words: string | null; fixable: boolean;
}
interface Progress { phase: string; done: number; total: number; file: string }

const AUDIO_FILTER = [{ name: 'Sounds (MP3, WAV)', extensions: ['mp3', 'wav', 'MP3', 'WAV'] }];
const errText = (e: any) => String(e?.message || e);
let nextId = 1;

function progressWords(p: Progress) {
  switch (p.phase) {
    case 'format': return 'Erasing and formatting the card… (your computer may ask for your password)';
    case 'clear': return 'Deleting the old files on the card…';
    case 'backup': return `Copying the card's sounds to this computer first: ${p.done + 1} of ${p.total}`;
    case 'copy': return p.done < p.total ? `Copying sound ${p.done + 1} of ${p.total}: ${p.file}` : 'Finishing…';
    default: return 'Done.';
  }
}

/** The sounds, in card order: drag the handle, or use the up and down buttons. */
function SoundList({ items, setItems }: { items: SoundItem[]; setItems: (f: (l: SoundItem[]) => SoundItem[]) => void }) {
  const rows = useRef<(HTMLLIElement | null)[]>([]);
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null);
  const indexAt = (y: number) => {
    let i = 0;
    rows.current.forEach((r, k) => { if (r && y > r.getBoundingClientRect().top + r.getBoundingClientRect().height / 2) i = k; });
    const first = rows.current[0]?.getBoundingClientRect();
    return first && y < first.top + first.height / 2 ? 0 : i;
  };
  const shown = drag ? move(items, drag.from, drag.to) : items;
  return (
    <Box component="ol" aria-label="Sounds, in card order" data-testid="sd-sounds" sx={{ listStyle: 'none', p: 0, m: 0, border: 1, borderColor: 'divider', borderRadius: 1 }}>
      {shown.map((s, i) => (
        <Box component="li" key={s.id} ref={(el: HTMLLIElement | null) => { rows.current[i] = el; }} data-testid="sd-sound"
          sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1, py: 0.5, borderTop: i ? 1 : 0, borderColor: 'divider', bgcolor: drag && drag.to === i ? 'action.selected' : undefined }}>
          <Box aria-hidden title="Drag to move" sx={{ cursor: 'grab', display: 'flex', color: 'text.secondary', touchAction: 'none' }}
            onPointerDown={(e) => { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); setDrag({ from: i, to: i }); }}
            onPointerMove={(e) => { if (drag) { const to = indexAt(e.clientY); if (to !== drag.to) setDrag({ ...drag, to }); } }}
            onPointerUp={() => { if (drag) { const d = drag; setDrag(null); setItems((l) => move(l, d.from, d.to)); } }}
            onPointerCancel={() => setDrag(null)}>
            <DragIndicator fontSize="small" />
          </Box>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography noWrap data-testid="sd-sound-label"><b>{i + 1}</b> · {s.description}</Typography>
            <Typography variant="caption" color={s.ok ? 'text.secondary' : 'error'} noWrap component="p">
              {s.ok ? `${cardName(i + 1, s.description, s.ext)} · ${sizeWords(s.size)}` : `${s.name}: ${s.why}`}
            </Typography>
          </Box>
          <Tooltip title="Move up"><span><IconButton size="small" aria-label={`Move ${s.description} up`} disabled={i === 0} onClick={() => setItems((l) => move(l, i, i - 1))}><ArrowUpward fontSize="small" /></IconButton></span></Tooltip>
          <Tooltip title="Move down"><span><IconButton size="small" aria-label={`Move ${s.description} down`} disabled={i === shown.length - 1} onClick={() => setItems((l) => move(l, i, i + 1))}><ArrowDownward fontSize="small" /></IconButton></span></Tooltip>
          <Tooltip title="Take off the list (the file stays on your computer)"><IconButton size="small" aria-label={`Remove ${s.description}`} onClick={() => setItems((l) => l.filter((x) => x.id !== s.id))}><Close fontSize="small" /></IconButton></Tooltip>
        </Box>
      ))}
    </Box>
  );
}

export default function SdCard() {
  const { prefs } = useStore();
  const act = useBoardActions();
  const [sounds, setSounds] = useState<SoundItem[]>([]);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [drives, setDrives] = useState<DriveChoice[]>([]);
  const [info, setInfo] = useState<{ card_max_bytes: number; windows: boolean; windows_fat32_max_bytes: number } | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [picked, setPicked] = useState('');
  const [format, setFormat] = useState(true);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [erase, setErase] = useState<{ typed: string } | null>(null);
  const [del, setDel] = useState<string[] | null>(null);
  const [result, setResult] = useState<{ map: MapRow[]; notes: string[] } | null>(null);
  const [saved, setSaved] = useState('');
  const [report, setReport] = useState<{ where: string; card: boolean; r: CheckReport } | null>(null);
  const [fixed, setFixed] = useState<any>(null);
  const drive = drives.find((d) => d.id === picked);

  const add = useCallback(async (paths: string[]) => {
    if (!paths.length) return;
    try {
      const got: any[] = await call('sdcard_sounds', { files: paths });
      setSounds((l) => {
        const have = new Set(l.map((s) => s.path));
        return [...l, ...got.filter((g) => g.ok && !have.has(g.path)).map((g) => ({ ...g, id: nextId++ }))];
      });
      const bad = got.filter((g) => !g.ok);
      setNote(bad.length ? `Not added: ${bad.map((b) => `${b.name} (${b.why})`).join(', ')}. The sound player plays MP3 and WAV files.` : '');
      setResult(null);
    } catch (e) { setError(errText(e)); }
  }, []);

  const readDrives = useCallback(async (all = showAll) => {
    try {
      const r = await call('sdcard_drives', { show_all: all });
      setDrives(r.drives);
      setInfo(r);
      setPicked((p) => (r.drives.some((d: DriveChoice) => d.id === p) ? p : r.drives.find((d: DriveChoice) => d.can_write)?.id || ''));
    } catch (e) { setError(errText(e)); }
  }, [showAll]);
  useEffect(() => { void readDrives(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => onEvent((e) => { if (e.kind === 'sd_card') setProgress({ phase: e.phase, done: e.done, total: e.total, file: e.file }); }), []);

  // sound files dragged onto the window (the desktop app gives their paths)
  useEffect(() => {
    if (!inTauri) return;
    let stop: (() => void) | undefined;
    let gone = false;
    void import('@tauri-apps/api/webview').then(({ getCurrentWebview }) => getCurrentWebview().onDragDropEvent((ev) => {
      if (ev.payload.type === 'drop') void add(ev.payload.paths.filter(isAudio));
    })).then((u) => { if (gone) u(); else stop = u; });
    return () => { gone = true; stop?.(); };
  }, [add]);

  const tooBigForWindows = !!(info?.windows && drive && format && drive.size > info.windows_fat32_max_bytes);
  const canCopy = !busy && sounds.length > 0 && sounds.length <= MP3_FOLDER_MAX && !!drive?.can_write && !tooBigForWindows;

  const write = async (extra: Record<string, unknown>) => {
    setBusy(true); setError(''); setResult(null); setSaved(''); setReport(null); setFixed(null);
    setProgress({ phase: format ? 'format' : 'clear', done: 0, total: sounds.length, file: '' });
    try {
      const r = await call('sdcard_write', { drive: picked, files: sounds.map((s) => s.path), format, ...extra });
      setResult({ map: r.map, notes: r.notes || [] });
      void readDrives();
    } catch (e) { setError(errText(e)); }
    setBusy(false); setProgress(null);
  };
  const startCopy = async () => {
    setError('');
    if (format) { setErase({ typed: '' }); return; }
    try {
      const plan = await call('sdcard_plan', { drive: picked });
      if (plan.delete.length === 0) void write({ delete: [] });
      else setDel(plan.delete);
    } catch (e) { setError(errText(e)); }
  };

  const eject = async () => {
    try { const r = await call('sdcard_eject', { drive: picked }); setNote(r.message); void readDrives(); } catch (e) { setError(errText(e)); }
  };

  const check = async (folder?: string) => {
    setError(''); setFixed(null);
    try {
      const r = await call<CheckReport>('sdcard_check', folder ? { folder } : { drive: picked });
      setReport({ where: folder || drive?.name || '', card: !folder, r });
    } catch (e) { setError(errText(e)); }
  };
  const fix = async () => {
    if (!drive) return;
    if (!(await act.confirm(`Fix the card “${drive.name}”?`, 'Studio first copies every file in the card\'s mp3 folder to this computer and checks the copies. Only then it deletes the mp3 folder and writes the sounds back in number order, numbered 1, 2, 3 … without gaps. Hidden Mac files are deleted. Files the player cannot play stay only in the copy on this computer.', 'Fix the card'))) return;
    setBusy(true); setError('');
    try {
      const r = await call('sdcard_fix', { drive: picked });
      setFixed(r);
      await check();
    } catch (e) { setError(errText(e)); }
    setBusy(false); setProgress(null);
  };

  const rows: MapRow[] = result?.map.map((r) => ({ number: r.number, name: r.name })) || [];
  // sounds.csv: the number and the sound's original file name (`1,rain.mp3`)
  const originals = (result?.map || []).map((r: any) => ({ number: r.number, file: String(r.source || '').split(/[\\/]/).pop() || r.name }));
  const ws = prefs.workspace;
  const sep = ws.includes('\\') && !ws.includes('/') ? '\\' : '/';

  return (
    <Box sx={sectionsSx}>
      <Typography variant="h5" component="h2">SD card for sounds</Typography>
      <Typography sx={{ mt: 1 }}>
        The board's sound player plays sounds from an SD card by number: in a script, <code>audio_single = 3</code> plays sound 3.
        Studio puts your sounds on the card in the right order, named <code>mp3/0001-rain.mp3</code>, <code>mp3/0002-elevator.mp3</code> and so on.
      </Typography>
      <Typography color="text.secondary" sx={{ mt: 1 }}>
        The player plays MP3 and WAV files (8 to 48 kHz), up to {MP3_FOLDER_MAX} of them. It counts the files in the order they were written to the card,
        not by name, so always put sounds on with Studio (dragging files onto the card yourself can mix the numbers up).
      </Typography>
      {error && <Alert severity="error" onClose={() => setError('')} sx={{ mt: 2 }} data-testid="sd-error">{error}</Alert>}
      {note && <Alert severity="info" onClose={() => setNote('')} sx={{ mt: 2 }} data-testid="sd-note">{note}</Alert>}

      <Box sx={sectionSx}>
        <Typography variant="h6" component="h3">1. Your sounds</Typography>
        <Box onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); if (!inTauri) setNote('Dragging files in works in the Specter Studio app. Here, press Add sounds….'); }}
          sx={{ mt: 1, p: 2, border: 1, borderStyle: 'dashed', borderColor: 'divider', borderRadius: 1 }}>
          <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap" useFlexGap>
            <Button variant="contained" disabled={busy} onClick={async () => add(await pickFiles('Add sounds (MP3 or WAV)', AUDIO_FILTER))}>Add sounds…</Button>
            <Typography color="text.secondary">or drag MP3 and WAV files here. Sound 1 is at the top.</Typography>
          </Stack>
          {sounds.length > 0 && <Box sx={{ mt: 2 }}><SoundList items={sounds} setItems={(f) => { setSounds(f); setResult(null); }} /></Box>}
          {sounds.length > MP3_FOLDER_MAX && <Alert severity="error" sx={{ mt: 1 }}>That is {sounds.length} sounds; the player plays at most {MP3_FOLDER_MAX}.</Alert>}
        </Box>
      </Box>

      <Box sx={sectionSx}>
        <Typography variant="h6" component="h3">2. The SD card</Typography>
        <Typography color="text.secondary">Put the card in the computer's card reader (or a USB card reader), then pick it here.</Typography>
        <Stack direction="row" spacing={2} alignItems="center" sx={{ mt: 1 }}>
          <Button variant="outlined" onClick={() => void readDrives()}>Refresh</Button>
          <FormControlLabel control={<Checkbox checked={showAll} onChange={(e) => { setShowAll(e.target.checked); void readDrives(e.target.checked); }} />} label="Show all drives" />
        </Stack>
        {showAll && <Alert severity="warning" sx={{ mt: 1 }}>All drives are shown, the big ones and the ones built into the computer too. Studio still never erases a drive built into the computer, but be sure you pick the SD card.</Alert>}
        <Box role="radiogroup" aria-label="SD cards" sx={{ mt: 1 }}>
          {drives.length === 0 && <Typography sx={{ py: 1 }} data-testid="sd-no-card">No SD card found. Put one in and press Refresh.</Typography>}
          {drives.map((d) => (
            <Box key={d.id} data-testid={`sd-drive-${d.name}`} sx={{ display: 'flex', alignItems: 'flex-start', gap: 1, py: 0.5 }}>
              <Radio checked={picked === d.id} onChange={() => { setPicked(d.id); setReport(null); }} inputProps={{ 'aria-label': `${d.name}, ${sizeWords(d.size)}, ${d.fs_words}` }} sx={{ p: 0.5 }} />
              <Box>
                <Typography><b>{d.name}</b> · {sizeWords(d.size)} · {d.fs_words}{d.mount ? ` · ${d.mount}` : ''}</Typography>
                {d.why && <Typography variant="body2" color="text.secondary">{d.why}</Typography>}
                {d.warn && <Typography variant="body2" color="warning.main">{d.warn}</Typography>}
              </Box>
            </Box>
          ))}
        </Box>
        <FormControlLabel sx={{ mt: 1 }} control={<Checkbox checked={format} onChange={(e) => setFormat(e.target.checked)} />}
          label="Erase and format the card as FAT32 first (best: a clean card in the format the player reads)" />
        {!format && <Typography variant="body2" color="text.secondary">Without formatting, Studio shows you every file on the card, deletes them all when you agree, and makes the mp3 folder new.</Typography>}
        {tooBigForWindows && <Alert severity="warning" sx={{ mt: 1 }} data-testid="sd-windows-big">
          Windows' own format tool will not make FAT32 on a card bigger than 32 GB. Either use a card of 32 GB or less (plenty for sounds), or format this card
          once with a free tool such as “FAT32 Format” or Rufus, then untick “Erase and format” and copy again.
        </Alert>}
      </Box>

      <Box sx={sectionSx}>
        <Typography variant="h6" component="h3">3. Copy</Typography>
        <Stack direction="row" spacing={2} alignItems="center" sx={{ mt: 1 }}>
          <Button variant="contained" disabled={!canCopy} onClick={() => void startCopy()} data-testid="sd-copy">Copy {sounds.length || ''} sound{sounds.length === 1 ? '' : 's'} to the card</Button>
          {!sounds.length && <Typography color="text.secondary">Add sounds first.</Typography>}
          {sounds.length > 0 && !drive && <Typography color="text.secondary">Pick the SD card first.</Typography>}
          {drive && !drive.can_write && <Typography color="text.secondary">Studio does not write to this drive.</Typography>}
        </Stack>
        {progress && busy && <Box sx={{ mt: 2 }} data-testid="sd-progress">
          <Typography variant="body2">{progressWords(progress)}</Typography>
          <LinearProgress variant={progress.total && (progress.phase === 'copy' || progress.phase === 'backup') ? 'determinate' : 'indeterminate'} value={progress.total ? (100 * progress.done) / progress.total : 0} aria-label="Progress" />
        </Box>}
        {result && (
          <Box sx={{ mt: 2 }} data-testid="sd-map">
            <Alert severity="success">The sounds are on the card, in this order. {result.notes.join(' ')}</Alert>
            <Box component="table" sx={{ mt: 2, borderCollapse: 'collapse', '& td, & th': { py: 0.5, pr: 3, textAlign: 'left', borderBottom: 1, borderColor: 'divider' } }}>
              <thead><tr><th scope="col">Number in scripts</th><th scope="col">File on the card</th></tr></thead>
              <tbody>{result.map.map((r) => <tr key={r.number} data-testid="sd-map-row"><td>{r.number}</td><td>{r.name}</td></tr>)}</tbody>
            </Box>
            <Stack direction="row" spacing={1} sx={{ mt: 2 }} flexWrap="wrap" useFlexGap>
              <Button variant="outlined" onClick={() => { void navigator.clipboard?.writeText(mapText(rows)).then(() => setSaved('The list is copied.'), () => setError('Studio could not copy the list.')); }}>Copy list</Button>
              <Button variant="outlined" onClick={async () => {
                const p = await pickSavePath('Save the list', 'sound numbers.csv', [{ name: 'CSV (for spreadsheets)', extensions: ['csv'] }, { name: 'Text', extensions: ['txt'] }]);
                if (!p) return;
                try { const r = await call('sdcard_save_list', { path: p, rows }); setSaved(`Saved ${r.path}.`); } catch (e) { setError(errText(e)); }
              }}>Save list…</Button>
              {ws && <Button variant="outlined" onClick={async () => {
                try { await call('file_write', { folder: ws, path: `${ws}${sep}sounds.csv`, text: soundsCsv(originals) }); setSaved('Saved as sounds.csv in your library: the editor can show these names next to the numbers.'); } catch (e) { setError(errText(e)); }
              }}>Keep the list with your library</Button>}
              <Button variant="contained" onClick={() => void eject()}>Eject the card</Button>
            </Stack>
            {saved && <Typography sx={{ mt: 1 }} color="text.secondary" data-testid="sd-saved">{saved}</Typography>}
          </Box>
        )}
      </Box>

      <Box sx={sectionSx}>
        <Typography variant="h6" component="h3">Check a card</Typography>
        <Typography color="text.secondary">Reads the card and tells you, in the order the player sees them, which sound each number plays, and anything that would make a number play the wrong sound.</Typography>
        <Stack direction="row" spacing={2} sx={{ mt: 1 }}>
          <Button variant="outlined" disabled={!drive || busy} onClick={() => void check()} data-testid="sd-check">Check the card</Button>
          <Button onClick={async () => { const f = await pickFolder('Check a folder (a copy of a card)'); if (f) void check(f); }} disabled={busy}>Check a folder…</Button>
        </Stack>
        {report && (
          <Box sx={{ mt: 2 }} data-testid="sd-check-report">
            {report.r.problems.length === 0
              ? <Alert severity="success">No problems found on {report.where}{report.r.fs_words ? ` (${report.r.fs_words})` : ''}: {report.r.files.length} sound{report.r.files.length === 1 ? '' : 's'}, in order.</Alert>
              : <Stack spacing={1}>{report.r.problems.map((p) => <Alert key={p.code} severity="warning" data-testid={`sd-problem-${p.code}`}>{p.words}</Alert>)}</Stack>}
            {report.r.fixable && report.card && drive?.can_write && (
              <Button variant="contained" sx={{ mt: 2 }} disabled={busy} onClick={() => void fix()}>Fix the card…</Button>
            )}
            {report.r.files.length > 0 && (
              <Box component="ol" aria-label="Sounds on the card, in the order the player sees them" sx={{ mt: 2, pl: 3 }}>
                {report.r.files.map((f) => <li key={f.position}>{f.name}{f.number !== null && f.number !== f.position ? ` (named ${f.number}, plays as ${f.position})` : ''}</li>)}
              </Box>
            )}
          </Box>
        )}
        {fixed && (
          <Alert severity="info" sx={{ mt: 2 }} data-testid="sd-fixed">
            The card is fixed. A copy of what was on it is kept on this computer in {fixed.backup}.
            {fixed.renamed?.length > 0 && <> Changed numbers (update scripts that use them): {fixed.renamed.map((r: any) => `${r.from} is now ${r.number}`).join('; ')}.</>}
            {fixed.left_off?.length > 0 && <> Not put back (the player cannot play them): {fixed.left_off.join(', ')}.</>}
          </Alert>
        )}
      </Box>

      {erase && drive && (
        <Dialog open onClose={() => setErase(null)} aria-labelledby="sd-erase-title">
          <form onSubmit={(e) => { e.preventDefault(); if (erase.typed.trim().toLowerCase() === drive.name.trim().toLowerCase()) { setErase(null); void write({ confirm: erase.typed }); } }}>
            <DialogTitle id="sd-erase-title">Erase “{drive.name}”?</DialogTitle>
            <DialogContent>
              <Typography gutterBottom>Everything on this card ({sizeWords(drive.size)}) is erased, then it is formatted as FAT32 and your {sounds.length} sound{sounds.length === 1 ? '' : 's'} are copied onto it. This cannot be undone.</Typography>
              <Typography gutterBottom color="text.secondary">Your computer may ask for your password: formatting a card needs it on some computers.</Typography>
              <TextField autoFocus fullWidth sx={{ mt: 2 }} label={`Type the card's name to confirm: ${drive.name}`} value={erase.typed} onChange={(e) => setErase({ typed: e.target.value })} inputProps={{ 'aria-label': "The card's name" }} />
            </DialogContent>
            <DialogActions>
              <Button onClick={() => setErase(null)}>Cancel</Button>
              <Button type="submit" color="error" variant="contained" disabled={erase.typed.trim().toLowerCase() !== drive.name.trim().toLowerCase()}>Erase and copy</Button>
            </DialogActions>
          </form>
        </Dialog>
      )}
      {del && (
        <Dialog open onClose={() => setDel(null)} aria-labelledby="sd-delete-title" fullWidth maxWidth="sm">
          <DialogTitle id="sd-delete-title">Delete these files from the card?</DialogTitle>
          <DialogContent>
            <Typography gutterBottom>To keep the numbers right, Studio deletes everything on the card first ({del.length} file{del.length === 1 ? '' : 's'} and folder{del.length === 1 ? '' : 's'}), then copies your sounds:</Typography>
            <Box component="ul" data-testid="sd-delete-list" sx={{ maxHeight: 260, overflow: 'auto', fontFamily: 'monospace', fontSize: 'body2.fontSize' }}>
              {del.map((n) => <li key={n}>{n}</li>)}
            </Box>
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setDel(null)}>Cancel</Button>
            <Button color="error" variant="contained" onClick={() => { const d = del; setDel(null); void write({ delete: d }); }}>Delete and copy</Button>
          </DialogActions>
        </Dialog>
      )}
    </Box>
  );
}
