// Settings, Automation: "When a message arrives on … send a web request to …" rules (for clerical work such as
// logging check-ins to a spreadsheet), with counters and timers, and the connection to another MQTT server.
// The device layer checks, keeps and runs the rules (core/src/automation); this page edits them.
import { useEffect, useRef, useState } from 'react';
import {
  Alert, Box, Button, Checkbox, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, IconButton, Menu, MenuItem,
  Stack, Switch, TextField, Typography,
} from '@mui/material';
import DeleteIcon from '@mui/icons-material/DeleteOutline';
import { call } from '../api';
import { useStore } from '../store';
import { sectionSx } from './section';
import {
  BUILT_IN_VALUES, CONTENT_TYPES, DIRECTIONS, PAIRINGS, TIMER_VALUES, BridgePrefs, Pairing, Rule, RuleStatus, bridgePrefs, bridgeStatusText,
  canSendAgain, countsText, fromExample, logTime, newRule, paramSecretKey, parseFilters, patternNames, removeRule, ruleSummary, secretLabel, stateSummary, updateRule, upsertRule,
} from '../automation';

/** How often the page reads the rules' and the connection's status while it is open. */
const STATUS_EVERY_MS = 2000;
/** How long after the last change a rule being edited is checked. */
const CHECK_DELAY_MS = 300;

type Msg = { tone: 'success' | 'error' | 'info' | 'warning'; text: string } | null;
const errText = (e: any) => String(e?.message || e);

