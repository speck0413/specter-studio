// Advanced: send any request to the board as JSON and see the raw answer and every event it pushes.
import { useEffect, useState } from 'react';
import { Box, Button, Stack, TextField, Typography } from '@mui/material';
import { onEvent, rpc } from '../api';

export default function ProtocolConsole({ boardKey }: { boardKey: string }) {
  const [req, setReq] = useState('{"op": "state"}');
  const [out, setOut] = useState('');
  const [events, setEvents] = useState<string[]>([]);
  useEffect(() => onEvent((e) => {
    if (e.kind === 'board' && e.key === boardKey && e.msg.event !== 'state') setEvents((l) => [...l.slice(-99), JSON.stringify(e.msg)]);
  }), [boardKey]);
  const send = async () => {
    try {
      setOut(JSON.stringify(await rpc(boardKey, JSON.parse(req)), null, 2));
    } catch (e: any) {
      setOut(String(e.message || e));
    }
  };
  return (
    <Stack spacing={2}>
      <TextField label="Request (JSON)" multiline minRows={3} value={req} onChange={(e) => setReq(e.target.value)} inputProps={{ style: { fontFamily: 'monospace' }, 'aria-label': 'Request' }} />
      <Box><Button variant="contained" onClick={send}>Send request</Button></Box>
      <Box component="pre" aria-label="Answer" sx={{ p: 2, bgcolor: 'action.hover', borderRadius: 2, overflow: 'auto', maxHeight: 400, m: 0 }}>{out}</Box>
      <Typography variant="h6" component="h3">Events (state updates hidden)</Typography>
      <Box component="pre" sx={{ p: 2, bgcolor: 'action.hover', borderRadius: 2, overflow: 'auto', maxHeight: 300, m: 0 }}>{events.slice().reverse().join('\n')}</Box>
    </Stack>
  );
}
