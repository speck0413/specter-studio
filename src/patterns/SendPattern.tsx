// "Send to a board" for one LED pattern: the boards that play patterns (capability `patterns`; the Pico W, the
// Pico and the ESP32-C3 have no player and are not offered), the compiled program with the preview's control
// values, and the board's answer in plain words.
import { useState } from 'react';
import { Alert, Button, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, Radio, RadioGroup, Stack, Typography } from '@mui/material';
import { rpc } from '../api';
import { useStore } from '../store';
import { preparePattern } from './send';

const playsPatterns = (b: any) => !!b?.info?.capabilities?.includes('patterns');

/** The board's number of lights (its pixel_count setting), else 16. */
async function pixelCount(key: string): Promise<number> {
  try {
    const r = await rpc(key, { op: 'get_params' });
    const v = r?.result?.values?.find((x: any) => x.key === 'pixel_count')?.value;
    if (typeof v === 'number' && v >= 1) return v;
  } catch { /* the default */ }
  return 16;
}

export default function SendPattern({ name, source, controls }: { name: string; source: string; controls: () => Record<string, number[]> }) {
  const { boards, change } = useStore();
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const online = Object.values(boards).filter((b) => b.online && !b.adapter);
  const players = online.filter(playsPatterns);
  const others = online.filter((b) => !playsPatterns(b));
  const label = (b: any) => b.info?.name || b.key;

  const send = async () => {
    const b = boards[key];
    if (!b) return;
    setBusy(true);
    setAnswer(null);
    try {
      const prepared = preparePattern(name, source, controls(), await pixelCount(key));
      if (!prepared.ok) { setAnswer({ tone: 'error', text: prepared.message }); return; }
      const r = await change(key, prepared.req);
      if (r?.ok) {
        const res = r.result || {};
        const buttons = Array.isArray(res.buttons) && res.buttons.length ? ` Its buttons for a script's “pixels press”: ${res.buttons.join(', ')}.` : '';
        setAnswer({ tone: 'success', text: `Sent to ${label(b)}: kept as “${res.name}” (${res.patterns} of 8 patterns on the board). A script plays it with “pixels = pattern ${String(res.name).toLowerCase()}”.${buttons}` });
      } else setAnswer({ tone: 'error', text: `${label(b)} did not take it: ${r?.error?.message || 'no answer'}` });
    } catch (e: any) {
      setAnswer({ tone: 'error', text: String(e?.message || e) });
    } finally { setBusy(false); }
  };

  return (
    <>
      <Button variant="outlined" data-testid="pattern-send" onClick={() => { setOpen(true); setAnswer(null); if (!key && players.length) setKey(players[0].key); }}>Send to a board…</Button>
      <Dialog open={open} onClose={() => setOpen(false)} fullWidth maxWidth="sm" aria-labelledby="send-pattern-title">
        <DialogTitle id="send-pattern-title">Send “{name}” to a board</DialogTitle>
        <DialogContent>
          <Stack spacing={1.5}>
            {players.length === 0 && <Alert severity="info">No board that plays LED patterns is online. An ESP32, an ESP32-S3 or a Pico 2 W board plays them; a Pico W, a Pico or an ESP32-C3 does not.</Alert>}
            {players.length > 0 && (
              <RadioGroup value={key} onChange={(e) => setKey(e.target.value)} aria-label="Board" data-testid="pattern-send-boards">
                {players.map((b) => <FormControlLabel key={b.key} value={b.key} control={<Radio />} label={label(b)} />)}
              </RadioGroup>
            )}
            {others.length > 0 && <Typography variant="body2" color="text.secondary">No pattern player on {others.map(label).join(', ')}.</Typography>}
            <Typography variant="body2" color="text.secondary">The board keeps it under this name with the sliders and colours as they are now, and starts it where a script says “pixels = pattern {name.toLowerCase()}”.</Typography>
            {answer && <Alert severity={answer.tone} data-testid="pattern-send-answer">{answer.text}</Alert>}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpen(false)}>Close</Button>
          <Button variant="contained" disabled={!key || !boards[key] || busy} onClick={() => void send()}>{busy ? 'Sending…' : 'Send'}</Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
