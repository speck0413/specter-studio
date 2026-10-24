// The command palette (Ctrl+Shift+P, F1, or the search box in the title bar): every place, board, effect and
// main action in one list you can type into, each with its shortcut, so nothing has to be found by hunting.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Dialog, InputBase, Typography } from '@mui/material';
import { keyLabel } from './keys';

export interface Command {
  id: string;
  /** what it does, in plain words: "Go to Your library", "Open board: Porch" */
  label: string;
  /** the kind, shown on the right: Go to, Board, Effect, Action, Theme, Text size */
  group: string;
  keys?: string;
  /** more words it is found by */
  also?: string;
  run: () => void;
}

/** a command matches when every typed word is in its label, group or extra words */
export function filterCommands(list: Command[], text: string) {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return list;
  const plain = (t: string) => t.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const phrase = plain(text);
  const hits = list.filter((c) => { const hay = `${c.label} ${c.group} ${c.also || ''}`.toLowerCase(); return words.every((w) => hay.includes(w)); });
  // what was typed, as it is written in the name, first ("theme light": Theme: Light before Theme: follow … Light …)
  const rank = (c: Command) => { const l = plain(c.label); return l.startsWith(phrase) ? 0 : l.includes(phrase) ? 1 : 2; };
  return hits.map((c, i) => ({ c, i, r: rank(c) })).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.c);
}

export default function CommandPalette({ open, initial, commands, onClose }: { open: boolean; initial: string; commands: Command[]; onClose: () => void }) {
  const [text, setText] = useState(initial);
  const [at, setAt] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => { if (open) { setText(initial); setAt(0); } }, [open, initial]);
  const shown = useMemo(() => filterCommands(commands, text).slice(0, 200), [commands, text]);
  useEffect(() => { setAt(0); }, [text]);
  useEffect(() => { listRef.current?.querySelector(`[data-index="${at}"]`)?.scrollIntoView({ block: 'nearest' }); }, [at]);
  const run = (c?: Command) => { if (!c) return; onClose(); setTimeout(c.run, 0); };
  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm"
      sx={{ '& .MuiDialog-container': { alignItems: 'flex-start' } }} slotProps={{ paper: { 'aria-label': 'Command palette', sx: { mt: 12, borderRadius: 1.5, border: 1, borderColor: 'divider' } } as any }}>
      <Box sx={{ p: 1.5 }}>
        <InputBase autoFocus fullWidth value={text} onChange={(e) => setText(e.target.value)} placeholder="Type a board, an effect or what you want to do"
          inputProps={{ 'aria-label': 'Search boards, effects and commands', role: 'combobox', 'aria-expanded': true, 'aria-controls': 'palette-list', 'aria-activedescendant': shown[at] ? `palette-${at}` : undefined, 'aria-autocomplete': 'list' }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setAt((i) => Math.min(shown.length - 1, i + 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setAt((i) => Math.max(0, i - 1)); }
            else if (e.key === 'PageDown') { e.preventDefault(); setAt((i) => Math.min(shown.length - 1, i + 10)); }
            else if (e.key === 'PageUp') { e.preventDefault(); setAt((i) => Math.max(0, i - 10)); }
            else if (e.key === 'Enter') { e.preventDefault(); run(shown[at]); }
          }}
          sx={{ px: 2, py: 1, border: 1, borderColor: 'primary.main', borderRadius: 1, fontSize: 'body1.fontSize' }} />
      </Box>
      <Box component="ul" id="palette-list" role="listbox" aria-label="Commands" ref={listRef} data-testid="palette-list"
        sx={{ listStyle: 'none', m: 0, p: 0, pb: 1.5, maxHeight: '50vh', overflowY: 'auto' }}>
        {shown.map((c, i) => (
          <Box component="li" key={c.id} id={`palette-${i}`} data-index={i} role="option" aria-selected={i === at} aria-label={c.keys ? `${c.label} (${keyLabel(c.keys)})` : c.label}
            onMouseMove={() => setAt(i)} onClick={() => run(c)}
            sx={{ display: 'flex', alignItems: 'center', gap: 2, px: 3, minHeight: (t) => t.spacing(6.5), cursor: 'pointer', bgcolor: i === at ? 'action.selected' : undefined }}>
            <Box component="span" sx={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.label}</Box>
            {c.keys && <Box component="kbd" aria-hidden>{keyLabel(c.keys)}</Box>}
            <Typography component="span" aria-hidden variant="caption" color="text.secondary" sx={{ minWidth: 64, textAlign: 'right' }}>{c.group}</Typography>
          </Box>
        ))}
        {shown.length === 0 && <Typography component="li" color="text.secondary" sx={{ px: 3, py: 1 }}>Nothing matches “{text}”.</Typography>}
      </Box>
    </Dialog>
  );
}
