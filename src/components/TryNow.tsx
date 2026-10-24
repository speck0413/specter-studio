// Under "Try it now": the outputs the new effect turns on, live, right there. On a laptop screen the output tiles
// are below the fold, so pressing TRIG1 otherwise changes nothing you can see.
import { Box, Chip, Stack } from '@mui/material';
import { Board } from '../store';
import { levelText } from '../words';

export default function TryNow({ b, outputs }: { b: Board; outputs: string[] }) {
  const st: any = b.state || {};
  const label = (id: string) => b.info?.terminals?.find((t: any) => String(t.id).toUpperCase() === id)?.label;
  return (
    <Stack direction="row" spacing={1} sx={{ mt: 1 }} useFlexGap flexWrap="wrap" data-testid="try-now">
      {outputs.map((id) => {
        const o = st.outputs?.find((x: any) => x.channel === id);
        const on = !!o && o.level > 0;
        return <Chip key={id} color={on ? 'success' : 'default'} variant={on ? 'filled' : 'outlined'} data-testid={`try-now-${id}`}
          label={<Box component="span">{id}{label(id) ? ` (${label(id)})` : ''}: <b>{o ? levelText(id, o.level) : '?'}</b></Box>} />;
      })}
    </Stack>
  );
}
