// The effect script editor itself, shared by the library's effect page and a board's page: the script as text
// (Monaco, the effect language's colours, completion and hover help) and as blocks side by side, the board's own
// checker as you type, and checker messages that go to their line. Whoever uses it owns the text and what saving
// means (the library's file, or a board).
import { ReactNode, useEffect, useRef, useState } from 'react';
import { Box, List, ListItem, ListItemButton, ListItemText, MenuItem, Stack, TextField, Typography } from '@mui/material';
import { OnMount } from '@monaco-editor/react';
import CodeEditor from '../components/CodeEditor';
import { call, rpc } from '../api';
import { useStore } from '../store';
import { setupMonaco } from './monaco';
import { keepOneIndent, LANG_ID, markersFromCheck } from './language';
import BlocksView, { BlocksApi } from './BlocksView';
import { setTerms, Sound, soundList, termsFor } from './terms';
import { fleetFrom, setFleet } from './fleet';
import { editorView, showsBlocks, showsScript } from '../editorView';
import { checkHint } from '../words';
import { GOTO_LINE } from '../components/actions';

setupMonaco();

export interface ScriptCheck { ok: boolean; effects?: number; errors: any[]; warnings: any[] }

export default function ScriptEditor({ text, onChange, dark, gotoName, checkWith = '', self = '', onCheck, height = 460, footer }: {
  text: string;
  onChange: (v: string) => void;
  dark: boolean;
  /** "Go to line" requests (a board's refusal after Send, actions.tsx) for this name land here */
  gotoName: string;
  /** the board whose settings the checker starts with ('' = a board with factory settings) */
  checkWith?: string;
  /** the board this script is for, when it is one board's own script: its tell lines never name it */
  self?: string;
  onCheck?: (c: ScriptCheck | null) => void;
  height?: number | string;
  /** shown under the checker's messages, beside "Check with the settings of" */
  footer?: ReactNode;
}) {
  const store = useStore();
  const { prefs, boards } = store;
  const view = editorView(prefs.editorView);
  const textRef = useRef(text);
  textRef.current = text;
  const [check, setCheck] = useState<ScriptCheck | null>(null);
  const [checkOn, setCheckOn] = useState(checkWith);
  useEffect(() => setCheckOn(checkWith), [checkWith]);
  const onCheckRef = useRef(onCheck);
  onCheckRef.current = onCheck;
  const editorRef = useRef<any>(null);
  const monacoRef = useRef<any>(null);

  // the board's own checker, 400 ms after typing stops (a board that is not answering: factory settings)
  const checkKey = checkOn && boards[checkOn]?.online ? checkOn : '';
  useEffect(() => {
    const t = setTimeout(async () => {
      let c: ScriptCheck;
      try {
        c = await call('check_script', checkKey ? { text, key: checkKey, folder: prefs.workspace } : { text, folder: prefs.workspace });
      } catch (e: any) {
        c = { ok: false, errors: [{ line: 0, message: `Cannot check right now: ${e.message || e}` }], warnings: [] };
      }
      setCheck(c);
      onCheckRef.current?.(c);
    }, 400);
    return () => clearTimeout(t);
  }, [text, checkKey, prefs.workspace, store.libraryVersion]);
  useEffect(() => {
    const m = editorRef.current?.getModel();
    if (m && monacoRef.current && check) monacoRef.current.editor.setModelMarkers(m, 'checker', markersFromCheck(check, m));
  }, [check]);

  // a clicked checker message: the script view puts the cursor on its line and marks the line; the blocks view
  // selects the block that holds it (blocks only, and no block holds it: the script view opens at that line)
  const blocksApi = useRef<BlocksApi | null>(null);
  const textBox = useRef<HTMLDivElement>(null);
  const lineMark = useRef<any>(null);
  const pendingLine = useRef<{ line: number; col?: number } | null>(null);
  const showLine = (line: number, col?: number) => {
    const ed = editorRef.current, monaco = monacoRef.current, m = ed?.getModel();
    if (!ed || !monaco || !m) return false;
    const ln = Math.min(Math.max(line, 1), m.getLineCount());
    const c = col && col > 0 ? Math.min(col, m.getLineMaxColumn(ln)) : (m.getLineFirstNonWhitespaceColumn(ln) || 1);
    ed.revealLineInCenter(ln);
    ed.setPosition({ lineNumber: ln, column: c });
    ed.focus();
    lineMark.current?.clear();
    lineMark.current = ed.createDecorationsCollection([{ range: new monaco.Range(ln, 1, ln, 1), options: { isWholeLine: true, className: 'goto-line', linesDecorationsClassName: 'goto-line-gutter' } }]);
    textBox.current?.setAttribute('data-goto-line', String(ln));
    return true;
  };
  const goTo = (line: number, col?: number) => {
    if (!(line > 0)) return;
    const inBlocks = showsBlocks(view) && !!blocksApi.current?.selectLine(line);
    if (showsScript(view)) { showLine(line, col); return; }
    if (!inBlocks) { pendingLine.current = { line, col }; store.setPrefs({ editorView: 'script' }); }
  };
  const goToRef = useRef(goTo);
  goToRef.current = goTo;
  useEffect(() => {
    const on = (e: Event) => { const d = (e as CustomEvent).detail; if (d?.name === gotoName) goToRef.current(d.line, d.col); };
    window.addEventListener(GOTO_LINE, on);
    return () => window.removeEventListener(GOTO_LINE, on);
  }, [gotoName]);
  const onMount: OnMount = (ed, monaco) => {
    editorRef.current = ed; monacoRef.current = monaco; keepOneIndent(ed, () => textRef.current);
    ed.onDidChangeCursorPosition((e: any) => textBox.current?.setAttribute('data-cursor-line', String(e.position.lineNumber)));
    const p = pendingLine.current;
    pendingLine.current = null;
    if (p) setTimeout(() => showLine(p.line, p.col), 0);
  };
  // the names the blocks' dropdowns and the typeahead offer: the board being checked with (its terminals, the names
  // given to them, its profile's aliases), else the default terminal set; the sounds of the library (or that board)
  const [soundNames, setSoundNames] = useState<Sound[]>([]);
  useEffect(() => { if (prefs.workspace) call('sounds', { folder: prefs.workspace }).then((m) => setSoundNames(soundList(m))).catch(() => {}); }, [prefs.workspace, store.libraryVersion]);
  const termsBoard = checkKey ? boards[checkKey] : undefined;
  const [profile, setProfile] = useState<any>(null);
  useEffect(() => {
    setProfile(null);
    if (checkKey) rpc(checkKey, { op: 'get_profile' }).then((r: any) => setProfile(r?.result?.profile ?? r?.result ?? null)).catch(() => {});
  }, [checkKey, termsBoard?.paramsSeq]);
  useEffect(() => {
    const boardSounds = soundList((termsBoard?.script as any)?.sounds);
    setTerms(termsFor(termsBoard?.info, profile, soundNames.length ? soundNames : boardSounds));
  }, [termsBoard?.info, profile, soundNames, termsBoard?.script]);

  // the other boards a tell line can name, their effects and the settings they take (fleet.ts): set only when that
  // list changes; each board's settings are read once, and again after they changed (paramsSeq)
  const [tellParams, setTellParams] = useState<Record<string, { seq: number; params: any[] }>>({});
  const askFor = Object.values(boards).filter((b) => b.online && !b.adapter && b.key !== self).map((b) => `${b.key}\n${b.paramsSeq || 0}`).join('\t');
  useEffect(() => {
    for (const item of askFor ? askFor.split('\t') : []) {
      const [key, seq] = item.split('\n');
      if (tellParams[key]?.seq === Number(seq)) continue;
      rpc(key, { op: 'get_params' }).then((r: any) => {
        if (r?.ok && Array.isArray(r.result?.params)) setTellParams((all) => ({ ...all, [key]: { seq: Number(seq), params: r.result.params } }));
      }).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [askFor]);
  const fleetKey = JSON.stringify(fleetFrom(boards, self, Object.fromEntries(Object.entries(tellParams).map(([k, v]) => [k, v.params]))));
  useEffect(() => setFleet(JSON.parse(fleetKey)), [fleetKey]);

  const errors = check?.errors || [];
  const warnings = check?.warnings || [];
  // the names given on the board being checked with (else on any board) help explain "there is no lamp"
  const terminals: { id: string; label?: string }[] = (checkKey ? [boards[checkKey]] : Object.values(boards)).flatMap((b) => b?.info?.terminals || []);
  const pane = { height, border: 1, borderColor: 'divider', borderRadius: 2, overflow: 'hidden', minWidth: 0 } as const;
  return (
    <Stack spacing={1.5}>
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: view === 'both' ? 'minmax(0, 1fr) minmax(0, 1fr)' : '1fr' }, gap: 1.5 }}>
        {showsScript(view) && <Box data-testid="text-editor" ref={textBox}
          sx={{ ...pane, '& .goto-line': { bgcolor: 'rgba(255, 193, 7, 0.28)' }, '& .goto-line-gutter': { bgcolor: 'warning.main', width: '4px !important', ml: '3px' } }}>
          <CodeEditor language={LANG_ID} dark={dark} value={text} onChange={onChange} onMount={onMount}
            options={{ minimap: { enabled: false }, wordWrap: 'on', lineNumbers: 'on', scrollBeyondLastLine: false, accessibilitySupport: 'auto', wordBasedSuggestions: 'off', tabSize: 2, insertSpaces: true, automaticLayout: true }} />
        </Box>}
        {showsBlocks(view) && <Box sx={pane} data-testid="blocks"><BlocksView text={text} onChange={onChange} dark={dark} apiRef={blocksApi} /></Box>}
      </Box>
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} alignItems={{ md: 'flex-start' }}>
        <Box sx={{ flexGrow: 1, minWidth: 0 }} role="status" aria-live="polite" data-testid="check">
          {check?.ok && <Typography color="success.main" sx={{ fontWeight: 700 }}>Looks good{check.effects ? ` (${check.effects} effect${check.effects > 1 ? 's' : ''})` : ''}.{warnings.length ? ' A note:' : ''}</Typography>}
          {!check ? <Typography>Checking…</Typography> : (errors.length > 0 || warnings.length > 0) && <List dense disablePadding>
              {errors.map((e: any, i: number) => <CheckItem key={'e' + i} kind="error" at={e} goTo={goTo}><ListItemText primary={e.message} secondary={checkHint(e.message, text.split(/\r?\n|\r/)[e.line - 1], terminals)} secondaryTypographyProps={{ color: 'text.primary', 'data-testid': 'check-hint' } as any} /></CheckItem>)}
              {warnings.map((e: any, i: number) => <CheckItem key={'w' + i} kind="warning" at={e} goTo={goTo}><ListItemText primary={e.message} /></CheckItem>)}
            </List>}
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>Keyboard: in the text editor Tab adds spaces; press Ctrl+M, then Tab, to move on.</Typography>
        </Box>
        <Stack spacing={1} sx={{ minWidth: 240 }}>
          <TextField select size="small" label="Check with the settings of" SelectProps={{ displayEmpty: true }} InputLabelProps={{ shrink: true }} value={checkOn && boards[checkOn] ? checkOn : ''} onChange={(e) => setCheckOn(e.target.value)}>
            <MenuItem value="">A board with factory settings</MenuItem>
            {Object.values(boards).filter((b) => b.online || b.key === checkOn).map((b) => <MenuItem key={b.key} value={b.key}>{b.info?.name}</MenuItem>)}
          </TextField>
          {footer}
        </Stack>
      </Stack>
    </Stack>
  );
}

// one checker message: a button that goes to its line (Enter or a click); line 0 (the whole script) is plain text
function CheckItem({ kind, at, goTo, children }: { kind: 'error' | 'warning'; at: { line: number; col?: number; message: string }; goTo: (line: number, col?: number) => void; children: ReactNode }) {
  const color = kind === 'error' ? 'error.main' : 'warning.main';
  if (!(at.line > 0)) return <ListItem sx={{ color }} className={kind === 'error' ? 'msg-error' : undefined}>{children}</ListItem>;
  return (
    <ListItem disablePadding sx={{ color }} className={kind === 'error' ? 'msg-error' : undefined}>
      <ListItemButton onClick={() => goTo(at.line, at.col)} data-testid={`check-${kind}`} title={`Go to line ${at.line}`}
        aria-label={`${at.message}. Go to line ${at.line}`} sx={{ borderRadius: 1, '&:hover .goto-hint, &:focus-visible .goto-hint': { opacity: 1 } }}>
        {children}
        <Typography component="span" variant="caption" className="goto-hint" sx={{ ml: 1, opacity: 0.7, whiteSpace: 'nowrap', color: 'text.secondary' }}>Go to line {at.line}</Typography>
      </ListItemButton>
    </ListItem>
  );
}
