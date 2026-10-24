// The Boards side bar: every board in one short list. Selecting one opens it in the work area; right-click (or
// the ⋯ button, or Shift+F10) has what you can do with it, the same as its page and its card.
import { memo, useState } from 'react';
import { Box, Divider, IconButton, ListItemText, Menu, MenuItem, TextField, Tooltip, Typography } from '@mui/material';
import MoreHoriz from '@mui/icons-material/MoreHoriz';
import AddCircleOutline from '@mui/icons-material/AddCircleOutline';
import ViewModule from '@mui/icons-material/ViewModule';
import { Board, useStore } from '../store';
import { useNav } from '../nav';
import { useBoardActions } from '../components/actions';
import { scriptBadge, supportsScripts } from '../words';
import { SideBarBody, SideBarHeader } from './SideBar';

/** What a board needs, in two or three words beside its name (nothing when all is well). */
function attention(b: Board): { text: string; tone: 'warning' | 'error' | 'info' } | null {
  if (!b.online) return { text: 'not answering', tone: 'error' };
  if (b.state?.paused) return { text: 'stopped', tone: 'error' };
  if (b.firmware?.plan?.out_of_date) return { text: 'update', tone: 'warning' };
  const s = scriptBadge(b);
  if (s.tone === 'warning') return { text: 'newer effect', tone: 'warning' };
  return null;
}

export default function BoardsSideBar() {
  const { boards } = useStore();
  const nav = useNav();
  const [filter, setFilter] = useState('');
  const [menu, setMenu] = useState<{ key: string; el?: HTMLElement; x?: number; y?: number } | null>(null);
  const list = Object.values(boards).sort((a, b) => String(a.info?.name).localeCompare(String(b.info?.name)));
  const shown = list.filter((b) => !filter || String(b.info?.name || b.key).toLowerCase().includes(filter.toLowerCase()));
  const open = nav.loc.view === 'boards' ? nav.loc.board : undefined;
  return (
    <>
      <SideBarHeader title="Boards">
        <Tooltip title="Overview of all boards"><IconButton aria-label="Overview of all boards" onClick={() => nav.go({ view: 'boards' })}><ViewModule fontSize="small" /></IconButton></Tooltip>
        <Tooltip title="Find or add boards (a practice board, or boards on your network)"><IconButton aria-label="Find or add boards" onClick={() => nav.go({ view: 'boards', add: true })}><AddCircleOutline fontSize="small" /></IconButton></Tooltip>
      </SideBarHeader>
      {list.length > 6 && (
        <Box sx={{ px: 2, pb: 1 }}>
          <TextField fullWidth placeholder="Filter boards" value={filter} onChange={(e) => setFilter(e.target.value)} inputProps={{ 'aria-label': 'Filter boards' }} />
        </Box>
      )}
      <SideBarBody label="Boards list">
        <Box component="ul" sx={{ listStyle: 'none', m: 0, p: 0 }}>
          {shown.map((b) => <Row key={b.key} b={b} selected={b.key === open} onMenu={(el, x, y) => setMenu({ key: b.key, el, x, y })} />)}
        </Box>
        {list.length === 0 && (
          <Typography variant="body2" color="text.secondary" sx={{ px: 3, py: 1 }} data-testid="sidebar-empty">
            Nothing here yet. Press <b>Find or add boards</b> (the + above) to add a practice board or find boards on your network.
          </Typography>
        )}
        {list.length > 0 && !open && (
          <Typography variant="body2" color="text.secondary" sx={{ px: 3, py: 2 }}>Pick a board to open it. Right-click a board for what you can do with it.</Typography>
        )}
      </SideBarBody>
      {menu && boards[menu.key] && <BoardMenu b={boards[menu.key]} anchor={menu} onClose={() => setMenu(null)} />}
    </>
  );
}

