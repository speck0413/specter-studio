// The editor's view: script and blocks side by side (stacked on narrow windows), the script only, or the blocks
// only. One choice per person (prefs.editorView), for the effect editor and the firmware sketch in blocks mode;
// both views edit the same text, so a hidden one is simply drawn again from it when it is shown.
import { ToggleButton, ToggleButtonGroup } from '@mui/material';

export type EditorView = 'both' | 'script' | 'blocks';
export const EDITOR_VIEWS: { value: EditorView; label: string }[] = [
  { value: 'both', label: 'Script and blocks' },
  { value: 'script', label: 'Script only' },
  { value: 'blocks', label: 'Blocks only' },
];

/** The person's choice, or the default (both, as the editor always opened) for anything else. */
export function editorView(v: unknown): EditorView {
  return v === 'script' || v === 'blocks' ? v : 'both';
}
export const showsScript = (v: EditorView) => v !== 'blocks';
export const showsBlocks = (v: EditorView) => v !== 'script';

export function EditorViewSwitch({ value, onChange, script = 'Script' }: { value: EditorView; onChange: (v: EditorView) => void; script?: string }) {
  return (
    <ToggleButtonGroup exclusive size="small" value={value} aria-label="Editor view" data-testid="editor-view"
      onChange={(_, v) => { if (v) onChange(v); }}>
      {EDITOR_VIEWS.map((x) => <ToggleButton key={x.value} value={x.value} sx={{ textTransform: 'none', px: 1.5, color: 'text.primary', '&.Mui-selected, &.Mui-selected:hover': { color: 'primary.contrastText', bgcolor: 'primary.main' } }}>{x.label.replace('Script', script)}</ToggleButton>)}
    </ToggleButtonGroup>
  );
}