export default function AutomationSettings() {
  const { prefs } = useStore();
  const [rules, setRules] = useState<Rule[]>([]);
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [secrets, setSecrets] = useState<Record<string, boolean>>({});
  const [status, setStatus] = useState<Record<string, RuleStatus>>({});
  const [examples, setExamples] = useState<any[]>([]);
  const [editing, setEditing] = useState<Rule | null>(null);
  const [mq, setMq] = useState<any>(null);
  const [msg, setMsg] = useState<Msg>(null);
  const [exampleMenu, setExampleMenu] = useState<HTMLElement | null>(null);
  const [showLog, setShowLog] = useState<string | null>(null);
  const [moving, setMoving] = useState<'export' | 'import' | null>(null);

  const load = async () => {
    const r = await call('automation_get').catch(() => null);
    if (r) { setRules(r.rules || []); setProblems(r.errors || {}); setSecrets(r.secrets || {}); }
  };
  useEffect(() => {
    void load();
    void call('automation_examples').then(setExamples).catch(() => {});
    const poll = () => {
      void call('automation_status').then((s) => setStatus(s?.rules || {})).catch(() => {});
      void call('mqtt_status').then(setMq).catch(() => setMq(null));
    };
    poll();
    const t = setInterval(poll, STATUS_EVERY_MS);
    return () => clearInterval(t);
  }, []);

  const save = async (list: Rule[]) => {
    const before = rules;
    setRules(list);
    const r = await call('automation_set', { rules: list }).catch((e) => { setRules(before); throw e; });
    setProblems(r?.errors || {});
    const g = await call('automation_get').catch(() => null);
    if (g) setSecrets(g.secrets || {});
  };
  const saveSafely = async (list: Rule[], done?: string) => {
    try { await save(list); if (done) setMsg({ tone: 'success', text: done }); } catch (e) { setMsg({ tone: 'error', text: errText(e) }); }
  };

  return (
    <>
      <Box sx={sectionSx} data-testid="automation">
        <Typography variant="h6" component="h3">Automation: when a message arrives, send a web request</Typography>
        <Typography color="text.secondary" gutterBottom>
          For paperwork that should do itself: when a message arrives on a topic (for example a check-in room reporting “complete”), Studio sends a web request, such as a new row in a Google Sheet. Rules can also count people and time each group.
        </Typography>
        {!mq && <Alert severity="info" sx={{ mb: 1 }}>Rules listen to the boards that report to this computer: turn on “Boards report to this computer” (above) for them to run.</Alert>}
        {msg && <Alert severity={msg.tone} onClose={() => setMsg(null)} sx={{ mb: 1 }}>{msg.text}</Alert>}
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ mb: 2 }}>
          <Button variant="contained" onClick={() => setEditing(newRule())}>New rule</Button>
          <Button variant="outlined" onClick={(e) => setExampleMenu(e.currentTarget)} aria-haspopup="menu">New from example</Button>
          <Menu anchorEl={exampleMenu} open={!!exampleMenu} onClose={() => setExampleMenu(null)}>
            {examples.map((ex) => (
              <MenuItem key={ex.id} onClick={async () => {
                setExampleMenu(null);
                const added = fromExample(ex.rules);
                await saveSafely([...rules, ...added], `Added “${ex.title}” (${added.length} rules, switched off). Paste your web address into each one, then switch them on.`);
              }}>
                <Box><Typography>{ex.title}</Typography><Typography variant="body2" color="text.secondary" sx={{ whiteSpace: 'normal', maxWidth: 420 }}>{ex.description}</Typography></Box>
              </MenuItem>
            ))}
          </Menu>
          <Button onClick={() => setMoving('export')} disabled={rules.length === 0}>Export rules</Button>
          <Button onClick={() => setMoving('import')}>Import rules</Button>
        </Stack>
        {rules.length === 0 && <Typography color="text.secondary">No rules yet.</Typography>}
        <Stack spacing={1.5}>
          {rules.map((r) => {
            const st = status[r.id];
            const problem = problems[r.id] || st?.problem;
            const state = stateSummary(r, st);
            return (
              <Box key={r.id} data-testid={`rule-${r.name || r.id}`} sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 1.5 }}>
                <Stack direction="row" spacing={1} alignItems="center">
                  <Switch checked={r.enabled} onChange={(e) => void saveSafely(updateRule(rules, r.id, { enabled: e.target.checked }))} inputProps={{ 'aria-label': `${r.name || 'Rule'} on` }} />
                  <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                    <Typography sx={{ fontWeight: 600 }}>{r.name || 'Rule without a name'}</Typography>
                    <Typography variant="body2" sx={{ wordBreak: 'break-word' }}>{ruleSummary(r)}</Typography>
                  </Box>
                </Stack>
                {problem && <Alert severity="error" sx={{ mt: 1 }}>This rule does not run: {problem}</Alert>}
                <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }} role="status">{countsText(st)}{state ? `. ${state}.` : ''}</Typography>
                <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ mt: 1 }}>
                  <Button size="small" variant="outlined" onClick={() => setEditing(r)}>Edit and test</Button>
                  <Button size="small" onClick={() => setShowLog(showLog === r.id ? null : r.id)}>{showLog === r.id ? 'Hide activity' : 'Activity'}</Button>
                  {(r.count || r.timer) && <Button size="small" onClick={async () => {
                    try { await call('automation_reset', { id: r.id }); setMsg({ tone: 'success', text: `${r.name || 'The rule'}: counts and timers start again from zero.` }); } catch (e) { setMsg({ tone: 'error', text: errText(e) }); }
                  }}>Reset counts and timers</Button>}
                  <Button size="small" color="error" onClick={() => void saveSafely(removeRule(rules, r.id), `Deleted ${r.name || 'the rule'}.`)}>Delete</Button>
                </Stack>
                {showLog === r.id && (
                  <Box data-testid="rule-log" sx={{ mt: 1 }}>
                    {(st?.log || []).length === 0 ? <Typography variant="body2" color="text.secondary">Nothing sent yet.</Typography>
                      : [...(st?.log || [])].reverse().map((l, i) => (
                        <Stack key={i} direction="row" spacing={1} alignItems="center">
                          <Typography variant="body2" color={l.ok ? 'text.primary' : 'error'} sx={{ fontFamily: 'monospace' }}>{logTime(l.at)}  {l.text}</Typography>
                          {canSendAgain(l) && <Button size="small" onClick={async () => {
                            try { await call('automation_resend', { seq: l.resend }); setMsg({ tone: 'info', text: 'Sending it again (with the same event id).' }); } catch (e) { setMsg({ tone: 'error', text: errText(e) }); }
                          }}>Send again</Button>}
                        </Stack>
                      ))}
                  </Box>
                )}
              </Box>
            );
          })}
        </Stack>
        {editing && (
          <RuleEditor rule={editing} secrets={secrets} onClose={() => setEditing(null)} onSave={async (rule, newSecrets, paramValue) => {
            await save(upsertRule(rules, rule));
            for (const [header, value] of Object.entries(newSecrets)) await call('automation_secret_set', { rule: rule.id, header, value });
            if (rule.secret_param && paramValue) await call('automation_secret_set', { rule: rule.id, param: rule.secret_param, value: paramValue });
            const g = await call('automation_get').catch(() => null);
            if (g) setSecrets(g.secrets || {});
            setEditing(null);
            setMsg({ tone: 'success', text: `Saved ${rule.name || 'the rule'}.` });
          }} />
        )}
        {moving && <MoveRules mode={moving} onClose={() => setMoving(null)} onImported={async (n) => { await load(); setMoving(null); setMsg({ tone: 'success', text: `Imported ${n} rule${n === 1 ? '' : 's'}. Secret header values are never exported: set them again in each rule.` }); }} />}
      </Box>
      {mq && <BridgeSettings mq={mq} advanced={!!prefs.advanced} />}
    </>
  );
}

