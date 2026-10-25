// One LED pattern: its code (Monaco, the pattern language) beside a live preview strip with its controls. Save
// keeps it in the library (patterns/<name>.pattern.js); "Send to a board" puts the compiled program, with the
// preview's control values, on a board that plays patterns (SendPattern.tsx).
import { useEffect, useRef, useState } from 'react';
import { Alert, Box, Button, Chip, Stack, TextField, Typography } from '@mui/material';
import { call, rpc } from '../api';
import { useStore } from '../store';
import CodeEditor from '../components/CodeEditor';
import { setupMonaco } from '../effects/monaco';
import { PATTERN_LANG } from '../patterns/language';
import PatternPreview, { loadSavedControls, PreviewError } from '../patterns/PatternPreview';
import SendPattern from '../patterns/SendPattern';
import { useSaveShortcut } from '../shell/save';
import { titleOf } from '../scriptsRepo';

setupMonaco();

const pixelsKey = 'specter-pattern-pixels';
// unsaved edits, by pattern name, kept while Studio runs (going to another pattern or page loses nothing)
const drafts = new Map<string, string>();
function savedPixels(): number | null {
  try { const n = Number(localStorage.getItem(pixelsKey)); return n >= 1 && n <= 600 ? n : null; } catch { return null; }
}

/** The pixel count of a board that is online (its pixel_count setting), else 16. */
async function boardPixels(keys: string[]): Promise<number> {
  for (const k of keys) {
    try {
      const r = await rpc(k, { op: 'get_params' });
      const v = r?.result?.values?.find((x: any) => x.key === 'pixel_count')?.value;
      if (typeof v === 'number' && v >= 1 && v <= 600) return v;
    } catch { /* next board */ }
  }
  return 16;
}

export default function PatternEditor({ name, initial, readOnly, dark, onSaved }: { name: string; initial: string; readOnly: boolean; dark: boolean; onSaved: () => void }) {
  const { prefs, boards } = useStore();
  const [text, setTextState] = useState(() => drafts.get(name) ?? initial);
  const [saved, setSaved] = useState(initial);
  const savedRef = useRef(initial);
  savedRef.current = saved;
  const setText = (v: string) => { setTextState(v); if (v === savedRef.current) drafts.delete(name); else drafts.set(name, v); };
  const [msg, setMsg] = useState<{ tone: 'success' | 'error' | 'info'; text: string } | null>(() => drafts.has(name) ? { tone: 'info', text: 'Your changes here are not saved yet. Press Save to keep them.' } : null);
  const [pixels, setPixels] = useState<number>(() => savedPixels() ?? 16);
  const [pixelsText, setPixelsText] = useState(String(pixels));
  const editor = useRef<any>(null);
  const monaco = useRef<any>(null);
  useEffect(() => { setSaved(initial); if (!drafts.has(name)) setTextState(initial); }, [name, initial]);
  // no count chosen yet: a board's own
  useEffect(() => {
    if (savedPixels() !== null) return;
    const online = Object.values(boards).filter((b) => b.online && !b.adapter).map((b) => b.key);
    let live = true;
    void boardPixels(online).then((n) => { if (live && savedPixels() === null) { setPixels(n); setPixelsText(String(n)); } });
    return () => { live = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = text !== saved;
  const save = async () => {
    if (readOnly) return;
    try {
      await call('pattern_save', { folder: prefs.workspace, name, text });
      setSaved(text);
      drafts.delete(name);
      setMsg({ tone: 'success', text: 'Saved.' });
      onSaved();
    } catch (e: any) { setMsg({ tone: 'error', text: String(e.message || e) }); }
  };
  useSaveShortcut(`Save pattern “${titleOf(name)}”`, () => void save(), !readOnly);

  // the preview's message on its line in the code
  const showError = (e: PreviewError | null) => {
    const m = editor.current?.getModel();
    if (!m || !monaco.current) return;
    monaco.current.editor.setModelMarkers(m, 'pattern', e && e.line > 0 ? [{
      startLineNumber: e.line, endLineNumber: e.line, startColumn: 1, endColumn: m.getLineMaxColumn(Math.min(e.line, m.getLineCount())),
      message: e.message.replace(/^Line \d+: /, ''), severity: monaco.current.MarkerSeverity.Error,
    }] : []);
  };
  const setCount = (v: string) => {
    setPixelsText(v);
    const n = Math.floor(Number(v));
    if (n >= 1 && n <= 600) { setPixels(n); try { localStorage.setItem(pixelsKey, String(n)); } catch { /* not kept */ } }
  };

  return (
    <Stack spacing={2} data-testid="pattern-editor">
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}>
        <Typography variant="h5" component="h2" sx={{ mr: 1 }}>{titleOf(name)}</Typography>
        <Chip size="small" variant="outlined" label="LED pattern" />
        {dirty && <Chip size="small" color="warning" label="not saved" />}
        <Box sx={{ flex: 1 }} />
        <SendPattern name={titleOf(name)} source={text} controls={() => loadSavedControls(name)} />
        {!readOnly && <Button variant="contained" onClick={() => void save()} disabled={!dirty}>Save</Button>}
      </Stack>
      {readOnly && <Alert severity="info">This pattern is in a read-only script source: changes here are for trying out and are not saved.</Alert>}
      {msg && <Alert severity={msg.tone} onClose={() => setMsg(null)}>{msg.text}</Alert>}
      <Typography variant="body2" color="text.secondary">
        A pattern gives every light of an LED strip its colour, many times a second. <code>render(index)</code> runs for each light and colours it with <code>hsv()</code> or <code>rgb()</code>; hover a word in the code for help.
      </Typography>
      <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', lg: 'minmax(0, 3fr) minmax(280px, 2fr)' } }}>
        <Box sx={{ height: 460, border: 1, borderColor: 'divider', borderRadius: 1, overflow: 'hidden' }} data-testid="pattern-code">
          <CodeEditor value={text} onChange={setText} language={PATTERN_LANG} dark={dark}
            onMount={(e, m) => { editor.current = e; monaco.current = m; }}
            options={{ minimap: { enabled: false }, scrollBeyondLastLine: false, tabSize: 2, automaticLayout: true, wordWrap: 'on' }} />
        </Box>
        <Stack spacing={2}>
          <TextField size="small" type="number" label="Number of lights" value={pixelsText} onChange={(e) => setCount(e.target.value)}
            slotProps={{ htmlInput: { min: 1, max: 600 } }} helperText="1 to 600; a board's own strip is usually 16" sx={{ maxWidth: 220 }} />
          <PatternPreview source={text} id={name} pixels={pixels} onError={showError} />
        </Stack>
      </Box>
    </Stack>
  );
}
