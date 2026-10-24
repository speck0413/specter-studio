// Device adapters (docs/DESIGN.md "Device adapters"): an extension that brings another kind of device. Its page
// runs hidden in a sandboxed frame for as long as Studio runs and speaks for its devices: it tells Studio which
// devices there are and how they are (in the Proptroller protocol's words: info, state, events), and answers
// Studio's requests for them (info, state, get_params / set_params, set_output, action, reboot, stop...). Studio
// then shows them like any board: grid, badges where they apply, live tiles, settings, actions, activity.
//
// adapter -> Studio   {id?, method: 'devices', devices: [Device]}          the whole list (replaces it)
//                     {id?, method: 'device', device: Device}              one device, new or changed
//                     {method: 'event', device: id, msg}                   a protocol event ({event: 'log'|'state', data})
//                     {id, method: 'mqtt_subscribe', filter}               topics from plugin.json "mqtt" only
//                     {id, method: 'mqtt_publish', topic, payload}         likewise
//                     {id, method: 'http', url, verb?, body?}              local-network devices only
//   Device = {id, name, online?, info?, state?, stale_ms?}
// Studio -> adapter   {id, method: 'request', device, req}  -> reply {id, result: {ok, result | error}}
//                     {event: {kind: 'mqtt', type: 'mqtt', topic, payload, retained}}
import { useEffect, useRef, useState } from 'react';
import { adapterRpc, call, onEvent, pluginUrl } from '../api';
import { useStore } from '../store';
import { canPublish, canSubscribe, isAction, perms, topicMatches } from './pluginPerms';
import PluginConsent, { useConsent } from './PluginConsent';
import { onPluginsChanged } from '../pluginsChanged';

const REQUEST_TIMEOUT_MS = 5000; // a device request expires; it is never queued for later

function AdapterFrame({ plugin }: { plugin: any }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const store = useStore();
  const storeRef = useRef(store);
  storeRef.current = store;
  useEffect(() => {
    const aid = plugin.id;
    const pp = perms(plugin);
    const subs = new Set<string>();
    const waiting = new Map<number, (v: any) => void>();
    let next = 1;
    const post = (m: any) => frame.current?.contentWindow?.postMessage(m, '*');
    adapterRpc.set(aid, (device, req) => new Promise((resolve) => {
      const id = next++;
      const t = setTimeout(() => { waiting.delete(id); resolve({ ok: false, error: { code: 'internal', message: 'the device did not answer' } }); }, REQUEST_TIMEOUT_MS);
      waiting.set(id, (v) => { clearTimeout(t); resolve(v); });
      post({ id, method: 'request', device, req });
    }));
    const onMsg = async (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow) return;
      const m = e.data || {};
      const reply = (result: unknown, error?: string) => { if (m.id !== undefined && m.method) post(error ? { id: m.id, error } : { id: m.id, result }); };
      try {
        if (m.method === undefined && waiting.has(m.id)) { waiting.get(m.id)!(m.result ?? { ok: false, error: { code: 'internal', message: String(m.error) } }); waiting.delete(m.id); return; }
        const s = storeRef.current;
        if (m.method === 'devices') { s.adapterDevices(aid, m.devices || [], true); reply(true); }
        else if (m.method === 'device') { s.adapterDevices(aid, [m.device], false); reply(true); }
        else if (m.method === 'event') { s.adapterEvent(aid, String(m.device), m.msg); }
        else if (m.method === 'mqtt_subscribe') {
          if (!canSubscribe(pp, String(m.filter))) throw new Error(`${m.filter} is not in this adapter's topics`);
          if (!subs.has(m.filter)) void call('mqtt_watch', { filter: String(m.filter) }).catch(() => {}); // only watched topics reach Studio
          subs.add(m.filter); reply(true);
          // what the server holds for these topics, flagged retained (not news: no proof the device is alive)
          for (const r of await call('mqtt_retained', { filter: m.filter }).catch(() => [])) post({ event: { kind: 'mqtt', type: 'mqtt', ...r } });
        } else if (m.method === 'mqtt_publish') {
          if (!canPublish(pp, String(m.topic))) throw new Error(`${m.topic} is not in this adapter's topics`);
          if (isAction(pp, String(m.topic))) storeRef.current.logActivity(`${plugin.name || aid}: ${m.topic} = ${String(m.payload ?? '').slice(0, 80)}`);
          reply(await call('mqtt_publish', { topic: m.topic, payload: String(m.payload ?? '') }));
        } else if (m.method === 'http') {
          if (!pp.http) throw new Error('this adapter has no network access (plugin.json "http")');
          reply(await call('http_request', { url: m.url, method: m.verb || 'GET', body: m.body }));
        } else if (m.id !== undefined) throw new Error('unknown method');
      } catch (err: any) { reply(null, String(err.message || err)); }
    };
    window.addEventListener('message', onMsg);
    const off = onEvent((ev: any) => {
      if (ev.kind === 'mqtt' && [...subs].some((f) => topicMatches(f, ev.topic))) post({ event: { kind: 'mqtt', type: 'mqtt', topic: ev.topic, payload: ev.payload, retained: false } });
    });
    return () => { window.removeEventListener('message', onMsg); off(); for (const f of subs) void call('mqtt_unwatch', { filter: f }).catch(() => {}); adapterRpc.delete(aid); storeRef.current.adapterDevices(aid, [], true); };
  }, [plugin.id]); // eslint-disable-line react-hooks/exhaustive-deps
  return <iframe ref={frame} title={`${plugin.name || plugin.id} (device adapter)`} src={pluginUrl(plugin.id, plugin.adapter)} sandbox="allow-scripts" style={{ display: 'none' }} aria-hidden />;
}

function Adapter({ plugin }: { plugin: any }) {
  const [ok, setOk] = useConsent(plugin);
  const [asked, setAsked] = useState(false);
  if (ok) return <AdapterFrame plugin={plugin} />;
  if (asked) return null; // "not now": asked again at the next start
  return <PluginConsent plugin={plugin} onAnswer={(v) => { setAsked(true); if (v) setOk(true); }} />;
}

/** Every adapter plugin, loaded once (after the person allowed it) for as long as Studio runs. */
export default function Adapters() {
  const [list, setList] = useState<any[]>([]);
  useEffect(() => {
    const read = () => call('plugins').then((p: any[]) => setList(p.filter((x) => typeof x.adapter === 'string'))).catch(() => {});
    void read();
    return onPluginsChanged(() => void read());
  }, []);
  return <>{list.map((p) => <Adapter key={p.id} plugin={p} />)}</>;
}
