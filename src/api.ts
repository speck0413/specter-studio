// The one door to the device layer: `call(cmd, args)` and `onEvent(fn)`. Inside the desktop app these are the
// Tauri command `dispatch` and the `studio-event` event; in a browser (development, UI tests) the same
// commands go over a WebSocket to the bridge (`npm run bridge`).

export type StudioEvent =
  | { kind: 'board'; key: string; msg: any }
  | { kind: 'online'; key: string; online: boolean }
  | { kind: 'update'; key: string; phase: string; detail: any }
  | { kind: 'serial'; path: string; line: string; status?: string }
  | { kind: 'build'; project: string; line: string }
  // boards reporting to Studio's MQTT server: one changed (online, state, a status value), or it published an event
  | { kind: 'fleet'; board: any }
  | { kind: 'fleet_event'; key: string; name: string; msg: any }
  | { kind: 'mqtt'; topic: string; payload: string; retained: boolean }
  // the library's scripts repository did something (core/src/gitsync.rs answer); auto: started by auto save
  | { kind: 'scripts_repo'; folder: string; auto: boolean; result: any }
  // the SD card tool's progress (core/src/sdcard): format / clear / copy / backup / done
  | { kind: 'sd_card'; phase: string; done: number; total: number; file: string }
  // some events were dropped on the way (the UI fell behind): read the connections and boards again
  | { kind: 'resync' };

type Listener = (e: StudioEvent) => void;
const listeners = new Set<Listener>();

export const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

// whether the device service answers (the status bar): always in the desktop app; in a browser, the bridge's socket
type Conn = 'ok' | 'down';
let conn: Conn = inTauri ? 'ok' : 'down';
const connListeners = new Set<(c: Conn) => void>();
function setConn(c: Conn) { if (c !== conn) { conn = c; connListeners.forEach((l) => l(c)); } }
export function onConnection(fn: (c: Conn) => void): () => void { connListeners.add(fn); fn(conn); return () => connListeners.delete(fn); }

let ws: WebSocket | null = null;
let wsReady: Promise<WebSocket> | null = null;
let nextId = 1;
const pending = new Map<number, { ok: (v: any) => void; fail: (e: Error) => void }>();

function bridge(): Promise<WebSocket> {
  if (wsReady) return wsReady;
  wsReady = new Promise((resolve, reject) => {
    const url = new URLSearchParams(location.search).get('bridge') || `ws://${location.host}/__bridge`;
    ws = new WebSocket(url);
    ws.onopen = () => { setConn('ok'); resolve(ws!); };
    ws.onerror = () => reject(new Error('Specter Studio cannot reach its device service'));
    ws.onclose = () => {
      setConn('down');
      wsReady = null;
      for (const p of pending.values()) p.fail(new Error('the device service closed'));
      pending.clear();
    };
    ws.onmessage = (m) => {
      const v = JSON.parse(m.data);
      if (v.event) listeners.forEach((l) => l(v.event));
      else {
        const p = pending.get(v.id);
        pending.delete(v.id);
        if (p) (v.ok ? p.ok(v.result) : p.fail(new Error(v.error)));
      }
    };
  });
  return wsReady;
}

let tauriListening = false;
async function tauriListen() {
  if (tauriListening) return;
  tauriListening = true;
  const { listen } = await import('@tauri-apps/api/event');
  await listen<StudioEvent>('studio-event', (e) => listeners.forEach((l) => l(e.payload)));
}

export async function call<T = any>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  if (inTauri) {
    const { invoke } = await import('@tauri-apps/api/core');
    try {
      return await invoke<T>('dispatch', { cmd, args });
    } catch (e) {
      throw new Error(String(e));
    }
  }
  const s = await bridge();
  const id = nextId++;
  return new Promise<T>((ok, fail) => {
    pending.set(id, { ok, fail });
    s.send(JSON.stringify({ id, cmd, args }));
  });
}

export function onEvent(fn: Listener): () => void {
  listeners.add(fn);
  if (inTauri) void tauriListen();
  else void bridge().catch(() => {});
  return () => listeners.delete(fn);
}

/** A request to a connected board; resolves with the board's answer envelope `{ok, result | error}`. */
export type Envelope = { ok: boolean; result?: any; error?: { code: string; message: string } };

/** Devices brought by device adapters (keys `adapter:<adapter id>:<device id>`): their requests go to the adapter. */
export const adapterRpc = new Map<string, (device: string, req: Record<string, unknown>) => Promise<Envelope>>();

export function rpc(key: string, req: Record<string, unknown>): Promise<Envelope> {
  if (key.startsWith('adapter:')) {
    const [, aid, ...rest] = key.split(':');
    const h = adapterRpc.get(aid);
    if (!h) return Promise.resolve({ ok: false, error: { code: 'unsupported', message: 'the device adapter is not loaded' } });
    return h(rest.join(':'), req);
  }
  return call<Envelope>('rpc', { key, req });
}

/** Picks a folder (desktop app: the system dialog; browser: a prompt). */
export async function pickFolder(title: string, current = ''): Promise<string | null> {
  if (inTauri) {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const r = await open({ directory: true, title, defaultPath: current || undefined });
    return typeof r === 'string' ? r : null;
  }
  return window.prompt(title, current);
}

export async function pickFile(title: string): Promise<string | null> {
  if (inTauri) {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const r = await open({ directory: false, title });
    return typeof r === 'string' ? r : null;
  }
  return window.prompt(title, '');
}

/** Picks several files (desktop app: the system dialog, with `filters` such as [{name: 'Sounds', extensions:
 * ['mp3', 'wav']}]; browser: a prompt for paths, separated by `|`). */
export async function pickFiles(title: string, filters?: { name: string; extensions: string[] }[]): Promise<string[]> {
  if (inTauri) {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const r = await open({ directory: false, multiple: true, title, filters });
    return Array.isArray(r) ? r : typeof r === 'string' ? [r] : [];
  }
  const r = window.prompt(`${title} (paths, separated by |)`, '');
  return r ? r.split('|').map((p) => p.trim()).filter(Boolean) : [];
}

/** Picks where to save a file (desktop app: the system dialog; browser: a prompt). */
export async function pickSavePath(title: string, defaultPath: string, filters?: { name: string; extensions: string[] }[]): Promise<string | null> {
  if (inTauri) {
    const { save } = await import('@tauri-apps/plugin-dialog');
    return (await save({ title, defaultPath, filters })) ?? null;
  }
  return window.prompt(title, defaultPath);
}

/** The URL a plugin's page loads from. */
export function pluginUrl(id: string, entry: string) {
  if (!inTauri) return `/plugins/${id}/${entry}`;
  // Tauri serves custom schemes as http://<scheme>.localhost on Windows
  return navigator.userAgent.includes('Windows') ? `http://plugin.localhost/${id}/${entry}` : `plugin://localhost/${id}/${entry}`;
}

/** Local time as "YYYY-MM-DD-HHMMSS" (backup file names, so they match the time the backup list shows). */
export function fileStampLocal(d = new Date()) {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Local time as "YYYY-MM-DD HH:MM" (library save times). */
export function nowLocal(d = new Date()) {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
