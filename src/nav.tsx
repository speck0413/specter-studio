// Where the app is (a view, and in it a board, an effect or a firmware), with back and forward like a browser
// or VS Code (Alt+Left / Alt+Right, the mouse's back and forward buttons). App.tsx owns the history and provides
// these; every jump in the app goes through them, so Back always returns to where the person was.
import { createContext, useCallback, useContext, useMemo, useState } from 'react';

export interface Loc {
  /** a view's id (shell/views.tsx), for example 'boards', 'library', 'settings', 'plugin:<id>' */
  view: string;
  /** boards: the open board's key (none: the overview of all boards) */
  board?: string;
  /** boards: the board page's section, for example 'script' */
  tab?: string;
  /** library: what is open in the editor */
  item?: { kind: 'effect' | 'firmware' | 'pattern'; name: string };
  /** bumped to open the same place again (reload the effect, unfold "Add a board") */
  seq?: number;
  /** boards overview: unfold "Add a board" */
  add?: boolean;
}

export interface Nav {
  loc: Loc;
  /** go somewhere (a new history entry) */
  go: (loc: Loc) => void;
  /** change the current entry without a new one (a board page's section, an effect renamed) */
  replace: (patch: Partial<Loc>) => void;
  back: () => void;
  forward: () => void;
  canBack: boolean;
  canForward: boolean;
  /** Your library, with this effect open */
  openEffect: (name: string) => void;
  /** a board's page; `tab` picks its section (for example 'script') */
  openBoard: (key: string, tab?: string) => void;
  /** the command palette (Ctrl+Shift+P); `text` starts it with a filter */
  openPalette: (text?: string) => void;
}

const noop = () => {};
export const NavContext = createContext<Nav>({
  loc: { view: 'boards' }, go: noop, replace: noop, back: noop, forward: noop, canBack: false, canForward: false,
  openEffect: noop, openBoard: noop, openPalette: noop,
});
export const useNav = () => useContext(NavContext);

const same = (a: Loc, b: Loc) => a.view === b.view && a.board === b.board && a.item?.kind === b.item?.kind && a.item?.name === b.item?.name;
const LIMIT = 50;

/** The history: a list of places and where in it the person is. `valid` skips places that went away (a removed
 * board) when going back or forward. */
export function useHistory(start: Loc, valid: (l: Loc) => boolean) {
  const [h, setH] = useState<{ list: Loc[]; at: number }>({ list: [start], at: 0 });
  const go = useCallback((loc: Loc) => setH(({ list, at }) => {
    const cur = list[at];
    // the same place again: no new entry (but open it again, for example a reloaded effect)
    if (same(cur, loc)) return { list: [...list.slice(0, at), { ...cur, ...loc, seq: (cur.seq || 0) + 1 }, ...list.slice(at + 1)], at };
    const next = [...list.slice(0, at + 1), loc].slice(-LIMIT);
    return { list: next, at: next.length - 1 };
  }), []);
  const replace = useCallback((patch: Partial<Loc>) => setH(({ list, at }) => ({ list: list.map((l, i) => (i === at ? { ...l, ...patch } : l)), at })), []);
  const step = useCallback((d: 1 | -1) => setH(({ list, at }) => {
    let i = at + d;
    while (i >= 0 && i < list.length && !valid(list[i])) i += d;
    return i >= 0 && i < list.length ? { list, at: i } : { list, at };
  }), [valid]);
  const back = useCallback(() => step(-1), [step]);
  const forward = useCallback(() => step(1), [step]);
  return useMemo(() => ({
    loc: h.list[h.at], go, replace, back, forward,
    canBack: h.list.slice(0, h.at).some(valid), canForward: h.list.slice(h.at + 1).some(valid),
  }), [h, go, replace, back, forward, valid]);
}
