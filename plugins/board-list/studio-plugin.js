// The plugin side of Specter Studio's plugin API (copy this file into your plugin). A plugin page runs in a
// sandboxed frame and reaches boards only through these calls:
//   studio.boards()          -> [{key, name, info, state, online}]
//   studio.rpc(key, request) -> the board's answer {ok, result | error}. Reading always; running, stopping, testing,
//                               sounds, pixels and some settings only with plugin.json "control": true (the person agrees
//                               on the consent screen; each one is logged). Never passwords, Wi-Fi, the name, the page
//                               lock, safety limits, roles or profiles (Studio's src/components/pluginPerms.ts)
//   studio.subscribe(fn)     -> fn(event) for every board event ({kind: 'board'|'online', key, msg|online}; 'boards_changed';
//                               {kind: 'board_info', key, info} when a board's info changes)
//   studio.updateFirmware(key)      -> Studio asks the person, then updates that board's firmware
//   studio.sendScript(key, text)    -> Studio asks the person, then sends that effect script to the board
//   studio.mqttSubscribe(filter, fn) -> fn({topic, payload, retained}) for topics in plugin.json "mqtt" (retained = the
//                                       server's stored copy, not news)
//   studio.mqttPublish(topic, payload) -> QoS 0, never retained; topics in plugin.json "mqtt" (publish or actions)
(function () {
  let next = 1;
  const waiting = new Map();
  const listeners = [];
  const mqttListeners = [];
  const match = (f, t) => { const a = f.split('/'), b = t.split('/'); for (let i = 0; i < a.length; i++) { if (a[i] === '#') return true; if (i >= b.length || (a[i] !== '+' && a[i] !== b[i])) return false; } return a.length === b.length; };
  window.addEventListener('message', (e) => {
    if (e.source !== window.parent) return;
    const m = e.data || {};
    if (m.event && m.event.type === 'mqtt') { mqttListeners.forEach(([f, fn]) => match(f, m.event.topic) && fn(m.event)); return; }
    if (m.event) { listeners.forEach((f) => f(m.event)); return; }
    const w = waiting.get(m.id);
    if (!w) return;
    waiting.delete(m.id);
    if (m.error) w.reject(new Error(m.error)); else w.resolve(m.result);
  });
  function ask(msg) {
    return new Promise((resolve, reject) => {
      const id = next++;
      waiting.set(id, { resolve, reject });
      window.parent.postMessage({ id, ...msg }, '*');
    });
  }
  window.studio = {
    boards: () => ask({ method: 'boards' }),
    rpc: (key, req) => ask({ method: 'rpc', key, req }),
    subscribe: (fn) => { listeners.push(fn); return ask({ method: 'subscribe' }); },
    updateFirmware: (key) => ask({ method: 'update_firmware', key }),
    sendScript: (key, text, sounds) => ask({ method: 'send_script', key, text, sounds }),
    mqttSubscribe: (filter, fn) => { mqttListeners.push([filter, fn]); return ask({ method: 'mqtt_subscribe', filter }); },
    mqttPublish: (topic, payload) => ask({ method: 'mqtt_publish', topic, payload: typeof payload === 'string' ? payload : JSON.stringify(payload) }),
  };
})();
