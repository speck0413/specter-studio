import { createTheme, Theme } from '@mui/material/styles';

// Desktop density with VS Code as the reference: a 13 px UI font, 26 px controls and rows, 4 px spacing steps,
// small headers, 4 px corners, flat outlined surfaces, no ripples (a focus ring instead). One token set per theme
// below; components take every colour from the theme (palette, `palette.shell`, `palette.output`), never their own.
// Text size (zoom) scales type, spacing and controls together, like VS Code's zoom.

export type ThemeId = 'light' | 'dark' | 'gruvbox' | 'gruvbox-light' | 'obsidian' | 'halloween';
/** what the person chose: a theme, or follow the computer's light or dark setting */
export type ThemePref = ThemeId | 'system';

export interface Tokens {
  mode: 'light' | 'dark';
  /** the work area (editor) */
  editor: string;
  /** cards, menus, dialogs */
  panel: string;
  sideBar: string;
  activityBar: string;
  /** inactive activity bar icons and labels (text: 4.5:1 on activityBar) */
  activityFg: string;
  activityActive: string;
  titleBar: string;
  statusBar: string;
  statusFg: string;
  border: string;
  text: string;
  textMuted: string;
  primary: string;
  primaryText: string;
  secondary: string;
  secondaryText: string;
  ok: string; // success
  warn: string;
  error: string;
  info: string;
  /** text on the filled status colours */
  onStatus: string;
  outputOn: string;
  outputOff: string;
  selection: string;
  hover: string;
  focus: string;
  scrollbar: string;
}

