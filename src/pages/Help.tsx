// Help: the wiring guides that ship with the firmware (offline pages), and where to start.
import { Alert, Box, Stack, Typography } from '@mui/material';
import { pluginUrl } from '../api';
import { useGuides } from '../components/WiringGuide';

export default function Help() {
  const g = useGuides();
  return (
    <Stack spacing={2}>
      <Typography variant="h5" component="h2">Help</Typography>
      <Typography>
        New here? Add a practice board on the Boards page, then open Your library and press “Start from an example”.
        Every board page has “How do I wire this?” next to each input and output.
      </Typography>
      <Typography variant="h6" component="h3">Record an effect, then tweak it</Typography>
      <Typography data-testid="help-record">
        On a board page, “Make it do something…” and then “Record effect” lets you tap the outputs while the board copies you.
        After recording, open the effect in Your library and tweak it in the script or blocks view: the switch above
        the editor shows “Script and blocks”, “Script only” or “Blocks only”, and both always show the same effect.
      </Typography>
      <Typography variant="h6" component="h3">Wiring guides</Typography>
      {g && !g.available && <Alert severity="info">The wiring guides are not installed with this copy of Specter Studio yet.</Alert>}
      {g?.available && (
        <Box sx={{ height: 'calc(100vh - 260px)', minHeight: 400, border: 1, borderColor: 'divider', borderRadius: 2, overflow: 'hidden' }}>
          <iframe title="Wiring guides" src={pluginUrl('wiring-guides', 'index.html')} style={{ border: 0, width: '100%', height: '100%' }} sandbox="allow-scripts allow-same-origin" />
        </Box>
      )}
    </Stack>
  );
}
