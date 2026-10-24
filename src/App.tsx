// The window, laid out like a desktop editor (VS Code): a title bar (back / forward, the search box that opens
// the command palette, Stop all boards), an activity bar of places on the left, a side bar (boards, Your library),
// the work area, and a thin status bar. Everything is reachable from the keyboard and the command palette.
import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Box, Button, ButtonBase, Checkbox, CssBaseline, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel,
  IconButton, ListItemText, Menu, MenuItem, Switch, Tab, Tabs, TextField, ThemeProvider, Tooltip, Typography, useMediaQuery, useTheme,
} from '@mui/material';
import DarkMode from '@mui/icons-material/DarkMode';
import LightMode from '@mui/icons-material/LightMode';
import ArrowBack from '@mui/icons-material/ArrowBack';
import ArrowForward from '@mui/icons-material/ArrowForward';
import Search from '@mui/icons-material/Search';
import Check from '@mui/icons-material/Check';
import { clampZoom, makeTheme, resolveTheme, THEME_IDS, THEMES, ThemePref, ZOOM_STEP } from './theme';
import { Loc, NavContext, useHistory, useNav } from './nav';
import { useStore } from './store';
import { call, onConnection } from './api';
import { useBoardActions } from './components/actions';
import FirstRun from './components/FirstRun';
import { FleetServerWork } from './components/FleetServer';
import { ScriptsRepoStatus, ScriptsRepoWork, useScriptsCommands } from './components/ScriptsRepo';
import { onPluginsChanged } from './pluginsChanged';
import DashboardWork from './dashboard/DashboardWork';
import PropRunsWork from './props/PropRunsWork';
import Adapters from './components/Adapters';
import RestoreNote from './components/RestoreNote';
import { practiceName } from './words';
import { views, View } from './shell/views';
import { SideBarSlot } from './shell/SideBar';
import Splitter from './shell/Splitter';
import CommandPalette, { Command } from './shell/CommandPalette';
import { isMac, keyLabel, matches } from './shell/keys';
import { currentSave, handleSaveKey, runSave, useSaveVersion, SAVE_KEYS } from './shell/save';
import { boardLink, boardsRunning, VERSION_WORDS } from './scriptLinks';

