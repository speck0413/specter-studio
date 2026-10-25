// A plugin's page in a sandboxed frame. It reaches boards only through this narrow message API:
//   plugin -> Studio: {id, method: 'boards'}                      -> the connected boards (key, name, info, state, online)
//                     {id, method: 'rpc', key, req}               -> the board's answer (reading; acting only with plugin.json "control": pluginPerms.ts)
//                     {method: 'subscribe'}                        -> from then on board events (board, online) are forwarded
//                     {id, method: 'update_firmware', key}         -> Studio asks the person, then updates that one board
//                     {id, method: 'send_script', key, text, sounds?} -> Studio asks the person, then sends it (page lock respected)
//                     {id, method: 'mqtt_subscribe', filter} / {id, method: 'mqtt_publish', topic, payload}  within plugin.json "mqtt"
//                       (src/components/pluginPerms.ts); messages arrive as {event: {type: 'mqtt', topic, payload, retained}}
//   Studio -> plugin: {id, result} | {id, error} | {event} (also {event: {kind: 'boards_changed'}} when boards are added
//                     or removed, and {event: {kind: 'board_info', key, info}} when a board's info changes)
import { useEffect, useRef, useState } from 'react';
import { Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Typography } from '@mui/material';
import { call, onEvent, pluginUrl, rpc } from '../api';
import { useStore } from '../store';
import { useBoardActions } from '../components/actions';
import PluginConsent, { useConsent } from '../components/PluginConsent';
import { aliasTargets, canPublish, canSubscribe, isAction, perms, READ_OPS, refusal, topicMatches } from '../components/pluginPerms';
import { saveNewEffect } from '../library';

// what a plugin may ask a board (pluginPerms.ts refusal): reading always; making boards act only with "control",
// and never passwords, Wi-Fi, the name, the page lock, safety limits, restarts, resets, backups, scripts or firmware
// events a subscribed plugin gets: boards only (never serial monitor lines, build logs, MQTT or fleet data)
const FORWARDED = new Set(['board', 'online']);
// after the person says no, the plugin cannot ask again for a while (no asking over and over)
const ASK_AGAIN_MS = 30_000;

type Ask = { title: string; text: string; script?: string; yes: string; resolve: (v: boolean) => void };