const Row = memo(function Row({ b, selected, onMenu }: { b: Board; selected: boolean; onMenu: (el?: HTMLElement, x?: number, y?: number) => void }) {
  const nav = useNav();
  const a = attention(b);
  const name = b.info?.name || b.key;
  return (
    <Box component="li" data-testid={`sidebar-board-${name}`}
      onContextMenu={(e) => { e.preventDefault(); onMenu(undefined, e.clientX, e.clientY); }}
      sx={{
        display: 'flex', alignItems: 'center', height: (t) => t.spacing(6), pl: 3, pr: 1, cursor: 'pointer', position: 'relative',
        bgcolor: selected ? 'action.selected' : undefined, '&:hover': { bgcolor: selected ? 'action.selected' : 'action.hover' },
        '& .more': { visibility: selected ? 'visible' : 'hidden' }, '&:hover .more, &:focus-within .more': { visibility: 'visible' },
      }}>
      <Box component="button" type="button" aria-current={selected ? 'page' : undefined} title={`${name}: ${b.online ? 'connected' : 'not answering'}`}
        onClick={() => nav.openBoard(b.key)}
        onKeyDown={(e) => { if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) { e.preventDefault(); onMenu(e.currentTarget as HTMLElement); } }}
        sx={{
          all: 'unset', flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 2, height: '100%', color: 'text.primary', fontSize: 'body1.fontSize',
          '&:focus-visible': { outline: 2, outlineStyle: 'solid', outlineColor: 'primary.main', outlineOffset: -2 },
          '&::before': { content: '""', position: 'absolute', inset: 0 }, // the whole row is the button's target
        }}>
        <Box aria-hidden sx={{ width: 8, height: 8, flexShrink: 0, borderRadius: '50%', bgcolor: b.online ? 'success.main' : 'text.disabled' }} />
        <Box component="span" sx={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: selected ? 600 : 400 }}>{name}</Box>
        {a && <Box component="span" sx={{ fontSize: 'caption.fontSize', color: `${a.tone}.main`, whiteSpace: 'nowrap' }}>{a.text}</Box>}
      </Box>
      <IconButton className="more" aria-label={`More for ${name}`} aria-haspopup="menu" onClick={(e) => onMenu(e.currentTarget)} sx={{ p: 0.5, position: 'relative' }}>
        <MoreHoriz fontSize="small" />
      </IconButton>
    </Box>
  );
});

/** What you can do with a board, from the side bar (right-click or ⋯). */
export function BoardMenu({ b, anchor, onClose }: { b: Board; anchor: { el?: HTMLElement; x?: number; y?: number }; onClose: () => void }) {
  const nav = useNav();
  const act = useBoardActions();
  const { remove } = useStore();
  const name = b.info?.name || b.key;
  const run = (f: () => unknown) => () => { onClose(); void f(); };
  const items: (false | { label: string; run: () => unknown; danger?: boolean; disabled?: boolean } | 'divider')[] = [
    { label: 'Open', run: () => nav.openBoard(b.key) },
    supportsScripts(b) && { label: 'Its effect script', run: () => nav.openBoard(b.key, 'script') },
    { label: 'Its settings', run: () => nav.openBoard(b.key, 'settings') },
    'divider',
    supportsScripts(b) && { label: 'Send an effect…', run: async () => { const n = await act.pickEffect(`Send an effect to ${name}`); if (n) await act.sendEffect(b.key, n); } },
    !!b.firmware?.plan?.out_of_date && { label: 'Update firmware', run: () => act.updateFirmware(b.key) },
    { label: 'Back up', run: () => act.backup(b.key) },
    'divider',
    { label: 'Stop this board', run: () => act.stop(b.key), disabled: !b.online, danger: true },
    { label: 'Restart', run: () => act.restart(b.key), disabled: !b.online },
    { label: 'Remove from Studio…', danger: true, run: async () => { if (await act.confirm(`Remove ${name} from Studio?`, 'Studio stops showing this board. Nothing on the board changes; you can add it again any time.', 'Remove')) { await remove(b.key); nav.go({ view: 'boards' }); } } },
  ];
  return (
    <Menu open onClose={onClose} anchorEl={anchor.el} anchorReference={anchor.el ? 'anchorEl' : 'anchorPosition'}
      anchorPosition={anchor.el ? undefined : { top: anchor.y || 0, left: anchor.x || 0 }} MenuListProps={{ 'aria-label': `What to do with ${name}` }}>
      {items.filter(Boolean).map((x, i) => (x === 'divider'
        ? <Divider key={i} />
        : <MenuItem key={i} disabled={(x as any).disabled} onClick={run((x as any).run)} sx={(x as any).danger ? { color: 'error.main' } : undefined}>
            <ListItemText>{(x as any).label}</ListItemText>
          </MenuItem>))}
    </Menu>
  );
}