/** Export (to copy) or import (pasted) rules as text. Secret values are never in it. */
function MoveRules({ mode, onClose, onImported }: { mode: 'export' | 'import'; onClose: () => void; onImported: (n: number) => void }) {
  const [text, setText] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => { if (mode === 'export') void call('automation_export').then((v) => setText(JSON.stringify(v, null, 2))); }, [mode]);
  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="md">
      <DialogTitle>{mode === 'export' ? 'Export rules' : 'Import rules'}</DialogTitle>
      <DialogContent>
        <Typography color="text.secondary" gutterBottom>
          {mode === 'export' ? 'Copy this text and keep it, or paste it into Import on another computer. Secret header values are left out.' : 'Paste rules exported from Studio. They are added to the rules you have.'}
        </Typography>
        <TextField multiline minRows={10} maxRows={24} fullWidth value={text} onChange={(e) => setText(e.target.value)} inputProps={{ readOnly: mode === 'export', 'aria-label': 'Rules as text', spellCheck: false, style: { fontFamily: 'monospace' } }} />
        {err && <Alert severity="error" sx={{ mt: 1 }}>{err}</Alert>}
      </DialogContent>
      <DialogActions>
        {mode === 'export' ? <Button onClick={() => void navigator.clipboard?.writeText(text)}>Copy</Button>
          : <Button variant="contained" disabled={!text.trim()} onClick={async () => {
            try { const before = (await call('automation_get')).rules.length; const r = await call('automation_import', { text }); onImported(r.rules.length - before); } catch (e) { setErr(errText(e)); }
          }}>Import</Button>}
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}

