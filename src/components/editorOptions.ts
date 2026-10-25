// What every Monaco editor in Studio gets on top of its own options. The editors sit in boxes that clip what spills
// out (rounded borders, a fixed height), and Monaco draws its hover help and suggestion list inside the editor, so
// help near an edge was cut off (on the right, or its first line at the top). Fixed overflow widgets are placed
// against the window instead: Monaco keeps them inside the visible area and no box clips them.
export function editorOptions<T extends Record<string, unknown>>(own: T | undefined, fontSize: number) {
  return { ...own, fontSize, fixedOverflowWidgets: true };
}
