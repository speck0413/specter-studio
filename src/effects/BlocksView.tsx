// The blocks view of an effect script ("building bricks"): one block per line, an effect block holds its lines.
// The text stays the source: blocks are made from it, and a block edit writes the text back.
import { useEffect, useRef } from 'react';
import * as Blockly from 'blockly';
import { useTheme, Theme } from '@mui/material/styles';
import { blockIdForLine, blocksToText, defineBlocks, textToBlocks, TOOLBOX } from './blocks';
import { levelFollowsTarget } from './fields';
import { onTermsChange } from './terms';

/** What the effect editor can ask of the blocks view: select (and scroll to) the block for a line of the text. */
export interface BlocksApi { selectLine: (line: number) => boolean }

const blocklyThemes: Record<string, Blockly.Theme> = {};
/** the blocks in the app's theme: its surfaces and text (theme.ts tokens); the block colours stay Blockly's */
export function themeFor(theme: Theme) {
  const t = theme.palette.shell;
  if (t.id === 'light') return Blockly.Themes.Classic;
  blocklyThemes[t.id] ??= Blockly.Theme.defineTheme(`specter-${t.id}`, {
    name: `specter-${t.id}`,
    base: Blockly.Themes.Classic,
    componentStyles: {
      workspaceBackgroundColour: t.editor,
      toolboxBackgroundColour: t.sideBar,
      toolboxForegroundColour: t.text,
      flyoutBackgroundColour: t.panel,
      flyoutForegroundColour: t.text,
      flyoutOpacity: 1,
      scrollbarColour: t.scrollbar,
      insertionMarkerColour: t.text,
      insertionMarkerOpacity: 0.3,
    },
  } as any);
  return blocklyThemes[t.id];
}

export default function BlocksView({ text, onChange, dark, apiRef }: { text: string; onChange: (t: string) => void; dark: boolean; apiRef?: React.MutableRefObject<BlocksApi | null> }) {
  const host = useRef<HTMLDivElement>(null);
  const ws = useRef<Blockly.WorkspaceSvg | null>(null);
  void dark;
  const theme = useTheme();
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const last = useRef<string | null>(null);
  // texts the blocks were loaded from: a late event from an earlier load must not send that text back
  const loaded = useRef<string[]>([]);
  const remember = (t: string) => { loaded.current = [...loaded.current.slice(-19), t]; };
  const change = useRef(onChange);
  change.current = onChange;

  useEffect(() => {
    defineBlocks();
    const w = Blockly.inject(host.current!, {
      toolbox: TOOLBOX as any,
      theme: themeFor(themeRef.current),
      trashcan: true,
      zoom: { controls: true, wheel: false, startScale: 1.1, maxScale: 2, minScale: 0.5 },
      move: { scrollbars: true, drag: true, wheel: true },
      renderer: 'geras',
      media: '/blockly-media/', // served from the app itself (offline, and the window's security policy)
    });
    ws.current = w;
    if (apiRef) apiRef.current = {
      selectLine: (line) => {
        const id = blockIdForLine(w, line);
        const b = id && w.getBlockById(id);
        if (!b) return false;
        (b as Blockly.BlockSvg).select();
        w.centerOnBlock(id);
        return true;
      },
    };
    last.current = text;
    remember(text);
    textToBlocks(w, text);
    w.addChangeListener((e: Blockly.Events.Abstract) => {
      if (e.isUiEvent || w.isDragging()) return;
      const t = blocksToText(w);
      if (t !== last.current && !loaded.current.includes(t)) {
        last.current = t;
        change.current(t);
      }
    });
    // a relay never keeps a percentage: an output changed to one turns its level into on or off, with a note
    w.addChangeListener(levelFollowsTarget(w));
    // the board's names arrive or change: the dropdowns show them
    const stopTerms = onTermsChange(() => {
      for (const b of w.getAllBlocks(false)) for (const inp of b.inputList) for (const f of inp.fieldRow) (f as any).forceRerender?.();
    });
    const ro = new ResizeObserver(() => Blockly.svgResize(w));
    ro.observe(host.current!);
    return () => {
      stopTerms();
      ro.disconnect();
      if (apiRef) apiRef.current = null;
      w.dispose();
      ws.current = null;
    };
    // the workspace is made once; text and theme changes are applied below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (ws.current && text !== last.current) {
      last.current = text;
      remember(text);
      textToBlocks(ws.current, text);
    }
  }, [text]);

  useEffect(() => {
    ws.current?.setTheme(themeFor(theme));
  }, [theme]);

  return <div ref={host} style={{ width: '100%', height: '100%', minHeight: 320 }} aria-label="Effect script as blocks" role="application" />;
}