/** Edit one rule, check it as it is typed, and try it with a sample message. */
function RuleEditor({ rule, secrets, onClose, onSave }: { rule: Rule; secrets: Record<string, boolean>; onClose: () => void; onSave: (r: Rule, newSecrets: Record<string, string>, paramValue: string) => Promise<void> }) {
  const [r, setR] = useState<Rule>(rule);
  const [check, setCheck] = useState<{ ok: boolean; text: string; warnings: string[] }>({ ok: true, text: '', warnings: [] });
  const [newSecrets, setNewSecrets] = useState<Record<string, string>>({});
  const [changing, setChanging] = useState<Record<number, boolean>>({});
  const [paramValue, setParamValue] = useState('');
  const [changingParam, setChangingParam] = useState(false);
  const paramSaved = !!rule.secret_param && rule.secret_param === (r.secret_param || '');
  const [sample, setSample] = useState({ topic: rule.pattern.replace(/\{(\w+)\}/g, (_m, n) => (n === 'roomName' ? 'library' : n)).replace(/\*/g, 'desk').replace(/\/?(#|\*\*)$/, '/x').replace(/^\//, ''), payload: '{"people": 4}' });
  const [test, setTest] = useState<any>(null);
  const [saveErr, setSaveErr] = useState('');
  const names = patternNames(r.pattern);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void call('automation_check', { rule: r })
        .then((c) => setCheck({ ok: true, text: `Listens on ${c.filter}${c.names.length ? `; keeps ${c.names.map((n: string) => `{${n}}`).join(', ')}` : ''}.`, warnings: c.warnings || [] }))
        .catch((e) => setCheck({ ok: false, text: errText(e), warnings: [] }));
    }, CHECK_DELAY_MS);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [r]);
  const set = (p: Partial<Rule>) => setR((o) => ({ ...o, ...p }));
  const setHeader = (i: number, p: any) => set({ headers: r.headers.map((h, j) => (j === i ? { ...h, ...p } : h)) });
  const runTest = async (send: boolean) => {
    try { setTest(await call('automation_test', { rule: r, topic: sample.topic, payload: sample.payload, send })); } catch (e) { setTest({ error: errText(e) }); }
  };
  const values = [...names.map((n) => `{${n}}`), ...BUILT_IN_VALUES, ...(r.timer ? TIMER_VALUES : []), ...(r.count ? [`{count.${r.count.name || 'name'}}`, ...names.map((n) => `{count.${r.count!.name || 'name'}[${n}]}`)] : [])];

  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="md" aria-labelledby="rule-editor-title">
      <DialogTitle id="rule-editor-title">{rule.name ? `Edit “${rule.name}”` : 'New rule'}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <TextField label="Name" value={r.name} onChange={(e) => set({ name: e.target.value })} placeholder="Check-in complete" />
          <TextField label="When a message arrives on" value={r.pattern} onChange={(e) => set({ pattern: e.target.value })}
            helperText="Topic levels are split by /. * is any one level, {roomName} is any one level kept as roomName, # at the end is everything below." inputProps={{ spellCheck: false }} />
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
            <TextField select label="Send a" value={r.method} onChange={(e) => set({ method: e.target.value as Rule['method'] })} sx={{ minWidth: 130 }}>
              {['POST', 'GET', 'PUT'].map((m) => <MenuItem key={m} value={m}>{m}</MenuItem>)}
            </TextField>
            <TextField label="Web request to (address)" value={r.url} onChange={(e) => set({ url: e.target.value })} fullWidth placeholder="https://script.google.com/macros/s/…/exec" inputProps={{ spellCheck: false }} />
          </Stack>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'flex-start' }}>
            <TextField size="small" label="Secret part of the address (optional)" value={r.secret_param || ''} placeholder="key" onChange={(e) => set({ secret_param: e.target.value.trim() })} sx={{ minWidth: 260 }} inputProps={{ spellCheck: false }}
              helperText="A name such as key: ?key=… is added when sending" />
            {r.secret_param && (paramSaved && !changingParam ? (
              <Stack direction="row" spacing={1} alignItems="center" sx={{ minHeight: 40 }}>
                <Typography data-testid="param-secret">Value: {secretLabel(secrets[paramSecretKey(r.id, r.secret_param)])}</Typography>
                <Button size="small" onClick={() => setChangingParam(true)}>Change</Button>
              </Stack>
            ) : (
              <TextField size="small" type="password" label={`Value of ${r.secret_param}`} autoComplete="new-password" value={paramValue} onChange={(e) => setParamValue(e.target.value)} sx={{ flexGrow: 1 }} helperText="Kept in the system keychain, never shown again" />
            ))}
          </Stack>
          {r.method !== 'GET' && <>
            <TextField select label="Body" value={r.content_type} onChange={(e) => set({ content_type: e.target.value as Rule['content_type'] })}>
              {CONTENT_TYPES.map((c) => <MenuItem key={c.id} value={c.id}>{c.label}</MenuItem>)}
            </TextField>
            <TextField label="What to send" value={r.body} onChange={(e) => set({ body: e.target.value })} multiline minRows={2} inputProps={{ spellCheck: false, style: { fontFamily: 'monospace' } }}
              helperText={`Values: ${values.join(' ')}. Each is escaped for the body type (quotes for a spreadsheet line, JSON or form encoding).`} />
          </>}

          <Box>
            <Typography variant="subtitle2">Headers (optional)</Typography>
            {r.headers.map((h, i) => (
              <Stack key={i} direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'center' }} sx={{ mt: 1 }}>
                <TextField size="small" label="Header" value={h.name} onChange={(e) => setHeader(i, { name: e.target.value })} sx={{ minWidth: 160 }} />
                {h.secret ? (
                  changing[i] || !rule.headers.some((o) => o.secret && o.name.toLowerCase() === h.name.toLowerCase()) ? (
                    <TextField size="small" type="password" label="Secret value" autoComplete="new-password" value={newSecrets[h.name] || ''} onChange={(e) => setNewSecrets({ ...newSecrets, [h.name]: e.target.value })} sx={{ flexGrow: 1 }} helperText="Kept in the system keychain, never shown again" />
                  ) : (
                    <Stack direction="row" spacing={1} alignItems="center" sx={{ flexGrow: 1 }}>
                      <Typography>Value: {secretLabel(secrets[`${r.id}:${h.name.toLowerCase()}`])}</Typography>
                      <Button size="small" onClick={() => setChanging({ ...changing, [i]: true })}>Change</Button>
                    </Stack>
                  )
                ) : (
                  <TextField size="small" label="Value" value={h.value} onChange={(e) => setHeader(i, { value: e.target.value })} sx={{ flexGrow: 1 }} />
                )}
                <FormControlLabel control={<Checkbox checked={h.secret} onChange={(e) => setHeader(i, { secret: e.target.checked, value: '' })} />} label="Secret" />
                <IconButton aria-label={`Remove header ${h.name}`} onClick={() => set({ headers: r.headers.filter((_, j) => j !== i) })}><DeleteIcon /></IconButton>
              </Stack>
            ))}
            <Button size="small" sx={{ mt: 1 }} onClick={() => set({ headers: [...r.headers, { name: '', value: '', secret: false }] })}>Add a header</Button>
          </Box>

          <Box>
            <FormControlLabel control={<Switch checked={!!r.count} onChange={(e) => set({ count: e.target.checked ? { direction: 'up', name: 'inside', by: '', per: names[0] || '' } : undefined })} />} label="Count (for example people inside)" />
            {r.count && (
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
                <TextField select size="small" label="Count" value={r.count.direction} onChange={(e) => set({ count: { ...r.count!, direction: e.target.value as 'up' | 'down' } })} sx={{ minWidth: 120 }}>
                  <MenuItem value="up">up</MenuItem><MenuItem value="down">down</MenuItem>
                </TextField>
                <TextField size="small" label="Counter name" value={r.count.name} onChange={(e) => set({ count: { ...r.count!, name: e.target.value } })} />
                <TextField size="small" label="By (empty is 1)" value={r.count.by} placeholder="{payload.people}" onChange={(e) => set({ count: { ...r.count!, by: e.target.value } })} />
                <TextField select size="small" label="For each" value={r.count.per} onChange={(e) => set({ count: { ...r.count!, per: e.target.value } })} sx={{ minWidth: 150 }}>
                  <MenuItem value="">one count for all</MenuItem>
                  {names.map((n) => <MenuItem key={n} value={n}>{n}</MenuItem>)}
                </TextField>
              </Stack>
            )}
          </Box>
          <Box>
            <FormControlLabel control={<Switch checked={!!r.timer} onChange={(e) => set({ timer: e.target.checked ? { role: 'start', name: 'visit', per: names[0] || '', pairing: 'latest' } : undefined })} />} label="Time each group" />
            {r.timer && (
              <Stack spacing={1}>
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
                  <TextField select size="small" label="This message" value={r.timer.role} onChange={(e) => set({ timer: { ...r.timer!, role: e.target.value as 'start' | 'complete' } })} sx={{ minWidth: 180 }}>
                    <MenuItem value="start">starts a group</MenuItem><MenuItem value="complete">finishes a group</MenuItem>
                  </TextField>
                  <TextField size="small" label="Timer name" value={r.timer.name} onChange={(e) => set({ timer: { ...r.timer!, name: e.target.value } })} helperText="The same name in the start rule and the finish rule" />
                  <TextField select size="small" label="For each" value={r.timer.per} onChange={(e) => set({ timer: { ...r.timer!, per: e.target.value } })} sx={{ minWidth: 150 }}>
                    <MenuItem value="">one timer for all</MenuItem>
                    {names.map((n) => <MenuItem key={n} value={n}>{n}</MenuItem>)}
                  </TextField>
                </Stack>
                {r.timer.role === 'complete' && (
                  <TextField select size="small" label="A finish belongs to" value={r.timer.pairing} onChange={(e) => set({ timer: { ...r.timer!, pairing: e.target.value as Pairing } })}>
                    {PAIRINGS.map((p) => <MenuItem key={p.id} value={p.id}>{p.label}</MenuItem>)}
                  </TextField>
                )}
              </Stack>
            )}
          </Box>

          <Alert severity={check.ok ? 'success' : 'error'} role="status" data-testid="rule-check">{check.text || 'Checking…'}</Alert>
          {check.warnings.map((w) => <Alert key={w} severity="warning">{w}</Alert>)}

          <Box sx={{ borderTop: 1, borderColor: 'divider', pt: 2 }}>
            <Typography variant="subtitle1" component="h4" gutterBottom>Test this rule</Typography>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
              <TextField size="small" label="Sample topic" value={sample.topic} onChange={(e) => setSample({ ...sample, topic: e.target.value })} fullWidth inputProps={{ spellCheck: false }} />
              <TextField size="small" label="Sample message" value={sample.payload} onChange={(e) => setSample({ ...sample, payload: e.target.value })} fullWidth inputProps={{ spellCheck: false }} />
            </Stack>
            <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
              <Button variant="outlined" disabled={!check.ok} onClick={() => void runTest(false)}>Test</Button>
              <Button disabled={!check.ok} onClick={() => void runTest(true)}>Send it once</Button>
            </Stack>
            {test && <TestResult t={test} />}
          </Box>
          {saveErr && <Alert severity="error">{saveErr}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" disabled={!check.ok} onClick={async () => {
          try { await onSave(r, Object.fromEntries(Object.entries(newSecrets).filter(([k, v]) => v && r.headers.some((h) => h.secret && h.name === k))), paramValue); } catch (e) { setSaveErr(errText(e)); }
        }}>Save</Button>
      </DialogActions>
    </Dialog>
  );
}