function PinDialog() {
  const { pinRequest, boards } = useStore();
  const [pin, setPin] = useState('');
  const [remember, setRemember] = useState(false);
  useEffect(() => { setPin(''); setRemember(false); }, [pinRequest]);
  if (!pinRequest) return null;
  const names = [pinRequest.key, ...(pinRequest.also || [])].map((k) => boards[k]?.info?.name || k);
  const name = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : boards[pinRequest.key]?.info?.name || 'this board';
  return (
    <Dialog open onClose={() => pinRequest.resolve(null)}>
      <form onSubmit={(e) => { e.preventDefault(); pinRequest.resolve({ pin, remember }); }}>
        <DialogTitle>Page password for {name}</DialogTitle>
        <DialogContent>
          <Typography gutterBottom>{names.length > 1 ? 'These boards are locked. Type their page password: it is tried on each of them.' : 'This board is locked. Type its page password to make changes.'}</Typography>
          <TextField autoFocus fullWidth type="password" label="Page password" value={pin} onChange={(e) => setPin(e.target.value)} inputProps={{ 'aria-label': 'Page password' }} sx={{ mt: 2 }} />
          <FormControlLabel control={<Checkbox checked={remember} onChange={(e) => setRemember(e.target.checked)} />} label="Remember it on this computer (kept in the system keychain)" />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => pinRequest.resolve(null)}>Cancel</Button>
          <Button type="submit" variant="contained" disabled={!pin}>Unlock</Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

/** The theme around everything, the dialogs of the board actions included (main.tsx). */
export function ThemedRoot({ children }: { children: ReactNode }) {
  const { prefs } = useStore();
  const systemDark = useMediaQuery('(prefers-color-scheme: dark)');
  const id = resolveTheme(prefs.theme, systemDark);
  const theme = useMemo(() => makeTheme(id, prefs.zoom), [id, prefs.zoom]);
  return <ThemeProvider theme={theme}><CssBaseline />{children}</ThemeProvider>;
}

const SIDE_DEFAULT = 248;
const START: Loc = { view: 'boards' };

export default function App() {
  const { prefs, setPrefs, boards, startSim } = useStore();
  const act = useBoardActions();
  const theme = useTheme();
  const dark = theme.palette.mode === 'dark';
  const shell = theme.palette.shell;
  const [plugins, setPlugins] = useState<any[]>([]);
  const boardsRef = useRef(boards);
  boardsRef.current = boards;
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const list = useMemo(() => views(prefs.advanced, plugins), [prefs.advanced, plugins]);
  const listRef = useRef(list);
  listRef.current = list;
  // a place still there: its view (Advanced pages, extensions) and its board
  const valid = useCallback((l: Loc) => listRef.current.some((v) => v.id === l.view) && (!l.board || !!boardsRef.current[l.board]), []);
  const hist = useHistory(START, valid);
  const { loc, go, replace } = hist;
  const [palette, setPalette] = useState<{ open: boolean; text: string; n: number }>({ open: false, text: '', n: 0 });
  const [effects, setEffects] = useState<string[]>([]);
  // the open effect's saved text, for "Open a board running this script" (boards running it word for word count too)
  const [effectText, setEffectText] = useState<{ name: string; text: string } | null>(null);
  const scriptsCommands = useScriptsCommands();

  useEffect(() => {
    const readPlugins = () => call('plugins').then(setPlugins).catch(() => setPlugins([]));
    void readPlugins();
    onPluginsChanged(() => void readPlugins());
    call('startup').then((s) => { if (s?.open_plugin) go({ view: `plugin:${s.open_plugin}` }); }).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const view: View = list.find((v) => v.id === loc.view) || list[0];
  // a page that is only in Advanced mode closes when it is turned off
  useEffect(() => { if ((loc.view === 'serial' || loc.view === 'activity') && !list.some((v) => v.id === loc.view)) replace({ view: 'boards', board: undefined }); }, [list, loc.view]); // eslint-disable-line react-hooks/exhaustive-deps
  // a message belongs to the place it came from: another view or another board clears it; back to all boards
  // keeps it (Stop all boards on a board's page says "start them all again" on the overview)
  const lastPlace = useRef<{ view: string; board?: string } | null>(null);
  useEffect(() => {
    const l = lastPlace.current;
    if (l && (l.view !== loc.view || (loc.board && loc.board !== l.board))) act.clear();
    lastPlace.current = { view: loc.view, board: loc.board };
  }, [loc.view, loc.board]); // eslint-disable-line react-hooks/exhaustive-deps

  const nav = useMemo(() => ({
    ...hist,
    openEffect: (name: string) => go({ view: 'library', item: { kind: 'effect', name } }),
    openBoard: (key: string, tab?: string) => go({ view: 'boards', board: key, ...(tab ? { tab } : {}) }),
    openPalette: (text = '') => setPalette((p) => ({ open: true, text, n: p.open ? p.n : p.n + 1 })),
  }), [hist, go]);

  // ---- text size (zoom) and the theme
  const setZoom = useCallback((z: number) => setPrefs({ zoom: clampZoom(z) }), [setPrefs]);
  const zoomBy = useCallback((d: number) => setZoom((prefsRef.current.zoom || 100) + d), [setZoom]);
  const setTheme = useCallback((t: ThemePref) => setPrefs({ theme: t }), [setPrefs]);
  const sideHidden = !!prefs.sideBarHidden;
  const toggleSide = useCallback(() => setPrefs({ sideBarHidden: !prefsRef.current.sideBarHidden }), [setPrefs]);

  // ---- keyboard: our shortcuts win over the page (and the code editor) for these few combos
  const keysRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keysRef.current = (e: KeyboardEvent) => {
    const inMonaco = !!(e.target as HTMLElement)?.closest?.('.monaco-editor');
    // where text is edited, Alt+arrows and ⌘[ ⌘] belong to the editor (word moves, indent): back/forward stay on the
    // title bar buttons and the mouse there
    const editing = inMonaco || !!(e.target as HTMLElement)?.closest?.('input, textarea, [contenteditable="true"]');
    const hit = (combo: string, f: () => void) => { if (!matches(e, combo)) return false; e.preventDefault(); e.stopPropagation(); f(); return true; };
    if (hit('Mod+Shift+P', () => nav.openPalette())) return;
    if (!inMonaco && hit('F1', () => nav.openPalette())) return;
    if (hit('Mod+P', () => nav.openPalette())) return;
    if (hit('Mod+B', toggleSide)) return;
    // Save (the script on screen): taken everywhere, inside the code editor and the blocks too, never the window's "Save page"
    if (handleSaveKey(e)) return;
    // text size: Ctrl + (or Ctrl =, the same key), Ctrl -, Ctrl 0, and the number pad's
    if (['Mod+=', 'Mod+Shift+=', 'Mod++', 'Mod+Shift++', 'Mod+NumpadAdd'].some((c) => hit(c, () => zoomBy(ZOOM_STEP)))) return;
    if (['Mod+-', 'Mod+Shift+_', 'Mod+NumpadSubtract'].some((c) => hit(c, () => zoomBy(-ZOOM_STEP)))) return;
    if (['Mod+0', 'Mod+Numpad0'].some((c) => hit(c, () => setZoom(100)))) return;
    // back and forward (a Mac also has ⌘[ and ⌘])
    if (!editing && (hit('Alt+ArrowLeft', nav.back) || hit('Alt+ArrowRight', nav.forward))) return;
    if (isMac && !editing && (hit('Mod+[', nav.back) || hit('Mod+]', nav.forward))) return;
    for (const v of listRef.current) if (v.keys && hit(v.keys, () => go({ view: v.id }))) return;
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keysRef.current(e);
    // Ctrl + mouse wheel (or a trackpad pinch): our text size, never the page's scroll or the webview's own zoom
    let wheel = 0;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      e.stopPropagation();
      wheel += e.deltaY;
      if (Math.abs(wheel) >= 40) { zoomBy(wheel < 0 ? ZOOM_STEP : -ZOOM_STEP); wheel = 0; }
    };
    // the mouse's back and forward buttons
    const onMouse = (e: MouseEvent) => { if (e.button === 3) { e.preventDefault(); nav.back(); } else if (e.button === 4) { e.preventDefault(); nav.forward(); } };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('wheel', onWheel, { passive: false, capture: true });
    window.addEventListener('mouseup', onMouse);
    return () => { window.removeEventListener('keydown', onKey, true); window.removeEventListener('wheel', onWheel, true); window.removeEventListener('mouseup', onMouse); };
  }, [nav.back, nav.forward, zoomBy]); // eslint-disable-line react-hooks/exhaustive-deps

  // effects for the palette, read when it opens
  useEffect(() => {
    if (palette.open && prefs.workspace) call('library_list', { folder: prefs.workspace }).then((l: any[]) => setEffects(l.map((e) => e.name))).catch(() => setEffects([]));
  }, [palette.open, prefs.workspace]);
  const openEffectName = loc.view === 'library' && loc.item?.kind === 'effect' ? loc.item.name : '';
  useEffect(() => {
    if (palette.open && prefs.workspace && openEffectName) call('library_read', { folder: prefs.workspace, name: openEffectName }).then((text: string) => setEffectText({ name: openEffectName, text })).catch(() => setEffectText(null));
  }, [palette.open, prefs.workspace, openEffectName]);

  const saveVersion = useSaveVersion();
  const commands = useMemo<Command[]>(() => {
    const out: Command[] = [];
    const save = currentSave();
    if (save) out.push({ id: 'save', label: save.label, group: 'Action', keys: SAVE_KEYS, also: 'save keep store', run: () => void runSave() });
    for (const v of list) out.push({ id: `go:${v.id}`, label: `Go to ${v.label}`, group: 'Go to', keys: v.keys, also: v.hint, run: () => go({ view: v.id }) });
    const open = loc.view === 'boards' && loc.board ? boards[loc.board] : undefined;
    if (open) {
      const n = open.info?.name || open.key;
      for (const [tab, label] of [['script', 'Effect script'], ['plot', 'Plot'], ['settings', 'Settings'], ['backup', 'Backups'], ['log', 'Activity']]) {
        out.push({ id: `tab:${tab}`, label: `${n}: ${label}`, group: 'This board', run: () => go({ view: 'boards', board: open.key, tab }) });
      }
      const link = boardLink(open);
      if (link.kind === 'library') out.push({ id: 'b:script', label: "Open this board's script", group: 'This board', also: `Your library ${link.name}`, run: () => nav.openEffect(link.name) });
      else if (link.kind === 'not-in-library' && open.online && prefs.workspace) out.push({ id: 'b:script', label: "Open this board's script", group: 'This board', also: 'save it to Your library first', run: () => void act.saveBoardScriptAsNew(open.key).then((name) => { if (name) nav.openEffect(name); }) });
      out.push({ id: 'b:stop', label: `Stop ${n}`, group: 'This board', run: () => void act.stop(open.key) });
      out.push({ id: 'b:restart', label: `Restart ${n}`, group: 'This board', run: () => void act.restart(open.key) });
      out.push({ id: 'b:backup', label: `Back up ${n}`, group: 'This board', run: () => void act.backup(open.key) });
    }
    for (const b of Object.values(boards).sort((a, c) => String(a.info?.name).localeCompare(String(c.info?.name)))) {
      out.push({ id: `board:${b.key}`, label: `Open board: ${b.info?.name || b.key}`, group: 'Board', also: b.online ? 'connected' : 'not answering', run: () => nav.openBoard(b.key) });
    }
    if (openEffectName) {
      const text = effectText?.name === openEffectName ? effectText.text : undefined;
      for (const { board: b, version } of boardsRunning(boards, openEffectName, text)) {
        out.push({ id: `running:${b.key}`, label: `Open a board running this script: ${b.info?.name || b.key}`, group: 'This effect', also: VERSION_WORDS[version].toLowerCase(), run: () => nav.openBoard(b.key, 'script') });
      }
    }
    for (const e of effects) out.push({ id: `effect:${e}`, label: `Open effect: ${e}`, group: 'Effect', run: () => nav.openEffect(e) });
    out.push(
      { id: 'stop-all', label: 'Stop all boards', group: 'Action', also: 'emergency off', run: () => void act.stopAll() },
      { id: 'add-practice', label: 'Add a practice board', group: 'Action', also: 'simulator try', run: () => { void startSim(practiceName(Object.values(boardsRef.current).map((b) => b.info?.name || ''))).then((k) => nav.openBoard(k)).catch((e) => window.alert(String(e.message || e))); } },
      { id: 'find-boards', label: 'Find or add boards', group: 'Action', also: 'network address', run: () => go({ view: 'boards', add: true }) },
      { id: 'new-effect', label: 'New effect…', group: 'Action', also: 'make create', run: () => go({ view: 'library', add: true }) },
      { id: 'backup-all', label: 'Back up all boards', group: 'Action', run: () => Object.values(boardsRef.current).forEach((b) => void act.backup(b.key)) },
      ...scriptsCommands,
      { id: 'back', label: 'Go back', group: 'Go to', keys: isMac ? 'Mod+[' : 'Alt+Left', run: nav.back },
      { id: 'forward', label: 'Go forward', group: 'Go to', keys: isMac ? 'Mod+]' : 'Alt+Right', run: nav.forward },
      { id: 'side', label: sideHidden ? 'Show the side bar' : 'Hide the side bar', group: 'View', keys: 'Mod+B', run: toggleSide },
      { id: 'advanced', label: prefs.advanced ? 'Turn Advanced mode off' : 'Turn Advanced mode on', group: 'View', also: 'expert', run: () => setPrefs({ advanced: !prefsRef.current.advanced }) },
      { id: 'zoom-in', label: 'Bigger text', group: 'Text size', keys: 'Mod+=', also: 'zoom in larger', run: () => zoomBy(ZOOM_STEP) },
      { id: 'zoom-out', label: 'Smaller text', group: 'Text size', keys: 'Mod+-', also: 'zoom out', run: () => zoomBy(-ZOOM_STEP) },
      { id: 'zoom-reset', label: 'Normal text size (100 %)', group: 'Text size', keys: 'Mod+0', also: 'zoom reset', run: () => setZoom(100) },
      { id: 'theme:system', label: 'Theme: follow the computer (Light or Dark)', group: 'Theme', also: 'colour color system', run: () => setTheme('system') },
      ...THEME_IDS.map((t) => ({ id: `theme:${t}`, label: `Theme: ${THEMES[t].label}`, group: 'Theme', also: 'colour color look', run: () => setTheme(t) })),
      { id: 'welcome', label: 'Show the welcome steps again', group: 'Help', run: () => setPrefs({ firstRunDone: false }) },
    );
    return out;
  }, [list, boards, effects, effectText, loc, prefs.advanced, prefs.workspace, sideHidden, scriptsCommands, saveVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- layout
  const wideEnough = useMediaQuery('(min-width: 700px)', { noSsr: true });
  const showSide = !!view.sideBar && !sideHidden && wideEnough;
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  // widths are kept at 100 % and grow with the text size, like everything else
  const zf = shell.zoom / 100;
  const sideWidth = Math.round((prefs.sideBarWidth || SIDE_DEFAULT) * zf);
  const ctx = { loc, dark, plugins };
  const top = list.filter((v) => !v.bottom);
  const bottom = list.filter((v) => v.bottom);
  const toggle = THEMES[shell.id].pair;
  const toggleDark = THEMES[toggle].tokens.mode === 'dark';
  const backKeys = keyLabel(isMac ? 'Mod+[' : 'Alt+Left');
  const fwdKeys = keyLabel(isMac ? 'Mod+]' : 'Alt+Right');

  return (
    <NavContext.Provider value={nav}>
      <Box sx={{ height: '100vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', bgcolor: shell.editor }}>
        {/* title bar */}
        <Box component="header" sx={{ height: (t) => t.spacing(9), flexShrink: 0, display: 'flex', alignItems: 'center', gap: 1, px: 2, bgcolor: shell.titleBar, borderBottom: 1, borderColor: 'divider' }}>
          <Typography component="h1" sx={{ fontWeight: 600, fontSize: 'body1.fontSize', mr: 2, whiteSpace: 'nowrap' }}>Specter Studio</Typography>
          <Tooltip title={`Back (${backKeys}, or the mouse's back button)`}><span><IconButton aria-label="Go back" aria-keyshortcuts={isMac ? 'Meta+[' : 'Alt+ArrowLeft'} disabled={!hist.canBack} onClick={hist.back}><ArrowBack fontSize="small" /></IconButton></span></Tooltip>
          <Tooltip title={`Forward (${fwdKeys})`}><span><IconButton aria-label="Go forward" aria-keyshortcuts={isMac ? 'Meta+]' : 'Alt+ArrowRight'} disabled={!hist.canForward} onClick={hist.forward}><ArrowForward fontSize="small" /></IconButton></span></Tooltip>
          <Box sx={{ flex: 1, display: 'flex', justifyContent: 'center', minWidth: 0, px: 2 }}>
            <ButtonBase onClick={() => nav.openPalette()} aria-keyshortcuts={isMac ? 'Meta+Shift+P' : 'Control+Shift+P'} data-testid="command-center"
              sx={{ width: '100%', maxWidth: 520, height: (t) => t.spacing(6), px: 2, gap: 1.5, justifyContent: 'flex-start', borderRadius: 1, border: 1, borderColor: 'divider', bgcolor: shell.editor, color: 'text.secondary', fontSize: 'body2.fontSize', '&:hover': { bgcolor: shell.hover } }}>
              <Search fontSize="small" />
              <Box component="span" sx={{ flex: 1, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>Search boards, effects and commands</Box>
              <Box component="kbd" sx={{ display: { xs: 'none', sm: 'inline' } }}>{keyLabel('Mod+Shift+P')}</Box>
            </ButtonBase>
          </Box>
          <Button variant="contained" color="error" disabled={!Object.values(boards).some((b) => b.online)} onClick={() => void act.stopAll()}>Stop all boards</Button>
          <FormControlLabel sx={{ ml: 1, mr: 0 }} control={<Switch checked={prefs.advanced} onChange={(e) => setPrefs({ advanced: e.target.checked })} inputProps={{ 'aria-label': 'Advanced mode' }} />} label="Advanced" />
          <Tooltip title={`${toggleDark ? THEMES[toggle].label : THEMES[toggle].label} theme (all themes: Settings, or the theme in the status bar)`}>
            <IconButton onClick={() => setTheme(toggle)} aria-label={toggleDark ? 'Use the dark theme' : 'Use the light theme'}>{toggleDark ? <DarkMode fontSize="small" /> : <LightMode fontSize="small" />}</IconButton>
          </Tooltip>
        </Box>
        <Box sx={{ flex: 1, minHeight: 0, display: 'flex' }}>
          {/* activity bar */}
          <Box component="nav" aria-label="Sections" sx={{ width: (t) => t.spacing(14), flexShrink: 0, bgcolor: shell.activityBar, borderRight: 1, borderColor: 'divider', display: 'flex', flexDirection: 'column' }}>
            <Tabs value={list.some((v) => v.id === loc.view) ? loc.view : false} orientation="vertical" aria-label="Sections" sx={activitySx}
              onChange={(_, v) => go({ view: v })}>
              {[...top, ...bottom].map((v, i) => (
                <Tab key={v.id} value={v.id} aria-label={v.label} data-testid={`activity-${v.id}`} sx={i === top.length ? { mt: 'auto' } : undefined}
                  // the place you are in, clicked again: its start (all boards, the library's list)
                  onClick={() => { if (v.id === loc.view && (loc.board || loc.item)) go({ view: v.id }); }}
                  label={
                    <Tooltip placement="right" describeChild title={<><b>{v.label}</b>{v.keys ? ` (${keyLabel(v.keys)})` : ''}<br />{v.hint}</>}>
                      <Box component="span" className="act">{v.icon}<Box component="span" className="act-label">{v.short}</Box>{' '}</Box>
                    </Tooltip>
                  } />
              ))}
            </Tabs>
          </Box>
          {/* side bar */}
          {showSide && (
            <>
              <Box component="aside" aria-label={`${view.label} side bar`} data-testid="side-bar"
                sx={{ width: sideWidth, flexShrink: 0, bgcolor: shell.sideBar, display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>
                {typeof view.sideBar === 'function' ? view.sideBar(ctx) : <Box ref={setSlot} sx={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }} />}
              </Box>
              <Splitter label="Side bar width" value={sideWidth} min={Math.round(170 * zf)} max={Math.round(520 * zf)} reset={Math.round(SIDE_DEFAULT * zf)} onChange={(w) => setPrefs({ sideBarWidth: Math.round(w / zf) })} />
            </>
          )}
          {/* work area */}
          <SideBarSlot.Provider value={showSide && view.sideBar === true ? slot : sideHidden && wideEnough ? 'hidden' : null}>
            <Box component="main" sx={{ flex: 1, minWidth: 0, overflow: view.fill ? 'hidden' : 'auto', bgcolor: shell.editor, ...(view.fill ? { display: 'flex', flexDirection: 'column' } : { px: 5, pt: 3, pb: 6 }) }}>
              <RestoreNote />
              {view.render(ctx)}
            </Box>
          </SideBarSlot.Provider>
        </Box>
        <StatusBar onTheme={setTheme} onZoom={setZoom} />
      </Box>
      <CommandPalette key={palette.n} open={palette.open} initial={palette.text} commands={commands} onClose={() => setPalette((p) => ({ ...p, open: false }))} />
      <PinDialog />
      <FleetServerWork />
      <ScriptsRepoWork />
      <DashboardWork />
      <PropRunsWork />
      {prefs.firstRunDone && <Adapters />}
      {!prefs.firstRunDone && <FirstRun />}
    </NavContext.Provider>
  );
}

/** The status bar: whether Studio's device service answers, how many boards are connected, the fleet server,
 * the text size (click: back to 100 %) and the theme (click: pick another). */
function StatusBar({ onTheme, onZoom }: { onTheme: (t: ThemePref) => void; onZoom: (z: number) => void }) {
  const { boards, prefs } = useStore();
  const nav = useNav();
  const theme = useTheme();
  const shell = theme.palette.shell;
  const [conn, setConn] = useState<'ok' | 'down'>('ok');
  useEffect(() => onConnection(setConn), []);
  // while the device service is away, knock now and then (a call reconnects)
  useEffect(() => { if (conn !== 'down') return; const t = setInterval(() => void call('connections').catch(() => {}), 3000); return () => clearInterval(t); }, [conn]);
  const [themeMenu, setThemeMenu] = useState<HTMLElement | null>(null);
  const all = Object.values(boards);
  const online = all.filter((b) => b.online).length;
  const fleet = !!(prefs as any).collect;
  const item = { height: '100%', px: 2, gap: 1, color: shell.statusFg, fontSize: 'caption.fontSize', borderRadius: 0, '&:hover': { bgcolor: shell.hover, color: shell.text } } as const;
  return (
    <Box component="footer" aria-label="Status" data-testid="status-bar"
      sx={{ height: (t) => t.spacing(5.5), flexShrink: 0, display: 'flex', alignItems: 'stretch', bgcolor: shell.statusBar, color: shell.statusFg, borderTop: 1, borderColor: 'divider', overflow: 'hidden', whiteSpace: 'nowrap' }}>
      <ButtonBase sx={item} onClick={() => nav.go({ view: 'boards' })} data-testid="status-boards" title="Open the boards">
        <Box component="span" aria-hidden sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: conn === 'ok' ? 'success.main' : 'error.main' }} />
        {conn === 'ok' ? `${online} of ${all.length} board${all.length === 1 ? '' : 's'} online` : 'Studio\'s device service is not answering: trying again'}
      </ButtonBase>
      <ButtonBase sx={item} onClick={() => nav.go({ view: 'settings' })} data-testid="status-fleet" title="Boards report to this computer (in Settings)">
        Fleet server: {fleet ? 'on' : 'off'}
      </ButtonBase>
      <ScriptsRepoStatus sx={item} />
      <Box sx={{ flex: 1 }} />
      <ButtonBase sx={{ ...item, display: { xs: 'none', md: 'flex' } }} onClick={() => nav.openPalette()} title="Every command and place">{keyLabel('Mod+Shift+P')}: commands</ButtonBase>
      <ButtonBase sx={item} onClick={() => onZoom(100)} data-testid="status-zoom" title={`Text size. Bigger: ${keyLabel('Mod+=')} or ${keyLabel('Mod')} and the mouse wheel; smaller: ${keyLabel('Mod+-')}. Click: back to 100 %.`}>
        Text {shell.zoom} %
      </ButtonBase>
      <ButtonBase sx={item} onClick={(e) => setThemeMenu(e.currentTarget)} data-testid="status-theme" aria-haspopup="menu" title="Theme: choose another">
        {THEMES[shell.id].label}{prefs.theme === 'system' ? ' (as the computer)' : ''}
      </ButtonBase>
      <Menu anchorEl={themeMenu} open={!!themeMenu} onClose={() => setThemeMenu(null)} MenuListProps={{ 'aria-label': 'Themes' }} anchorOrigin={{ vertical: 'top', horizontal: 'right' }} transformOrigin={{ vertical: 'bottom', horizontal: 'right' }}>
        {(['system', ...THEME_IDS] as ThemePref[]).map((t) => (
          <MenuItem key={t} selected={prefs.theme === t} onClick={() => { setThemeMenu(null); onTheme(t); }}>
            <Box sx={{ width: 22, display: 'flex' }}>{prefs.theme === t && <Check fontSize="small" />}</Box>
            <ListItemText>{t === 'system' ? 'Follow the computer (Light or Dark)' : THEMES[t].label}</ListItemText>
          </MenuItem>
        ))}
      </Menu>
    </Box>
  );
}

// VS Code's activity bar: icons with a short word under them, the current one marked by a bar on its left
const activitySx = {
  flex: 1, minHeight: 0,
  '& .MuiTabs-scroller, & .MuiTabs-flexContainer': { height: '100%' },
  '& .MuiTabs-indicator': { left: 0, right: 'auto', width: 2 },
  '& .MuiTab-root': { minWidth: 0, maxWidth: 'none', width: '100%', minHeight: 0, p: 0, py: 1.5 },
  '& .act': { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0.5, width: '100%' },
  '& .act svg': { fontSize: (t: any) => t.spacing(6) },
  '& .act-label': { fontSize: (t: any) => `${t.palette.shell.zoom * 0.105}px`, lineHeight: 1.2, fontWeight: 500 },
  '& .MuiTab-root:not(.Mui-selected)': { color: (t: any) => t.palette.shell.activityFg },
  '& .MuiTab-root.Mui-selected': { color: (t: any) => t.palette.shell.activityActive },
  '& .MuiTab-root:hover': { color: (t: any) => t.palette.shell.activityActive },
} as const;
