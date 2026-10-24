// The board page's step to the board's effect script in Your library: open it there, or (a script Your library does
// not have) keep it there first and then open it. Back returns to the board.
import { Button } from '@mui/material';
import OpenInNew from '@mui/icons-material/OpenInNew';
import type { Board } from '../store';
import { useStore } from '../store';
import { useNav } from '../nav';
import { useBoardActions } from './actions';
import { boardLink } from '../scriptLinks';
import { supportsScripts } from '../words';

/** Opens the board's script in Your library, saving it there first when it is not in the library yet. */
export function useOpenBoardScript() {
  const nav = useNav();
  const act = useBoardActions();
  return async (b: Board) => {
    const l = boardLink(b);
    if (l.kind === 'library') nav.openEffect(l.name);
    else if (l.kind === 'not-in-library') {
      const name = await act.saveBoardScriptAsNew(b.key);
      if (name) nav.openEffect(name);
    }
  };
}

export default function BoardScriptLink({ b }: { b: Board }) {
  const { prefs } = useStore();
  const act = useBoardActions();
  const open = useOpenBoardScript();
  if (!supportsScripts(b) || !prefs.workspace) return null;
  const l = boardLink(b);
  const boardName = b.info?.name || b.key;
  if (l.kind === 'library') {
    return <Button size="small" variant="outlined" startIcon={<OpenInNew fontSize="small" />} onClick={() => void open(b)} data-testid="open-board-script"
      title={`Opens “${l.name}” in Your library, where you can change it and send it to other boards`}>Open in Your library</Button>;
  }
  if (l.kind === 'not-in-library') {
    return <Button size="small" variant="outlined" startIcon={<OpenInNew fontSize="small" />} onClick={() => void open(b)} disabled={!!act.busy[b.key] || !b.online} data-testid="open-board-script"
      title={b.online ? `Reads ${boardName}'s effect script, keeps it in Your library as a new effect (nothing there is replaced), then opens it` : `${boardName} is not answering; you can save its script once it answers again`}>Save to Your library and open</Button>;
  }
  return null;
}