function TestResult({ t }: { t: any }) {
  if (t.error) return <Alert severity="error" sx={{ mt: 1 }}>{t.error}</Alert>;
  if (!t.matched) return <Alert severity="info" sx={{ mt: 1 }} data-testid="rule-test">This topic does not match the rule (it listens on {t.filter}).</Alert>;
  const q = t.request;
  const vars = Object.entries(t.variables || {});
  return (
    <Box sx={{ mt: 1 }} data-testid="rule-test">
      <Typography variant="body2">{vars.length ? `Matched: ${vars.map(([k, v]) => `${k} = ${v}`).join(', ')}` : 'Matched.'}</Typography>
      <Box component="pre" sx={{ p: 1, mt: 1, bgcolor: 'action.hover', borderRadius: 1, whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: 13 }}>
        {`${q.method} ${q.url}\n${q.headers.map((h: any) => `${h.name}: ${h.value}`).join('\n')}${q.body != null ? `\n\n${q.body}` : ''}`}
      </Box>
      {(t.notes || []).map((n: string) => <Alert key={n} severity="warning" sx={{ mt: 1 }}>{n}</Alert>)}
      {t.result && <Alert severity={t.result.ok ? 'success' : 'error'} sx={{ mt: 1 }}>{t.result.ok ? `Sent: ${t.result.text}` : `Not sent: ${t.result.text}`}</Alert>}
    </Box>
  );
}