// Light and Dark keep Specter's pumpkin orange; VS Code's Light Modern / Dark Modern greys.
const light: Tokens = {
  mode: 'light', editor: '#ffffff', panel: '#ffffff', sideBar: '#f8f8f8', activityBar: '#f0f0f0', activityFg: '#555555', activityActive: '#1f1f1f',
  titleBar: '#f8f8f8', statusBar: '#f0f0f0', statusFg: '#3b3b3b', border: '#e0e0e0', text: '#1f1f1f', textMuted: '#5c5c5c',
  primary: '#a34400', primaryText: '#ffffff', secondary: '#00695c', secondaryText: '#ffffff',
  ok: '#1b6e20', warn: '#8a5a00', error: '#b71c1c', info: '#01579b', onStatus: '#ffffff',
  outputOn: '#d35400', outputOff: '#c8c8c8', selection: '#fbe3cf', hover: '#ebebeb', focus: '#a34400', scrollbar: '#c2c2c2',
};
const dark: Tokens = {
  mode: 'dark', editor: '#1f1f1f', panel: '#252526', sideBar: '#181818', activityBar: '#181818', activityFg: '#9d9d9d', activityActive: '#ffffff',
  titleBar: '#181818', statusBar: '#181818', statusFg: '#cccccc', border: '#2f2f2f', text: '#cccccc', textMuted: '#9d9d9d',
  primary: '#ffb74d', primaryText: '#1d1d1d', secondary: '#80cbc4', secondaryText: '#1d1d1d',
  ok: '#81c784', warn: '#ffd54f', error: '#f28b82', info: '#81d4fa', onStatus: '#1d1d1d',
  outputOn: '#ffa726', outputOff: '#555555', selection: '#33302a', hover: '#2a2d2e', focus: '#ffb74d', scrollbar: '#4f4f4f',
};
// Gruvbox (morhetz): dark with the bright accents, light with the faded ones
const gruvbox: Tokens = {
  mode: 'dark', editor: '#282828', panel: '#32302f', sideBar: '#1d2021', activityBar: '#1d2021', activityFg: '#a89984', activityActive: '#fbf1c7',
  titleBar: '#1d2021', statusBar: '#3c3836', statusFg: '#ebdbb2', border: '#3c3836', text: '#ebdbb2', textMuted: '#bdae93',
  primary: '#fe8019', primaryText: '#1d2021', secondary: '#83a598', secondaryText: '#1d2021',
  ok: '#8ec07c', warn: '#fabd2f', error: '#ff6655', info: '#83a598', onStatus: '#1d2021',
  outputOn: '#fe8019', outputOff: '#665c54', selection: '#423d3a', hover: '#3c3836', focus: '#fabd2f', scrollbar: '#665c54',
};
const gruvboxLight: Tokens = {
  mode: 'light', editor: '#fbf1c7', panel: '#fbf1c7', sideBar: '#f2e5bc', activityBar: '#ebdbb2', activityFg: '#504945', activityActive: '#282828',
  titleBar: '#f2e5bc', statusBar: '#ebdbb2', statusFg: '#3c3836', border: '#d5c4a1', text: '#3c3836', textMuted: '#5a524c',
  primary: '#9d3600', primaryText: '#fbf1c7', secondary: '#2f6b45', secondaryText: '#fbf1c7',
  ok: '#2f6b45', warn: '#7f5209', error: '#9d0006', info: '#076678', onStatus: '#fbf1c7',
  outputOn: '#af3a03', outputOff: '#bdae93', selection: '#ebdbb2', hover: '#ebdbb2', focus: '#9d3600', scrollbar: '#bdae93',
};
// Obsidian's default dark look: near-black greys, purple accent (lightened where it is text)
const obsidian: Tokens = {
  mode: 'dark', editor: '#1e1e1e', panel: '#262626', sideBar: '#262626', activityBar: '#202020', activityFg: '#a3a3a3', activityActive: '#dadada',
  titleBar: '#202020', statusBar: '#262626', statusFg: '#bababa', border: '#363636', text: '#dadada', textMuted: '#a3a3a3',
  primary: '#a68af9', primaryText: '#1e1e1e', secondary: '#53dfdd', secondaryText: '#1e1e1e',
  ok: '#44cf6e', warn: '#e0de71', error: '#ff5c61', info: '#53dfdd', onStatus: '#1e1e1e',
  outputOn: '#a882ff', outputOff: '#4a4a4a', selection: '#332c45', hover: '#2f2f2f', focus: '#a68af9', scrollbar: '#4a4a4a',
};
// Halloween: pumpkin orange and witch purple on near-black; slime green, candle yellow and blood red for status
const halloween: Tokens = {
  mode: 'dark', editor: '#16121a', panel: '#1f1925', sideBar: '#1b1520', activityBar: '#100c13', activityFg: '#b3a2c2', activityActive: '#ff9a3c',
  titleBar: '#100c13', statusBar: '#3b1f52', statusFg: '#f5e9ff', border: '#33283d', text: '#f2e9e4', textMuted: '#bfaec9',
  primary: '#ff9a3c', primaryText: '#16121a', secondary: '#c39bff', secondaryText: '#16121a',
  ok: '#7bd88f', warn: '#ffe066', error: '#ff6b81', info: '#c39bff', onStatus: '#16121a',
  outputOn: '#ff9a3c', outputOff: '#4a3d55', selection: '#3b2a4a', hover: '#2a2131', focus: '#ff9a3c', scrollbar: '#4a3d55',
};

export const THEMES: Record<ThemeId, { label: string; tokens: Tokens; /** the quick toggle's other theme */ pair: ThemeId }> = {
  light: { label: 'Light', tokens: light, pair: 'dark' },
  dark: { label: 'Dark', tokens: dark, pair: 'light' },
  gruvbox: { label: 'Gruvbox', tokens: gruvbox, pair: 'gruvbox-light' },
  'gruvbox-light': { label: 'Gruvbox light', tokens: gruvboxLight, pair: 'gruvbox' },
  obsidian: { label: 'Obsidian', tokens: obsidian, pair: 'light' },
  halloween: { label: 'Halloween', tokens: halloween, pair: 'light' },
};
export const THEME_IDS = Object.keys(THEMES) as ThemeId[];

/** the theme to draw: the chosen one, or Light / Dark by the computer's setting */
export function resolveTheme(pref: ThemePref | undefined, systemDark: boolean): ThemeId {
  return pref && pref !== 'system' && THEMES[pref] ? pref : systemDark ? 'dark' : 'light';
}

