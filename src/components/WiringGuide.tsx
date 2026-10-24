// The wiring guides (small offline pages that ship with the firmware): shown in a frame, opened at a topic.
import { useEffect, useState } from 'react';
import { Alert, Button, Dialog, DialogActions, DialogContent, DialogTitle } from '@mui/material';
import { call, pluginUrl } from '../api';
import { guidePage, relayNote } from '../words';

export { guidePage };

export function useGuides() {
  const [g, setG] = useState<{ available: boolean; pages: string[] } | null>(null);
  useEffect(() => { call('guides').then(setG).catch(() => setG({ available: false, pages: [] })); }, []);
  return g;
}


export default function WiringGuide({ topic, onClose }: { topic: string; onClose: () => void }) {
  const g = useGuides();
  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="lg">
      <DialogTitle>How to wire {topic}</DialogTitle>
      <DialogContent sx={{ height: '75vh' }}>
        {g && !g.available && <Alert severity="info">The wiring guides are not installed with this copy of Specter Studio yet.</Alert>}
        {g?.available && relayNote(g.pages, topic) && <Alert severity="info" sx={{ mb: 1 }} data-testid="relay-note">{relayNote(g.pages, topic)}</Alert>}
        {g?.available && <iframe title={`Wiring guide: ${topic}`} src={pluginUrl('wiring-guides', guidePage(g.pages, topic))} style={{ border: 0, width: '100%', height: '100%' }} sandbox="allow-scripts allow-same-origin" />}
      </DialogContent>
      <DialogActions><Button onClick={onClose}>Close</Button></DialogActions>
    </Dialog>
  );
}
