// The adapter side of Specter Studio's device-adapter API (copy this file into your adapter). The page runs
// hidden for as long as Studio runs; it speaks for its devices in the Proptroller protocol's words.
//   adapter.devices([{id, name, online, info, state, stale_ms}])  the whole list
//   adapter.device({id, ...})                                      one device, new or changed (also "I heard from it")
//   adapter.event(id, msg)                                         a protocol event: {event: 'state', data} or {event: 'log', data}
//   adapter.onRequest(async (id, req) => envelope)                 answer Studio: {ok: true, result} or {ok: false, error: {code, message}}
//   adapter.mqtt.subscribe(filter, (topic, payload) => {})         topics from plugin.json "mqtt" only
//   adapter.mqtt.publish(topic, payload)
//   adapter.http(url, {verb, body})                                local-network devices only (plugin.json "http": true)
(function () {
  let next = 1;
  const waiting = new Map();
  const subs = [];
  let handler = async () => ({ ok: false, error: { code: 'unsupported', message: 'not supported' } });
  const match = (f, t) => { const a = f.split('/'), b = t.split('/'); for (let i = 0; i < a.length; i++) { if (a[i] === '#') return true; if (i >= b.length || (a[i] !== '+' && a[i] !== b[i])) return false; } return a.length === b.length; };
  window.addEventListener('message', async (e) => {
    if (e.source !== window.parent) return;
    const m = e.data || {};
    if (m.event && m.event.kind === 'mqtt') { subs.forEach(([f, fn]) => match(f, m.event.topic) && fn(m.event.topic, m.event.payload)); return; }
    if (m.method === 'request') {
      let result;
      try { result = await handler(m.device, m.req); } catch (err) { result = { ok: false, error: { code: 'internal', message: String(err.message || err) } }; }
      window.parent.postMessage({ id: m.id, result }, '*');
      return;
    }
    const w = waiting.get(m.id);
    if (w) { waiting.delete(m.id); if (m.error) w.reject(new Error(m.error)); else w.resolve(m.result); }
  });
  const ask = (msg) => new Promise((resolve, reject) => { const id = next++; waiting.set(id, { resolve, reject }); window.parent.postMessage({ id, ...msg }, '*'); });
  window.adapter = {
    devices: (devices) => ask({ method: 'devices', devices }),
    device: (device) => window.parent.postMessage({ method: 'device', device }, '*'),
    event: (id, msg) => window.parent.postMessage({ method: 'event', device: id, msg }, '*'),
    onRequest: (fn) => { handler = fn; },
    mqtt: {
      subscribe: (filter, fn) => { subs.push([filter, fn]); return ask({ method: 'mqtt_subscribe', filter }); },
      publish: (topic, payload) => ask({ method: 'mqtt_publish', topic, payload: typeof payload === 'string' ? payload : JSON.stringify(payload) }),
    },
    http: (url, o = {}) => ask({ method: 'http', url, verb: o.verb, body: o.body }),
  };
})();
