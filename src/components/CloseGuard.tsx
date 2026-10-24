// The desktop window asks before it closes with unsaved effect or settings edits, in Studio's own dialog (a
// webview's beforeunload or window.confirm can block closing without showing anything). In a browser tab the
// beforeunload prompt in drafts.ts does this instead. "Close without saving" also forgets the disk copy kept for
// a crash (hotexit.ts); a crash, a kill or the computer shutting down keeps it for the next start.
import { useEffect, useRef } from 'react';
import { inTauri } from '../api';
import { closeQuestion, inFlight, onCloseRequest, unsavedBoardScripts, unsavedNames, unsavedSettingsBoards, unsavedSketches } from '../drafts';
import { hotExit } from '../hotexit';
import { useStore } from '../store';
import { useBoardActions } from './actions';

export default function CloseGuard() {
  const act = useBoardActions();
  const { boards } = useStore();
  const boardsRef = useRef(boards);
  boardsRef.current = boards;
  useEffect(() => {
    if (!inTauri) return;
    let unlisten: (() => void) | undefined;
    let gone = false;
    void (async () => {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      const win = getCurrentWindow();
      const nameOf = (key: string) => boardsRef.current[key]?.info?.name || key;
      const u = await win.onCloseRequested((e) => onCloseRequest(e, closeQuestion(unsavedNames(), unsavedSettingsBoards().map(nameOf), unsavedSketches(), [...inFlight.values()], unsavedBoardScripts().map(nameOf)), act.confirm, async () => { await hotExit.discardForClose(); await win.destroy(); }));
      if (gone) u(); else unlisten = u;
    })();
    return () => { gone = true; unlisten?.(); };
  }, [act.confirm]);
  return null;
}
