// A new effect from plain choices: "when TRIG1 is pressed, turn on RLY1 for 5 seconds", with hints on what
// usually goes where. It writes the first lines; the editor takes it from there. From a board's page it also
// shows the names given on that board ("RLY1: skull button") and sends the effect straight to the board.
import { useState } from 'react';
import { Alert, Button, Dialog, DialogActions, DialogContent, DialogTitle, MenuItem, Stack, TextField, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';

const INPUTS = [['trig1', 'TRIG1 (a button, pressure mat or motion sensor)'], ['trig2', 'TRIG2']];
const OUTPUTS = [['out1', 'OUT1 (lights, LED strips: can dim)'], ['out2', 'OUT2 (can dim)'], ['out3', 'OUT3 (can dim)'], ['out4', 'OUT4 (can dim)'],
  ['rly1', 'RLY1 (relay: low-voltage buttons; ≤30 V DC on rev A)'], ['rly2', 'RLY2 (relay)'], ['cc1', 'CC1 (contact: start another controller)'], ['cc2', 'CC2 (contact)']];

export function starterScript(name: string, input: string, output: string, seconds: number, sound: boolean, also = '') {
  // the board reads a ':' as the end of the name and a '#' as the start of a comment: neither can be in it
  const effect = name.replace(/[:#]/g, '').trim().slice(0, 32).trim() || 'my effect';
  const second = also && also !== output ? also : '';
  return `effect ${effect}:\n  wait for ${input}\n  ${output} = on\n${second ? `  ${second} = on\n` : ''}${sound ? '  audio_single = 1\n' : ''}  wait ${seconds}\n${second ? `  ${second} = off\n` : ''}  ${output} = off\n`;
}

/** A choice's words, with the name given on the board when there is one: "RLY1: skull button". */
export function choiceLabel(id: string, words: string, labels: Record<string, string>) {
  const named = labels[id.toUpperCase()];
  return named ? `${id.toUpperCase()}: ${named}` : words;
}

export interface Choice { input: string; output: string; also: string; seconds: number; sound: boolean }

export default function NewEffect({ open, onClose, onCreate, labels = {}, boardName, replacing, onRecord }: {
  open: boolean; onClose: () => void; onCreate: (name: string, text: string, choice: Choice) => void;
  /** from a board's page: the second way, "Record effect" (the board copies what you tap, live) */
  onRecord?: () => void;
  /** names given on the board, by terminal (OUT1 → lamp) */
  labels?: Record<string, string>;
  /** set when it is made from a board's page: the effect goes straight to that board */
  boardName?: string;
  /** the effect script on that board now, which this one replaces: its name, or true when it has none */
  replacing?: string | true;
}) {
  const [name, setName] = useState('');
  const [input, setInput] = useState('trig1');
  const [output, setOutput] = useState('out1');
  const [also, setAlso] = useState('');
  const [seconds, setSeconds] = useState(5);
  const [sound, setSound] = useState('no');
  const submit = () => { if (name.trim()) onCreate(name.trim(), starterScript(name, input, output, seconds, sound === 'yes', also), { input, output, also: also !== output ? also : '', seconds, sound: sound === 'yes' }); };
  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <DialogTitle>{boardName ? `What should ${boardName} do?` : 'New effect'}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            {onRecord && (
              <Stack spacing={1}>
                <ToggleButtonGroup exclusive fullWidth color="primary" value="form" aria-label="How do you want to make it?"
                  onChange={(_, v) => { if (v === 'tap') onRecord(); }}>
                  <ToggleButton value="form" sx={{ textTransform: 'none', fontSize: '1rem' }}>Fill in a form</ToggleButton>
                  <ToggleButton value="tap" sx={{ textTransform: 'none', fontSize: '1rem' }}>Record effect</ToggleButton>
                </ToggleButtonGroup>
                <Typography variant="body2" color="text.secondary">Record effect: tap or hold the outputs yourself, the board copies you as you go, then does it every time it is triggered.</Typography>
              </Stack>
            )}
            <TextField autoFocus label="Name" placeholder="lamp and prop - lab room 1" value={name} onChange={(e) => setName(e.target.value)}
              helperText={boardName ? 'Any name you like, so you can find it again in Your library.' : undefined} />
            <TextField select label="When this is pressed" value={input} onChange={(e) => setInput(e.target.value)}>
              {INPUTS.map(([v, l]) => <MenuItem key={v} value={v}>{choiceLabel(v, l, labels)}</MenuItem>)}
            </TextField>
            <TextField select label="Turn on" value={output} onChange={(e) => { setOutput(e.target.value); if (e.target.value === also) setAlso(''); }} helperText="Lights: OUT1–OUT4 (air valves and motors too). A store-bought prop's button: RLY1. Fog machines: only through DMX IN (dmx1).">
              {OUTPUTS.map(([v, l]) => <MenuItem key={v} value={v}>{choiceLabel(v, l, labels)}</MenuItem>)}
            </TextField>
            <TextField select label="And also turn on" value={also} onChange={(e) => setAlso(e.target.value)} helperText="For example a lamp and an air blaster together.">
              <MenuItem value="">Nothing else</MenuItem>
              {OUTPUTS.filter(([v]) => v !== output).map(([v, l]) => <MenuItem key={v} value={v}>{choiceLabel(v, l, labels)}</MenuItem>)}
            </TextField>
            <TextField type="number" label="For how many seconds" value={seconds} inputProps={{ min: 0.1, step: 0.1 }} onChange={(e) => setSeconds(Number(e.target.value) || 1)} />
            <TextField select label="Play a sound too" value={sound} onChange={(e) => setSound(e.target.value)} helperText="Sound 1 is the one file in the card's folder 01 (Studio's SD card tool puts your sounds there).">
              <MenuItem value="no">No</MenuItem>
              <MenuItem value="yes">Yes, sound 1</MenuItem>
            </TextField>
            {boardName && replacing && <Alert severity="info">This takes the place of the effect script on {boardName}{replacing === true ? '' : ` (“${replacing}”)`}. A copy of it stays in Your library.</Alert>}
            <Typography variant="body2" color="text.secondary">
              {boardName ? `It goes to ${boardName} straight away, so you can try it. ` : ''}You can change everything afterwards in Your library, as text or as blocks.
            </Typography>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="contained" size="large" disabled={!name.trim()}>{boardName ? `Make it and send it to ${boardName}` : 'Make it'}</Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}
