// First start: pick (or make) the workspace folder, then find boards.
import { useEffect, useState } from 'react';
import { Alert, Button, Dialog, DialogActions, DialogContent, DialogTitle, Stack, Step, StepLabel, Stepper, Typography } from '@mui/material';
import { call, pickFolder } from '../api';
import { useStore } from '../store';
import AddBoard from './AddBoard';
import { useNav } from '../nav';

export default function FirstRun() {
  const { prefs, setPrefs, boards } = useStore();
  const nav = useNav();
  const [step, setStep] = useState(0);
  const [folder, setFolder] = useState(prefs.workspace);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!folder) call('library_default').then((d) => setFolder((f) => f || d)).catch(() => {});
  }, [folder]);

  const useFolder = async () => {
    try {
      const ws = await call('workspace_init', { folder });
      const backups = prefs.backups || (await call('default_folder'));
      setPrefs({ workspace: ws, backups });
      setStep(1);
    } catch (e: any) {
      setError(String(e.message || e));
    }
  };

  return (
    <Dialog open fullWidth maxWidth="md" aria-labelledby="first-run-title">
      <DialogTitle id="first-run-title">Welcome to Specter Studio</DialogTitle>
      <DialogContent>
        <Stepper activeStep={step} sx={{ mb: 3 }}>
          <Step><StepLabel>Your library folder</StepLabel></Step>
          <Step><StepLabel>Your boards</StepLabel></Step>
        </Stepper>
        {step === 0 && (
          <Stack spacing={2}>
            <Typography>
              Studio keeps everything you make (your effects) as ordinary files in one folder on this computer.
              You can copy it to a USB stick or put it in a Dropbox, Google Drive or OneDrive folder to share it between computers.
            </Typography>
            <Typography>Not sure? Press <b>Use this folder</b>. It is the right choice for almost everyone, and you can change it later in Settings.</Typography>
            <Typography sx={{ fontWeight: 600, wordBreak: 'break-all' }} data-testid="workspace-folder">{folder}</Typography>
            {error && <Alert severity="error">{error}</Alert>}
            <Stack direction="row" spacing={1}>
              <Button variant="contained" onClick={useFolder} disabled={!folder}>Use this folder</Button>
              <Button variant="outlined" onClick={async () => { const f = await pickFolder('Choose your library folder', folder); if (f) setFolder(f); }}>Choose another folder…</Button>
            </Stack>
          </Stack>
        )}
        {step === 1 && (
          <Stack spacing={2}>
            <Typography>Find your boards. You can add more at any time on the Boards page.</Typography>
            <Typography>No board with you? Add a practice board: it works like a real one, so you can try everything first.</Typography>
            <AddBoard />
            {Object.keys(boards).length > 0 && <Typography>Added: {Object.values(boards).map((b) => b.info?.name).join(', ')}</Typography>}
            <Typography color="text.secondary">Next: your boards are listed on the left of the Boards page. Pick one to try its inputs and outputs and to make it do something.</Typography>
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        {step === 1 && <Button variant="contained" onClick={() => {
          setPrefs({ firstRunDone: true });
          nav.go({ view: 'boards' }); // straight into the boards, whatever was open behind the welcome
        }}>Done</Button>}
      </DialogActions>
    </Dialog>
  );
}
