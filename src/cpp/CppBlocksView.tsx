// The blocks editor for your own firmware: a Blockly workspace with the beginner-layer toolbox. Every edit
// gives back the workspace (to save beside the sketch) and the sketch it makes.
import { useEffect, useRef } from 'react';
import * as Blockly from 'blockly';
import { useTheme } from '@mui/material/styles';
import { CPP_TOOLBOX, defineCppBlocks, generateSketch } from './cppBlocks';
import { themeFor } from '../effects/BlocksView';

export default function CppBlocksView({ initial, onChange, dark }: { initial: unknown; onChange: (saved: unknown, code: string) => void; dark: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const ws = useRef<Blockly.WorkspaceSvg | null>(null);
  void dark;
  const theme = useTheme();
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const change = useRef(onChange);
  change.current = onChange;

  useEffect(() => {
    defineCppBlocks();
    const w = Blockly.inject(host.current!, {
      toolbox: CPP_TOOLBOX as any,
      theme: themeFor(themeRef.current),
      trashcan: true,
      zoom: { controls: true, wheel: false, startScale: 1.0, maxScale: 2, minScale: 0.5 },
      move: { scrollbars: true, drag: true, wheel: true },
      renderer: 'geras',
      media: '/blockly-media/',
    });
    ws.current = w;
    Blockly.Events.disable();
    try { Blockly.serialization.workspaces.load(initial as any, w); } finally { Blockly.Events.enable(); }
    let last = generateSketch(w);
    w.addChangeListener((e: Blockly.Events.Abstract) => {
      if (e.isUiEvent || w.isDragging()) return;
      const code = generateSketch(w);
      if (code !== last || e.type === Blockly.Events.BLOCK_MOVE) {
        last = code;
        change.current(Blockly.serialization.workspaces.save(w), code);
      }
    });
    const ro = new ResizeObserver(() => Blockly.svgResize(w));
    ro.observe(host.current!);
    return () => { ro.disconnect(); w.dispose(); ws.current = null; };
    // made once per project (the parent re-mounts it with a key)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { ws.current?.setTheme(themeFor(theme)); }, [theme]);

  return <div ref={host} style={{ width: '100%', height: '100%', minHeight: 360 }} aria-label="Firmware as blocks" role="application" data-testid="cpp-blocks" />;
}
