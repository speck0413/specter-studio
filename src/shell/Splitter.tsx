// A draggable divider between two panes (side bar | work area, board sections | Live). Keyboard: focus it and
// use the arrow keys (Home / End for the smallest and largest); double-click puts it back.
import { useRef } from 'react';
import { Box } from '@mui/material';

export default function Splitter({ value, min, max, onChange, label, side = 'left', reset }: {
  /** the width of the pane it sizes, in px */
  value: number; min: number; max: number; onChange: (v: number) => void; label: string;
  /** which side of the divider that pane is on */
  side?: 'left' | 'right'; reset?: number;
}) {
  const start = useRef<{ x: number; v: number } | null>(null);
  const clamp = (v: number) => Math.round(Math.min(max, Math.max(min, v)));
  const sign = side === 'left' ? 1 : -1;
  return (
    <Box role="separator" aria-orientation="vertical" aria-label={label} aria-valuenow={Math.round(value)} aria-valuemin={min} aria-valuemax={max} tabIndex={0}
      onPointerDown={(e) => { if (e.button !== 0) return; (e.target as Element).setPointerCapture(e.pointerId); start.current = { x: e.clientX, v: value }; }}
      onPointerMove={(e) => { if (start.current) onChange(clamp(start.current.v + sign * (e.clientX - start.current.x))); }}
      onPointerUp={() => { start.current = null; }} onPointerCancel={() => { start.current = null; }}
      onDoubleClick={() => reset !== undefined && onChange(reset)}
      onKeyDown={(e) => {
        const d = e.shiftKey ? 40 : 10;
        if (e.key === 'ArrowLeft') onChange(clamp(value - sign * d));
        else if (e.key === 'ArrowRight') onChange(clamp(value + sign * d));
        else if (e.key === 'Home') onChange(min);
        else if (e.key === 'End') onChange(max);
        else return;
        e.preventDefault();
      }}
      sx={{
        width: 5, mx: '-2px', flexShrink: 0, cursor: 'col-resize', zIndex: 2, position: 'relative', touchAction: 'none',
        '&::after': { content: '""', position: 'absolute', top: 0, bottom: 0, left: 2, width: '1px', bgcolor: 'divider' },
        '&:hover::after, &:focus-visible::after, &:active::after': { left: 1, width: 3, bgcolor: 'primary.main' },
        '&:focus-visible': { outline: 'none' },
      }} />
  );
}
