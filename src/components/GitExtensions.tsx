// Settings › Extensions from git: one field (owner/repo, gitlab:…, bitbucket:… or any git address), the added
// ones with where they came from, their commit, Get latest and Remove, and "Check all for updates" (which only
// tells). The consent screen (PluginConsent.tsx) still runs before anything of an extension loads, and again when
// an update's plugin.json asks for more. The work is in the core (core/src/extensions.rs).
import { useEffect, useState } from 'react';
import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, Radio, RadioGroup, Stack, TextField, Typography } from '@mui/material';
import { call } from '../api';
import { useStore } from '../store';
import { useBoardActions } from './actions';
import { sectionSx } from './section';
import { pluginsChanged } from '../pluginsChanged';
import { ExtensionLogo } from '../props/icons';
import { folderIn } from './ScriptsRepo';

type Ext = { folder: string; path: string; source: string; url?: string; sub?: string; dir: string; id?: string; name?: string; commit?: string; problem?: any };
type Msg = { tone: 'success' | 'info' | 'error'; text: string; folder?: string };

export default function GitExtensions() {
  const { prefs, setPrefs } = useStore();
  const act = useBoardActions();
  const [list, setList] = useState<Ext[] | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState<Msg | null>(null);
  const [behind, setBehind] = useState<Record<string, number>>({});
  const [choose, setChoose] = useState<{ choices: string[]; value: string } | null>(null);
  const read = () => call('extensions').then(setList).catch(() => setList(null));
  useEffect(() => { void read(); }, []);
  const fail = (e: any) => { const t = String(e?.message || e); setMsg({ tone: 'error', text: t, folder: folderIn(t) }); };

  const add = async (sub?: string) => {
    const src = text.trim();
    if (!src) return;
    try {
      if (!sub) {
        const pv = await call('extension_preview', { source: src });
        if (!(await act.confirm('Add this extension?', `Studio copies ${pv.url} (using the sign-in saved on this computer) into ${pv.path}. Before anything of it runs, Studio shows what it asks to do and waits for your yes.`, 'Add'))) return;
      }
      setBusy('add');
      const r = await call('extension_add', { source: src, ...(sub !== undefined ? { sub } : {}) });
      if (r.choose) { setChoose({ choices: r.choose, value: r.choose[0] }); return; }
      setText('');
      setMsg({ tone: 'success', text: `Added “${r.added.name || r.added.id}”. It is in the side bar; open it to allow it.` });
      await read();
      pluginsChanged();
    } catch (e) { fail(e); } finally { setBusy(''); }
  };
  const getLatest = async (x: Ext) => {
    setBusy(x.folder);
    try {
      const a = await call('extension_get_latest', { folder: x.folder });
      setMsg(a.ok ? { tone: 'success', text: `${x.name || x.folder}: ${a.message}` } : { tone: 'error', text: a.message, folder: folderIn(a.message) });
      setBehind((b) => ({ ...b, [x.folder]: 0 }));
      await read();
      // read the extension again before its page or adapter loads: a plugin.json that asks for more asks again
      pluginsChanged();
    } catch (e) { fail(e); } finally { setBusy(''); }
  };
  const checkAll = async () => {
    setBusy('check');
    const found: Record<string, number> = {};
    let problem = '';
    for (const x of list || []) {
      const r = await call('extension_check', { folder: x.folder }).catch((e: any) => ({ ok: false, message: String(e.message || e) }));
      if (r.ok) found[x.folder] = r.behind; else if (!problem) problem = r.message;
    }
    setBehind(found);
    const n = Object.values(found).filter((v) => v > 0).length;
    setMsg(problem ? { tone: 'error', text: problem, folder: folderIn(problem) } : { tone: 'info', text: n ? `${n} extension${n === 1 ? ' has' : 's have'} an update. Press Get latest on ${n === 1 ? 'it' : 'each'} to bring it in.` : 'Every extension is up to date.' });
    setBusy('');
  };
  const remove = async (x: Ext) => {
    if (!(await act.confirm(`Remove “${x.name || x.folder}”?`, `This deletes Studio's copy of it (${x.path}). Nothing else is touched; the repository itself stays where it is, and you can add it again.`, 'Remove'))) return;
    try {
      await call('extension_remove', { folder: x.folder });
      // a different repository in the same folder later must ask for consent again
      if (x.id && prefs.pluginConsent?.[x.id] !== undefined) { const c = { ...prefs.pluginConsent }; delete c[x.id]; setPrefs({ pluginConsent: c }); }
      await read();
      pluginsChanged();
    } catch (e) { fail(e); }
  };

  if (list === null) return null; // the browser bridge without an extensions folder
  return (
    <Box sx={sectionSx} data-testid="git-extensions">
      <Typography variant="h6" component="h3">Add extensions</Typography>
      <Typography color="text.secondary" gutterBottom>
        Add an extension straight from where it is published: owner/repo for GitHub, gitlab:group/repo, bitbucket:owner/repo, or its full address. Private ones work with the sign-in already saved on this computer.
      </Typography>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
        <TextField fullWidth label="Extension repository" placeholder="owner/repo" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void add(); }} />
        <Button variant="contained" disabled={!text.trim() || !!busy} onClick={() => void add()} sx={{ flexShrink: 0 }}>{busy === 'add' ? 'Adding…' : 'Add'}</Button>
      </Stack>
      {list.map((x) => (
        <Box key={x.folder} data-testid={`extension-${x.folder}`} sx={{ py: 1, mt: 1, borderTop: 1, borderColor: 'divider' }}>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'center' }}>
            {x.id && <ExtensionLogo id={x.id} size={32} label={`${x.name || x.id} icon`} />}
            <Box sx={{ flexGrow: 1, minWidth: 0 }}>
              <Typography sx={{ fontWeight: 600 }}>{x.name || x.id || x.folder}</Typography>
              <Typography variant="body2" color="text.secondary" sx={{ wordBreak: 'break-all' }}>
                From {x.source}{x.sub ? ` (folder ${x.sub})` : ''} · {x.commit ? `at ${x.commit}` : 'no commit'}{behind[x.folder] ? ` · update available (${behind[x.folder]} new)` : ''}
              </Typography>
            </Box>
            <Button variant="outlined" disabled={!!busy} onClick={() => void getLatest(x)}>{busy === x.folder ? 'Getting…' : 'Get latest'}</Button>
            <Button color="error" disabled={!!busy} onClick={() => void remove(x)}>Remove…</Button>
          </Stack>
        </Box>
      ))}
      {list.length > 0 && <Button sx={{ mt: 1 }} disabled={!!busy} onClick={() => void checkAll()}>{busy === 'check' ? 'Checking…' : 'Check all for updates'}</Button>}
      {msg && (
        <Alert severity={msg.tone} sx={{ mt: 1 }} onClose={() => setMsg(null)} data-testid="extensions-message"
          action={msg.folder ? <Button color="inherit" size="small" onClick={() => void call('open_folder', { folder: msg.folder }).catch(() => {})}>Open folder</Button> : undefined}>{msg.text}</Alert>
      )}
      {choose && (
        <Dialog open onClose={() => setChoose(null)} fullWidth maxWidth="sm" aria-labelledby="ext-choose">
          <DialogTitle id="ext-choose">This repository has several extensions. Which one?</DialogTitle>
          <DialogContent>
            <RadioGroup aria-labelledby="ext-choose" value={choose.value} onChange={(e) => setChoose({ ...choose, value: e.target.value })}>
              {choose.choices.map((c) => <FormControlLabel key={c} value={c} control={<Radio />} label={c || '(the top folder)'} />)}
            </RadioGroup>
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setChoose(null)}>Cancel</Button>
            <Button variant="contained" onClick={() => { const v = choose.value; setChoose(null); void add(v); }}>Add this one</Button>
          </DialogActions>
        </Dialog>
      )}
    </Box>
  );
}
