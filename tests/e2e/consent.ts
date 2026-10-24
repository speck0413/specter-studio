// The plugin consent a test starts with: what Studio would remember after "Allow" for every plugin the device layer
// lists (consent is remembered for exactly what plugin.json asks for, from that folder: src/components/pluginPerms.ts).
import { fingerprint } from '../../src/components/pluginPerms';

export async function allowedPlugins(): Promise<Record<string, string>> {
  const ws = new WebSocket(`ws://127.0.0.1:${process.env.E2E_BRIDGE_PORT || '18792'}/?token=${process.env.SPECTER_BRIDGE_TOKEN}`);
  await new Promise((r) => ws.addEventListener('open', r));
  try {
    const list = await new Promise<any[]>((ok, fail) => {
      ws.addEventListener('message', (m) => { const v = JSON.parse(String(m.data)); if (v.id === 1) (v.ok ? ok(v.result) : fail(new Error(v.error))); });
      ws.send(JSON.stringify({ id: 1, cmd: 'plugins', args: {} }));
    });
    return Object.fromEntries(list.map((p) => [p.id, fingerprint(p)]));
  } finally { ws.close(); }
}
