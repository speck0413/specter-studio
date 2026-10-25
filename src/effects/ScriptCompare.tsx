// A board's effect script beside the library's copy of the same effect, with what differs marked (Monaco's diff
// view, the effect language's colours), and the two ways to make them the same.
import { Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Stack, Typography, useMediaQuery, useTheme } from '@mui/material';
import { defineMonacoTheme, editorFontSize, monacoThemeName } from '../theme';
import { DiffEditor } from '@monaco-editor/react';
import { setupMonaco } from './monaco';
import { LANG_ID } from './language';
import { editorOptions } from '../components/editorOptions';

setupMonaco();

export default function ScriptCompare({ name, boardName, boardText, libraryText, librarySaved, dark, onClose, onUseLibrary, onKeepBoard }: {
  name: string; boardName: string; boardText: string; libraryText: string; librarySaved?: string; dark: boolean;
  onClose: () => void;
  /** send the library's version to the board */
  onUseLibrary: () => void;
  /** save the board's version to the library */
  onKeepBoard: () => void;
}) {
  const wide = useMediaQuery('(min-width: 900px)');
  const theme = useTheme();
  void dark;
  const same = boardText.replace(/\s+$/, '') === libraryText.replace(/\s+$/, '');
  return (
    <Dialog open onClose={onClose} maxWidth="xl" fullWidth aria-labelledby="compare-title">
      <DialogTitle id="compare-title">“{name}”: {boardName} and Your library</DialogTitle>
      <DialogContent>
        <Stack direction="row" spacing={2} sx={{ mb: 1 }}>
          <Typography variant="subtitle2" sx={{ flex: 1 }} data-testid="compare-left">In Your library{librarySaved ? ` (saved ${librarySaved})` : ''}</Typography>
          {wide && <Typography variant="subtitle2" sx={{ flex: 1 }}>On {boardName}</Typography>}
        </Stack>
        <Typography variant="body2" color="text.secondary" gutterBottom>
          {same ? 'They are the same.' : `Lines only in Your library are marked red, lines only on ${boardName} green.`}
        </Typography>
        <Box sx={{ height: '60vh', minHeight: 320, border: 1, borderColor: 'divider', borderRadius: 2, overflow: 'hidden' }} data-testid="script-diff">
          <DiffEditor language={LANG_ID} theme={monacoThemeName(theme)} beforeMount={(m) => defineMonacoTheme(m, theme)} original={libraryText} modified={boardText}
            options={editorOptions({ readOnly: true, originalEditable: false, renderSideBySide: wide, minimap: { enabled: false }, wordWrap: 'on', scrollBeyondLastLine: false, automaticLayout: true }, editorFontSize(theme))} />
        </Box>
      </DialogContent>
      <DialogActions sx={{ flexWrap: 'wrap', gap: 1 }}>
        <Button onClick={onClose}>Close</Button>
        <Button variant="outlined" onClick={onKeepBoard} disabled={same}>Save {boardName}'s version to Your library</Button>
        <Button variant="contained" onClick={onUseLibrary} disabled={same}>Send Your library's version to {boardName}</Button>
      </DialogActions>
    </Dialog>
  );
}