export default function Plugins({ plugin }: { plugin: any }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const { boards, change, logActivity, prefs, bumpLibrary } = useStore();
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const bumpRef = useRef(bumpLibrary);
  bumpRef.current = bumpLibrary;
  const act = useBoardActions();
  const actRef = useRef({ act, change, log: logActivity });
  actRef.current = { act, change, log: logActivity };
  const boardsRef = useRef(boards);
  boardsRef.current = boards;
  const subscribed = useRef(false);
  const [consented, setConsented] = useConsent(plugin || {});
  const [ask, setAsk] = useState<Ask | null>(null);
  const askRef = useRef<(a: Omit<Ask, 'resolve'>) => Promise<boolean>>(async () => false);
  askRef.current = (a) => new Promise((resolve) => setAsk({ ...a, resolve: (v) => { setAsk(null); resolve(v); } }));

  useEffect(() => {
    if (!consented) return;
    subscribed.current = false;
    const pp = perms(plugin);
    const mqttSubs = new Set<string>();
    const lit = new Map<string, Set<string>>(); // outputs this plugin turned on: let go when its page closes
    let asking = false;
    let refusedUntil = 0;
    const who = `${plugin?.name || plugin?.id} (${plugin?.id})`;
    const post = (m: any) => frame.current?.contentWindow?.postMessage(m, '*');
    const onMsg = async (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow) return;
      const m = e.data || {};
      try {
        if (m.method === 'boards') {
          post({ id: m.id, result: Object.values(boardsRef.current).map((b) => ({ key: b.key, name: b.info?.name, info: b.info, state: b.state, online: b.online })) });
        } else if (m.method === 'rpc') {
          const b = boardsRef.current[m.key];
          if (!b) throw new Error('no such board');
          let keys: string[] | undefined;
          let aliasOf: Record<string, string> | undefined;
          if (m.req?.op === 'set_params') {
            // read each time: a profile loaded since (on the board's page, by Studio) changes the names
            const g = await rpc(m.key, { op: 'get_params' });
            keys = (g.result?.params || []).map((x: any) => String(x.key));
            const pr = await rpc(m.key, { op: 'get_profile' }).catch(() => null);
            aliasOf = aliasTargets(pr?.result);
          }
          const no = refusal(m.req, pp, keys, aliasOf);
          if (no) throw new Error(no);
          // an action the board wants confirmed (info.actions[].confirm) is asked in Studio's dialog, as from its button
          const ba = m.req?.op === 'action' ? (b.info?.actions || []).find((x: any) => x.key === m.req.key) : null;
          if (ba?.confirm && m.req.down !== false) {
            if (asking) throw new Error('Studio is already asking the person about this plugin');
            if (Date.now() < refusedUntil) throw new Error('the person said no; ask again later');
            asking = true;
            let yes = false;
            try { yes = await askRef.current({ title: `${who} wants to run “${ba.label}” on ${b.info?.name || m.key}`, text: `The board asks before “${ba.label}” runs. Only allow this if you trust this plugin.`, yes: ba.label }); } finally { asking = false; }
            if (!yes) { refusedUntil = Date.now() + ASK_AGAIN_MS; throw new Error('the person said no'); }
          }
          const req = { ...m.req };
          delete req.pin; // a plugin never sends the page password; a locked board refuses it
          const r = await rpc(m.key, req);
          if (!READ_OPS.has(req.op)) {
            actRef.current.log(`${who} → ${b.info?.name || m.key}: ${req.op}${req.channel ? ' ' + req.channel : ''}${req.show !== undefined ? ' show ' + req.show : ''}${r.ok ? '' : ' (refused)'}`);
          }
          if (req.op === 'set_output' && r.ok) {
            const s = lit.get(m.key) || new Set<string>();
            if (req.level) s.add(String(req.channel)); else s.delete(String(req.channel));
            lit.set(m.key, s);
          }
          post({ id: m.id, result: r });
        } else if (m.method === 'update_firmware' || m.method === 'send_script') {
          // board-changing work a plugin may only ask for: Studio asks the person in its own dialog (the plugin, the
          // board and the whole script), then does it itself; one question at a time, and a no holds it off a while
          const b = boardsRef.current[m.key];
          if (!b) throw new Error('no such board');
          if (asking) throw new Error('Studio is already asking the person about this plugin');
          if (Date.now() < refusedUntil) throw new Error('the person said no; ask again later');
          const name = b.info?.name || m.key;
          asking = true;
          let yes = false;
          try {
            yes = m.method === 'update_firmware'
              ? await askRef.current({ title: `${who} wants to update the firmware of ${name}`, text: `The board restarts with the newest firmware release. Only allow this if you trust this plugin.`, yes: 'Allow the update' })
              : await askRef.current({ title: `${who} wants to replace the effect script on ${name}`, text: `This script takes the place of what ${name} runs now${b.script?.text ? ' (that one is kept in your library first)' : ''}:`, script: String(m.text ?? ''), yes: 'Send this script' });
          } finally { asking = false; }
          if (!yes) { refusedUntil = Date.now() + ASK_AGAIN_MS; throw new Error('the person said no'); }
          actRef.current.log(`${who} → ${name}: ${m.method === 'update_firmware' ? 'firmware update (allowed)' : 'effect script (allowed)'}`);
          if (m.method === 'update_firmware') {
            const outcome = await actRef.current.act.updateFirmware(m.key, true);
            if (!outcome) throw new Error('the update did not happen (Studio shows why)');
            post({ id: m.id, result: outcome }); // 'valid', or 'rolled_back' (the board went back to its old firmware)
          } else {
            // never lose work: the board's script, if it is not in the library as it is, is kept there first
            const st = b.scriptStatus?.status;
            if (b.script?.text && (st === 'unknown' || st === 'changed') && prefsRef.current.workspace) {
              await saveNewEffect(prefsRef.current.workspace, `kept from ${name}`, b.script.text, { ask: false });
              bumpRef.current();
            }
            post({ id: m.id, result: await actRef.current.change(m.key, { op: 'set_script', text: String(m.text ?? ''), bytes: new TextEncoder().encode(String(m.text ?? '')).length, ...(m.sounds ? { sounds: m.sounds } : {}) }) });
          }
        } else if (m.method === 'mqtt_subscribe') {
          if (!canSubscribe(pp, String(m.filter))) throw new Error(`${m.filter} is not in this plugin's topics`);
          if (!mqttSubs.has(String(m.filter))) void call('mqtt_watch', { filter: String(m.filter) }).catch(() => {}); // only watched topics reach Studio
          mqttSubs.add(String(m.filter));
          post({ id: m.id, result: true });
          for (const r of await call('mqtt_retained', { filter: m.filter }).catch(() => [])) post({ event: { kind: 'mqtt', type: 'mqtt', ...r } });
        } else if (m.method === 'mqtt_publish') {
          // QoS 0, never retained; action topics were agreed on the consent screen and are logged
          if (!canPublish(pp, String(m.topic))) throw new Error(`${m.topic} is not in this plugin's topics`);
          if (isAction(pp, String(m.topic))) actRef.current.log(`${plugin?.name || plugin?.id}: ${m.topic} = ${String(m.payload ?? '').slice(0, 80)}`);
          await call('mqtt_publish', { topic: String(m.topic), payload: String(m.payload ?? '') });
          post({ id: m.id, result: true });
        } else if (m.method === 'subscribe') {
          subscribed.current = true;
          post({ id: m.id, result: true });
        } else post({ id: m.id, error: 'unknown method' });
      } catch (err: any) {
        post({ id: m.id, error: String(err.message || err) });
      }
    };
    window.addEventListener('message', onMsg);
    const off = onEvent((ev: any) => {
      if (ev.kind === 'mqtt') { if ([...mqttSubs].some((f) => topicMatches(f, ev.topic))) post({ event: { kind: 'mqtt', type: 'mqtt', topic: ev.topic, payload: ev.payload, retained: false } }); return; }
      if (subscribed.current && FORWARDED.has(ev.kind)) post({ event: ev });
    });
    return () => {
      window.removeEventListener('message', onMsg); off();
      for (const f of mqttSubs) void call('mqtt_unwatch', { filter: f }).catch(() => {});
      // the plugin's page is gone: every output it turned on is let go
      for (const [key, chans] of lit) for (const ch of chans) void rpc(key, { op: 'set_output', channel: ch, level: null }).catch(() => {});
      askRef.current = async () => false;
    };
  }, [plugin?.id, consented]); // eslint-disable-line react-hooks/exhaustive-deps

  // tell the plugin when boards are added or removed
  const keys = Object.keys(boards).sort().join('|');
  useEffect(() => {
    if (subscribed.current) frame.current?.contentWindow?.postMessage({ event: { kind: 'boards_changed' } }, '*');
  }, [keys]);

  // and when a board's info changes (after a restart or a firmware update Studio reads it again): its firmware
  // type, version, name or board package, as `{kind: 'board_info', key, info}`
  const infoSeen = useRef<Record<string, string>>({});
  const infos = infoSignatures(boards);
  useEffect(() => {
    const now: Record<string, string> = JSON.parse(infos);
    for (const [key, sig] of Object.entries(now)) {
      const before = infoSeen.current[key];
      if (before !== undefined && before !== sig && subscribed.current)
        frame.current?.contentWindow?.postMessage({ event: { kind: 'board_info', key, info: boardsRef.current[key]?.info } }, '*');
    }
    infoSeen.current = now;
  }, [infos]);

  if (!plugin) return <Typography sx={{ p: 5 }}>Plugin not found.</Typography>;
  if (!consented) return <Box sx={{ p: 5, overflow: 'auto' }}><PluginConsent plugin={plugin} onAnswer={(v) => { if (v) setConsented(true); }} /></Box>;
  return (
    <Box sx={{ flex: 1, minHeight: 0 }}>
      {ask && (
        <Dialog open onClose={() => ask.resolve(false)} fullWidth maxWidth="md" aria-labelledby="plugin-ask-title">
          <DialogTitle id="plugin-ask-title">{ask.title}</DialogTitle>
          <DialogContent>
            <Typography gutterBottom>{ask.text}</Typography>
            {ask.script !== undefined && <Box component="pre" data-testid="plugin-script" sx={{ p: 2, bgcolor: 'action.hover', borderRadius: 2, overflow: 'auto', maxHeight: 300, m: 0 }}>{ask.script || '(empty: the board would have no effect script)'}</Box>}
          </DialogContent>
          <DialogActions>
            <Button onClick={() => ask.resolve(false)} autoFocus>No</Button>
            <Button variant="contained" color="warning" onClick={() => ask.resolve(true)}>{ask.yes}</Button>
          </DialogActions>
        </Dialog>
      )}
      <iframe ref={frame} title={plugin.name || plugin.id} src={pluginUrl(plugin.id, plugin.entry)} sandbox="allow-scripts allow-forms" style={{ border: 0, width: '100%', height: '100%' }} />
    </Box>
  );
}

/** Per board, what a plugin is told about when it changes (JSON, so an effect can depend on it): the info fields
 * that say which firmware and board it is. */
export function infoSignatures(boards: Record<string, { info?: any }>): string {
  const out: Record<string, string> = {};
  for (const [key, b] of Object.entries(boards)) {
    const i = b.info || {};
    out[key] = JSON.stringify([i.fw, i.fw_version, i.fw_build, i.fw_impl, i.name, i.board, i.mcu, i.id]);
  }
  return JSON.stringify(out);
}
