// A board's runs in one line: tonight (since it was powered on), lifetime, and when it last ran. For the board
// cards, the board page and the Dashboard's tiles.
import { useEffect, useState } from 'react';
import { Stack, Typography } from '@mui/material';
import { countsOf, topicLabel, whenText } from './events';
import { useFeed } from './feed';

/** Re-renders every `ms` (relative times: "2 min ago"). */
export function useNow(ms = 15000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t); }, [ms]);
  return now;
}

export default function RunCounts({ name, state, status, compact }: { name: string; state: any; status?: any; compact?: boolean }) {
  const f = useFeed();
  const now = useNow();
  const c = countsOf(state, status);
  const last = f.lastRun[topicLabel(name)]?.at;
  if (!c && !last) return null;
  const items: [string, string, string][] = [];
  if (c) items.push(['Runs tonight', String(c.tonight), 'runs-tonight'], ['Lifetime runs', c.lifetime.toLocaleString(), 'runs-lifetime']);
  items.push(['Last triggered', whenText(last, Math.max(now, last || 0)), 'last-triggered']);
  return (
    <Stack direction="row" spacing={compact ? 1.5 : 2.5} useFlexGap flexWrap="wrap" data-testid="run-counts" aria-label={`Runs of ${name}`}>
      {items.map(([k, v, id]) => (
        <Typography key={id} variant="body2" component="div" data-testid={id} title={id === 'runs-tonight' ? 'Since the board was powered on' : undefined}>
          <Typography component="span" variant="body2" color="text.secondary">{k} </Typography>
          <Typography component="span" variant="body2" sx={{ fontWeight: 600 }}>{v}</Typography>
        </Typography>
      ))}
    </Stack>
  );
}