// Text size: like VS Code's zoom, in 10 % steps
export const ZOOM_MIN = 70;
export const ZOOM_MAX = 200;
export const ZOOM_STEP = 10;
export const clampZoom = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round((Number(z) || 100) / ZOOM_STEP) * ZOOM_STEP));
export const ZOOM_CHOICES = Array.from({ length: (ZOOM_MAX - ZOOM_MIN) / ZOOM_STEP + 1 }, (_, i) => ZOOM_MIN + i * ZOOM_STEP);

// plot lines and their chips: dark enough on light surfaces, light enough on dark ones (3:1, theme.test.ts)
export const SERIES = {
  light: { colors: ['#c2410c', '#1d4ed8', '#15803d', '#7e22ce', '#b91c1c', '#0e7490', '#a16207', '#4338ca', '#4d7c0f', '#be185d'], text: '#ffffff' },
  dark: { colors: ['#fb923c', '#60a5fa', '#4ade80', '#c084fc', '#f87171', '#22d3ee', '#facc15', '#a5b4fc', '#a3e635', '#f472b6'], text: '#111111' },
};
export type Shell = Tokens & { id: ThemeId; zoom: number };
declare module '@mui/material/styles' {
  interface Palette { shell: Shell; output: { on: string; off: string }; series: { colors: string[]; text: string } }
  interface PaletteOptions { shell?: Shell; output?: { on: string; off: string }; series?: { colors: string[]; text: string } }
}

/** a UI measure (px at 100 %) at the current text size */
export const sized = (theme: Theme, px: number) => Math.round(px * theme.palette.shell.zoom) / 100;