/** Connect to another MQTT server: out, in or both ways, with topic filters. The password is set-only. */
function BridgeSettings({ mq, advanced }: { mq: any; advanced: boolean }) {
  const { prefs, setPrefs } = useStore();
  const [b, setB] = useState<BridgePrefs>(bridgePrefs((prefs as any).bridge));
  const [filters, setFilters] = useState(b.filters.join(', '));
  const [pass, setPass] = useState('');
  const [passSet, setPassSet] = useState<boolean | undefined>(undefined);
  const [changingPass, setChangingPass] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const readPass = () => call('automation_secret_status').then((s) => setPassSet(!!s?.bridge)).catch(() => {});
  useEffect(() => { void readPass(); }, []);
  const apply = async (on: boolean) => {
    const next = { ...b, on, filters: parseFilters(filters) };
    if (pass) {
      const ok = await call('secret_set', { name: 'bridge-password', value: pass }).then(() => true).catch((e) => { setMsg({ tone: 'error', text: `The system keychain did not keep the password (${errText(e)}): the connection is not started.` }); return false; });
      if (!ok) return;
      setPass(''); setChangingPass(false); void readPass();
    }
    try {
      if (on) await call('bridge_start', { ...next, secret: 'bridge-password' }); else await call('bridge_stop');
      setB(next);
      setPrefs({ bridge: next } as any);
      setMsg(null);
    } catch (e) { setMsg({ tone: 'error', text: errText(e) }); }
  };
  return (
    <Box sx={sectionSx} data-testid="bridge">
      <Typography variant="h6" component="h3">{advanced ? 'Connect to another MQTT server' : 'Connect to another server'}</Typography>
      <Typography color="text.secondary" gutterBottom>Passes messages on to another server (for example your company's), takes its messages in, or both. Studio keeps the latest of each board's reports while that server cannot be reached, and never sends a message back where it came from.</Typography>
      {msg && <Alert severity={msg.tone} onClose={() => setMsg(null)} sx={{ mb: 1 }}>{msg.text}</Alert>}
      <Stack spacing={1.5} sx={{ maxWidth: 560 }}>
        <Stack direction="row" spacing={1}>
          <TextField label="Server address" value={b.host} onChange={(e) => setB({ ...b, host: e.target.value })} sx={{ flexGrow: 1 }} />
          <TextField label="Port" type="number" value={b.port} onChange={(e) => setB({ ...b, port: Number(e.target.value) })} sx={{ width: 110 }} />
        </Stack>
        <FormControlLabel control={<Switch checked={b.tls} onChange={(e) => setB({ ...b, tls: e.target.checked })} />} label="Encrypted connection (TLS)" />
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'flex-start' }}>
          <TextField label="User name (optional)" value={b.username} onChange={(e) => setB({ ...b, username: e.target.value })} sx={{ flexGrow: 1 }} />
          {passSet && !changingPass ? (
            <Stack direction="row" spacing={1} alignItems="center" sx={{ flexGrow: 1, minHeight: 56 }}>
              <Typography data-testid="bridge-password">Password: {secretLabel(true)}</Typography>
              <Button size="small" onClick={() => setChangingPass(true)}>Change</Button>
            </Stack>
          ) : (
            <TextField label="Password (optional)" type="password" autoComplete="new-password" value={pass} onChange={(e) => setPass(e.target.value)} helperText={`Kept in the system keychain, never shown again (${secretLabel(passSet)})`} sx={{ flexGrow: 1 }} />
          )}
        </Stack>
        <TextField select label="Direction" value={b.direction} onChange={(e) => setB({ ...b, direction: e.target.value as BridgePrefs['direction'] })}>
          {DIRECTIONS.map((d) => <MenuItem key={d.id} value={d.id}>{d.label}</MenuItem>)}
        </TextField>
        <TextField label="Topics" value={filters} onChange={(e) => setFilters(e.target.value)} helperText="Which topics to pass, separated by commas: # is everything, + is any one level (for example checkin/#)." inputProps={{ spellCheck: false }} />
        <TextField label="Put in front of every topic on that server (optional)" placeholder="site-a/" value={b.prefix} onChange={(e) => setB({ ...b, prefix: e.target.value })} />
        <FormControlLabel control={<Switch checked={b.accept_commands} onChange={(e) => setB({ ...b, accept_commands: e.target.checked })} />} label="Let that server send requests to the boards (off is safer; locked boards still need their password)" />
        <Stack direction="row" spacing={1}>
          <Button variant="contained" disabled={!b.host} onClick={() => void apply(true)}>{b.on ? 'Save and reconnect' : 'Connect'}</Button>
          {b.on && <Button onClick={() => void apply(false)}>Disconnect</Button>}
        </Stack>
        {b.on && <Typography role="status" data-testid="bridge-status">{bridgeStatusText(mq.bridge)}</Typography>}
      </Stack>
    </Box>
  );
}
