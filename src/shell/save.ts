// Save with the keyboard (Ctrl+S, ⌘S on a Mac): the page on screen that has something to save (the library's script
// editor, a board's Effect script tab) says what Save does there; the shortcut and the command palette run it. The
// key is always taken, also when nothing is registered, so the browser's or window's own "Save page" never opens.
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { matches } from './keys';

export const SAVE_KEYS = 'Mod+S';

export interface SaveTarget {
  /** what Save does here, in plain words, for the command palette: "Save “porch”" */
  label: string;
  run: () => void;
}

let targets: { id: number; target: () => SaveTarget }[] = [];
let nextId = 1;
let version = 0;
const listeners = new Set<() => void>();
const changed = () => { version++; listeners.forEach((l) => l()); };

/** Registers what Save does; the last one registered wins until it is removed. Returns the remover. */
export function registerSave(target: () => SaveTarget): () => void {
  const id = nextId++;
  targets.push({ id, target });
  changed();
  return () => { const before = targets.length; targets = targets.filter((t) => t.id !== id); if (targets.length !== before) changed(); };
}

/** What Save does right now, or null when nothing on screen has anything to save. */
export function currentSave(): SaveTarget | null {
  const t = targets[targets.length - 1];
  return t ? t.target() : null;
}

/** Runs the current Save; false when there is none. */
export function runSave(): boolean {
  const t = currentSave();
  if (!t) return false;
  t.run();
  return true;
}

/** A key event that is the Save shortcut: taken (never the browser's Save page) and run. True when it was Save. */
export function handleSaveKey(e: KeyboardEvent): boolean {
  if (!matches(e, SAVE_KEYS)) return false;
  e.preventDefault();
  e.stopPropagation();
  if (!e.repeat) runSave();
  return true;
}

/** Re-renders when what Save does changes (the command palette's entry). */
export function useSaveVersion() {
  return useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, () => version);
}

/** While the calling component is on screen, Ctrl+S / ⌘S runs `run` (always its latest version). */
export function useSaveShortcut(label: string, run: () => void, enabled = true) {
  const ref = useRef({ label, run });
  ref.current = { label, run };
  useEffect(() => {
    if (!enabled) return;
    return registerSave(() => ({ label: ref.current.label, run: () => ref.current.run() }));
  }, [enabled]);
  // the palette shows the label: tell it when the label changes
  useEffect(() => { if (enabled) changed(); }, [label, enabled]);
}
