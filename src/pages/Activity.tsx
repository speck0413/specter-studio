// Everything that happened, across boards and extensions, newest first (Advanced).
import { Box, Typography } from '@mui/material';
import { useStore } from '../store';

export default function Activity() {
  const { boards, activity } = useStore();
  const all = [
    ...activity.map((a) => ({ ...a, who: 'Studio' })),
    ...Object.values(boards).flatMap((b) => b.log.map((l) => ({ ...l, who: b.info?.name || b.key }))),
  ].sort((a, b) => b.t - a.t).slice(0, 500);
  return (
    <Box>
      <Typography variant="h5" component="h2" gutterBottom>Activity</Typography>
      <Box component="ul" aria-label="All activity" sx={{ listStyle: 'none', p: 0, m: 0, fontFamily: 'monospace' }}>
        {all.map((l, i) => <li key={i}>{new Date(l.t).toLocaleTimeString()} · {l.who} · {l.text}</li>)}
        {all.length === 0 && <li style={{ fontFamily: 'inherit' }}>Nothing yet. Press an input on a board, send it an effect or change a setting, and it shows up here.</li>}
      </Box>
    </Box>
  );
}