export function makeTheme(id: ThemeId, zoom = 100) {
  const t = THEMES[id]?.tokens || light;
  const z = clampZoom(zoom) / 100;
  const px = (n: number) => `${Math.round(n * z * 100) / 100}px`;
  return createTheme({
    palette: {
      mode: t.mode,
      primary: { main: t.primary, contrastText: t.primaryText },
      secondary: { main: t.secondary, contrastText: t.secondaryText },
      success: { main: t.ok, contrastText: t.onStatus },
      warning: { main: t.warn, contrastText: t.onStatus },
      error: { main: t.error, contrastText: t.onStatus },
      info: { main: t.info, contrastText: t.onStatus },
      background: { default: t.editor, paper: t.panel },
      text: { primary: t.text, secondary: t.textMuted },
      divider: t.border,
      action: { hover: t.hover, selected: t.selection, focus: t.selection },
      shell: { ...t, id, zoom: z * 100 },
      output: { on: t.outputOn, off: t.outputOff },
      series: SERIES[t.mode],
    },
    spacing: 4 * z,
    shape: { borderRadius: 4 },
    typography: {
      fontFamily: '"Segoe UI", system-ui, -apple-system, Ubuntu, Cantarell, "Noto Sans", sans-serif',
      fontSize: 13 * z,
      htmlFontSize: 16,
      h1: { fontSize: px(24), fontWeight: 600 }, h2: { fontSize: px(20), fontWeight: 600 }, h3: { fontSize: px(18), fontWeight: 600 }, h4: { fontSize: px(16), fontWeight: 600 },
      h5: { fontSize: px(15), fontWeight: 600, lineHeight: 1.4 }, // the work area's title (board, effect, page)
      h6: { fontSize: px(13), fontWeight: 600, lineHeight: 1.5 }, // a section
      subtitle1: { fontSize: px(13), fontWeight: 600, lineHeight: 1.5 },
      subtitle2: { fontSize: px(12), fontWeight: 600, lineHeight: 1.45 },
      body1: { fontSize: px(13), lineHeight: 1.5 },
      body2: { fontSize: px(12), lineHeight: 1.45 },
      caption: { fontSize: px(11), lineHeight: 1.4 },
      button: { fontSize: px(13), textTransform: 'none', fontWeight: 500, letterSpacing: 0, lineHeight: 1.4 },
      overline: { fontSize: px(11), fontWeight: 700, letterSpacing: '0.06em', lineHeight: 1.6 },
    },
    components: {
      MuiCssBaseline: {
        styleOverrides: {
          body: { fontSize: px(13), backgroundColor: t.editor, scrollbarColor: `${t.scrollbar} transparent` },
          kbd: { fontFamily: 'inherit', fontSize: '0.92em', padding: '0 4px', border: `1px solid ${t.border}`, borderRadius: 3, background: t.hover },
        },
      },
      // no ripples (a desktop app); keyboard focus shows as a ring
      MuiButtonBase: { defaultProps: { disableRipple: true }, styleOverrides: { root: { '&.Mui-focusVisible': { outline: `2px solid ${t.focus}`, outlineOffset: 1 } } } },
      MuiButton: {
        defaultProps: { size: 'small', disableElevation: true },
        styleOverrides: {
          root: { minHeight: px(26), minWidth: 0, borderRadius: 3, padding: `${px(2)} ${px(10)}` },
          sizeSmall: { fontSize: px(13), padding: `${px(2)} ${px(10)}` },
          sizeLarge: { minHeight: px(34), fontSize: px(14), padding: `${px(4)} ${px(16)}` },
          startIcon: { marginRight: px(6) },
        },
      },
      MuiIconButton: { defaultProps: { size: 'small' }, styleOverrides: { root: { borderRadius: 4, padding: px(4) }, sizeSmall: { padding: px(4) } } },
      MuiSvgIcon: { styleOverrides: { fontSizeSmall: { fontSize: px(16) }, fontSizeMedium: { fontSize: px(20) }, fontSizeLarge: { fontSize: px(28) } } },
      MuiToggleButton: { styleOverrides: { root: { minHeight: px(24), padding: `${px(2)} ${px(8)}`, fontSize: px(12), textTransform: 'none', fontWeight: 500 } } },
      MuiTextField: { defaultProps: { size: 'small' } },
      MuiFormControl: { defaultProps: { size: 'small' } },
      MuiSelect: { defaultProps: { size: 'small' } },
      MuiInputBase: { styleOverrides: { root: { fontSize: px(13) } } },
      MuiOutlinedInput: {
        styleOverrides: {
          root: { borderRadius: 3 },
          input: { padding: `${px(4)} ${px(8)}`, height: px(18.5) },
          inputSizeSmall: { padding: `${px(4)} ${px(8)}` },
          multiline: { padding: `${px(4)} ${px(8)}` },
        },
      },
      MuiInputLabel: {
        styleOverrides: {
          root: { fontSize: px(13) },
          sizeSmall: { transform: `translate(${px(9)}, ${px(4)}) scale(1)`, '&.MuiInputLabel-shrink': { transform: `translate(${px(11)}, ${px(-8)}) scale(0.8)` } },
        },
      },
      MuiFormHelperText: { styleOverrides: { root: { fontSize: px(11), marginTop: px(2) } } },
      MuiFormControlLabel: { styleOverrides: { label: { fontSize: px(13) } } },
      MuiCheckbox: { defaultProps: { size: 'small' }, styleOverrides: { root: { padding: px(4) } } },
      MuiRadio: { defaultProps: { size: 'small' }, styleOverrides: { root: { padding: px(4) } } },
      MuiSwitch: { defaultProps: { size: 'small' } },
      MuiSlider: { defaultProps: { size: 'small' } },
      MuiChip: {
        defaultProps: { size: 'small' },
        styleOverrides: { root: { fontWeight: 500, borderRadius: 3, fontSize: px(12) }, sizeSmall: { height: px(20) }, labelSmall: { paddingLeft: px(6), paddingRight: px(6) } },
      },
      MuiCard: { defaultProps: { variant: 'outlined' }, styleOverrides: { root: { borderRadius: 4 } } },
      MuiCardContent: { styleOverrides: { root: { padding: px(8), '&:last-child': { paddingBottom: px(8) } } } },
      MuiCardActions: { styleOverrides: { root: { padding: `${px(4)} ${px(8)}` } } },
      MuiPaper: { styleOverrides: { root: { backgroundImage: 'none' } } },
      MuiTabs: { styleOverrides: { root: { minHeight: px(30) }, indicator: { height: 2 } } },
      MuiTab: { styleOverrides: { root: { textTransform: 'none', fontWeight: 500, fontSize: px(13), minHeight: px(30), minWidth: 0, padding: `${px(4)} ${px(10)}` } } },
      MuiList: { defaultProps: { dense: true } },
      MuiListItemButton: { styleOverrides: { root: { paddingTop: px(2), paddingBottom: px(2), minHeight: px(24), '&.Mui-selected, &.Mui-selected:hover, &.Mui-selected.Mui-focusVisible': { backgroundColor: t.selection } } } },
      MuiListItemText: { styleOverrides: { root: { marginTop: 0, marginBottom: 0 } } },
      MuiListItemIcon: { styleOverrides: { root: { minWidth: px(26) } } },
      MuiListSubheader: { styleOverrides: { root: { lineHeight: px(26), fontSize: px(11), fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', backgroundColor: 'transparent', color: t.textMuted } } },
      MuiMenuItem: { defaultProps: { dense: true }, styleOverrides: { root: { fontSize: px(13), minHeight: px(26), '&.Mui-selected, &.Mui-selected:hover, &.Mui-selected.Mui-focusVisible': { backgroundColor: t.selection } } } },
      MuiAlert: {
        styleOverrides: {
          root: { padding: `0 ${px(8)}`, fontSize: px(13), alignItems: 'center' },
          icon: { padding: `${px(4)} 0`, marginRight: px(8), fontSize: px(18) },
          message: { padding: `${px(4)} 0` },
          action: { paddingTop: 0, paddingBottom: 0 },
        },
      },
      MuiAccordion: { defaultProps: { disableGutters: true, elevation: 0 }, styleOverrides: { root: { border: `1px solid ${t.border}`, borderRadius: 4, '&::before': { display: 'none' } } } },
      MuiAccordionSummary: { styleOverrides: { root: { minHeight: px(30), padding: `0 ${px(8)}` }, content: { margin: `${px(4)} 0` } } },
      MuiAccordionDetails: { styleOverrides: { root: { padding: px(8) } } },
      // VS Code's hover: the panel's colours with a border, opaque, no fade (it reads well over anything)
      MuiTooltip: {
        defaultProps: { enterDelay: 400, slotProps: { transition: { timeout: 0 } } },
        styleOverrides: { tooltip: { fontSize: px(12), fontWeight: 400, backgroundColor: t.panel, color: t.text, border: `1px solid ${t.border}`, borderRadius: 3, padding: `${px(4)} ${px(8)}` } },
      },
      MuiDialog: { styleOverrides: { paper: { borderRadius: 6, backgroundColor: t.panel } } },
      MuiDialogTitle: { styleOverrides: { root: { fontSize: px(15), fontWeight: 600, padding: `${px(12)} ${px(16)} ${px(8)}` } } },
      MuiDialogContent: { styleOverrides: { root: { padding: `${px(4)} ${px(16)} ${px(8)}` } } },
      MuiDialogActions: { styleOverrides: { root: { padding: `${px(8)} ${px(16)} ${px(12)}` } } },
      MuiStepLabel: { styleOverrides: { label: { fontSize: px(13) } } },
      MuiLink: { defaultProps: { underline: 'hover' } },
    },
  });
}

// ---- contrast (WCAG 2), for the unit test
function lum(hex: string) {
  const h = hex.replace('#', '');
  const v = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
}
export function contrast(a: string, b: string) {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
export function hue(hex: string) {
  const h = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (!d) return 0;
  const raw = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (raw * 60 + 360) % 360;
}

// ---- the code editor (Monaco) in the same colours and text size
export function monacoThemeName(theme: Theme) { return `specter-${theme.palette.shell.id}`; }
export function defineMonacoTheme(monaco: any, theme: Theme) {
  const t = theme.palette.shell;
  monaco.editor.defineTheme(monacoThemeName(theme), {
    base: t.mode === 'dark' ? 'vs-dark' : 'vs', inherit: true, rules: [],
    colors: {
      'editor.background': t.editor, 'editor.foreground': t.text, 'editorLineNumber.foreground': t.textMuted, 'editorLineNumber.activeForeground': t.text,
      'editor.selectionBackground': t.selection, 'editor.lineHighlightBackground': t.hover, 'editorCursor.foreground': t.primary,
      'editorWidget.background': t.panel, 'editorWidget.border': t.border, focusBorder: t.focus,
    },
  });
}
export const editorFontSize = (theme: Theme) => Math.round(13 * theme.palette.shell.zoom / 100);
