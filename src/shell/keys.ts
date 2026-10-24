// Keyboard shortcuts: written for this computer (Ctrl on Windows and Linux, ⌘ on a Mac) and matched the same way.
export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** "Mod+Shift+P" -> "Ctrl+Shift+P" (or "⌘⇧P" on a Mac) */
export function keyLabel(combo: string) {
  if (!isMac) return combo.replace(/Mod/g, 'Ctrl');
  return combo.replace(/Mod\+/g, '⌘').replace(/Shift\+/g, '⇧').replace(/Alt\+/g, '⌥').replace(/Ctrl\+/g, '⌃');
}

/** whether a key event is this combo ("Mod+Shift+P", "Alt+ArrowLeft", "F1", "Mod+="); letters ignore case */
export function matches(e: KeyboardEvent, combo: string) {
  const plus = combo.endsWith('++');
  const parts = (plus ? combo.slice(0, -2) : combo).split('+');
  const key = plus ? '+' : parts.pop()!;
  const want = new Set(parts);
  const mod = isMac ? e.metaKey : e.ctrlKey;
  if (want.has('Mod') !== mod) return false;
  if (want.has('Shift') !== e.shiftKey) return false;
  if (want.has('Alt') !== e.altKey) return false;
  if (!isMac && e.metaKey) return false;
  return e.key.toLowerCase() === key.toLowerCase() || e.code === key;
}
