// App state: the person's preferences and every connected board (its info, live state, effect script and
// firmware compared with the workspace). React state and context only.
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { call, onEvent, rpc, StudioEvent } from './api';
import { pinBackoff } from './pinwait';
import { flushOwed, forgetBoard, holdOutput, releaseOutput } from './held';
import { settingsMeta, unsavedSettings } from './drafts';
import { showTargets, wantsHeld } from './shows/shows';
import { firmwareArgsOf, firmwareKind, firmwarePlugins } from './firmware';
import { FirmwareSig, noteFirstSeen } from './freshStart';

import type { ThemePref } from './theme';

export interface Prefs {
  workspace: string; // "My Props": effects/, firmware/, .specter/
  backups: string;
  releases: string; // folder or URL of proptroller-firmware.json, or a GitHub releases page ('' = the official releases)
  advanced: boolean;
  /** Settings "Allow betas": firmware lists may offer pre-releases (release candidates); off by default */
  betas?: boolean;
  /** the look: a theme (theme.ts), or 'system' = Light or Dark as the computer is set */
  theme: ThemePref;
  /** text size in percent (70-200, theme.ts); everything scales with it */
  zoom: number;
  /** the side bar's width in px, and whether it is hidden (Ctrl+B) */
  sideBarWidth?: number;
  sideBarHidden?: boolean;
  /** a board page's Live pane width in px (wide windows) */
  livePaneWidth?: number;
  firstRunDone: boolean;
  boards: string[]; // addresses to reconnect at start
  editorView?: 'both' | 'script' | 'blocks'; // the effect editor: script and blocks, script only or blocks only
  /** script sources (components/ScriptsRepo.tsx): where new scripts are saved, which sources auto save */
  scriptSources?: { saveNew?: string; auto?: string[] };
  /** the Dashboard covers a board's card with the effect's icon for a moment when it starts one (default on) */
  triggerFlash?: boolean;
  pluginConsent?: Record<string, string | boolean>; // plugins the person allowed: what they asked for (pluginPerms.ts fingerprint)
  /** per board id: the firmware type and board package Studio last saw it run (freshStart.ts) */
  firmwareSeen?: Record<string, FirmwareSig>;
  /** "Keep mine" on the Start fresh banner, per board, firmware and board package (freshStart.ts keptKey) */
  freshKept?: Record<string, boolean>;
}

export interface Board {
  key: string;
  info: any;
  state?: any;
  online: boolean;
  sim: boolean;
  script?: { text: string; check?: any; sounds?: Record<string, number> };
  scriptStatus?: any; // library_identify
  firmware?: { custom: any; plan?: any };
  log: { t: number; text: string }[];
  update?: { phase: string; detail: any };
  /** the board's shows (recorded on the board or its own page): read-only in Studio */
  shows?: { id: number; name: string; enabled: boolean; inputs: string[]; targets?: string[]; held?: boolean }[];
  /** the board's own page (network boards) */
  address?: string;
  /** the last firmware update that did not take (Studio stops offering that same version) */
  lastUpdate?: { result: 'rolled_back' | 'failed'; version?: string; message?: string };
  /** set for a device brought by a device adapter (docs/DESIGN.md "Device adapters"): the adapter's id */
  adapter?: string;
  /** when the device was last heard from, and how long it may be quiet before it counts as offline */
  lastSeen?: number;
  staleMs?: number;
  /** counts the board's params_changed events (its settings were changed: here, on its page, by MQTT) */
  paramsSeq?: number;
  /** when Studio last saw each input pressed (since the board was added): an input never seen pressed may be unplugged */
  pressed?: Record<string, number>;
  /** the board's sound player did not answer and that was said once (logLine) */
  soundQuiet?: boolean;
  /** another device answers at this board's address (the router gave it to something else): Studio sends it nothing */
  otherDevice?: string;
}

/** A device adapter's device counts as offline after this long without news (unless it says otherwise). */
export const STALE_MS = 1500;

const DEFAULTS: Prefs = { workspace: '', backups: '', releases: '', advanced: false, theme: 'system', zoom: 100, firstRunDone: false, boards: [] };

function loadPrefs(): Prefs {
  try {
    const saved = JSON.parse(localStorage.getItem('specter-prefs') || '{}');
    // before themes: dark true / false / null (follow the computer)
    if (saved.theme === undefined && 'dark' in saved) saved.theme = saved.dark === true ? 'dark' : saved.dark === false ? 'light' : 'system';
    delete saved.dark;
    return { ...DEFAULTS, ...saved };
  } catch {
    return DEFAULTS;
  }
}

export interface Store {
  prefs: Prefs;
  setPrefs: (p: Partial<Prefs>) => void;
  boards: Record<string, Board>;
  connect: (address: string) => Promise<string>;
  connectSerial: (path: string) => Promise<string>;
  startSim: (name: string) => Promise<string>;
  remove: (key: string) => Promise<void>;
  refreshScript: (key: string) => Promise<void>;
  refreshFirmware: (key: string) => Promise<void>;
  /** reads the board's shows again (after Studio changed one) */
  refreshShows: (key: string) => Promise<void>;
  /** A request that changes something: asks for the page password when the board's page lock wants one. */
  change: (key: string, req: Record<string, unknown>) => Promise<any>;
  /** A test output on (held) or let go; a let-go that does not reach the board is sent again until it does (held.ts). */
  /** `level`: permille while on (default 1000, full) */
  testOutput: (key: string, channel: string, on: boolean, level?: number) => Promise<any>;
  /** asks for the page password; `also`: more locked boards the same password is tried on (one question for all) */
  askPin: (key: string, also?: string[]) => Promise<string | null>;
  pinFor: (key: string) => Promise<string | undefined>;
  libraryVersion: number;
  bumpLibrary: () => void;
  pinRequest: { key: string; also?: string[]; resolve: (v: { pin: string; remember: boolean } | null) => void } | null;
  adapterDevices: (adapter: string, devices: any[], replace: boolean) => void;
  adapterEvent: (adapter: string, device: string, msg: any) => void;
  /** Studio-wide activity (plugin actions, stops...), newest last */
  activity: { t: number; text: string }[];
  logActivity: (text: string) => void;
  /** every plugin found (plugin.json, with its folder) */
  plugins: any[];
  /** where firmware comes from, for the device layer: the release source and the allowed plugins with firmware lists */
  firmwareArgs: () => { source: string; plugins: string[]; betas: boolean };
}

const Ctx = createContext<Store>(null as any);
export const useStore = () => useContext(Ctx);

/** What changed between two states, in plain words: inputs pressed and let go, effects starting and ending. */
export function changes(before: any, after: any): { t: number; text: string }[] {
  if (!before || !after) return [];
  const out: string[] = [];
  for (const i of after.inputs || []) {
    const was = (before.inputs || []).find((x: any) => x.input === i.input);
    const on = !!(i.raw || i.active);
    if (was && on !== !!(was.raw || was.active)) out.push(`${i.alias || i.input} ${on ? 'pressed' : 'let go'}`);
  }
  for (const e of after.script?.effects || []) {
    const was = (before.script?.effects || []).find((x: any) => x.name === e.name);
    if (was && e.running && !was.running) out.push(`Effect “${e.name}” started`);
    if (was && !e.running && was.running) out.push(`Effect “${e.name}” finished`);
  }
  if (after.paused && !before.paused) out.push('Stopped: triggers are ignored');
  return out.map((text) => ({ t: Date.now(), text }));
}

/** The inputs pressed in this state, stamped now, added to what was seen before (unchanged object when none). */
export function pressedNow(seen: Record<string, number> | undefined, state: any): Record<string, number> | undefined {
  const on = (state?.inputs || []).filter((i: any) => i.raw || i.active).map((i: any) => String(i.input));
  if (!on.length) return seen;
  const n = { ...(seen || {}) };
  for (const i of on) n[i] = Date.now();
  return n;
}

/** A notice event in plain words. */
export function describe(msg: any): string | null {
  const d = msg.data;
  switch (msg.event) {
    case 'log':
      return String(d);
    case 'notice':
      if (d.notice === 'started') return `Show ${d.show} started (${d.cause?.by}${d.cause?.detail ? ' ' + d.cause.detail : ''})`;
      if (d.notice === 'ended') return `Show ${d.show} ended (${d.reason === 'released' ? 'let go' : d.reason})`; // released: an "on while held" run let go
      if (d.notice === 'ignored') return `A trigger was ignored (${d.why})`;
      if (d.notice === 'watchdog') return `${d.channel || 'An output'} was switched off: it reached its max on-time (watchdog)`;
      if (d.notice === 'interlock') return `${d.channel || 'An output'} was held off by an interlock`;
      // stopping is logged from the state ("Stopped: triggers are ignored", changes()); only the release is said here
      if (d.notice === 'paused') return d.paused ? null : 'Resumed: shows start on their triggers again';
      return `Notice: ${d.notice}`;
    case 'script_changed':
      return 'The effect script changed';
    case 'params_changed':
      return 'Settings changed';
    case 'update':
      return `Firmware update: ${d.phase}${d.total ? ` ${Math.round((100 * d.done) / d.total)}%` : ''}${d.message ? ': ' + d.message : ''}`;
    default:
      return null;
  }
}

/** The activity line for a board's sound player not answering, said once (a board without one reports it twice
 * after every stop and restart). */
export const SOUND_SILENT = 'No sound player answers on this board. That is fine if none is wired; sounds play only once one is connected.';

/** What a board's activity log gets for one event text: `text` null drops it. A "sound player did not answer"
 * becomes one plain line until the player answers again ("sound player online"). */
export function logLine(b: Pick<Board, 'soundQuiet'>, text: string): { text: string | null; soundQuiet?: boolean } {
  if (/^sound player did not answer/.test(text)) return b.soundQuiet ? { text: null } : { text: SOUND_SILENT, soundQuiet: true };
  if (text === 'sound player online') return { text, soundQuiet: false };
  return { text };
}

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const [prefs, setPrefsState] = useState<Prefs>(loadPrefs);
  const [boards, setBoards] = useState<Record<string, Board>>({});
  const [libraryVersion, setLibraryVersion] = useState(0);
  const [pinRequest, setPinRequest] = useState<Store['pinRequest']>(null);
  const [activity, setActivity] = useState<{ t: number; text: string }[]>([]);
  const [plugins, setPlugins] = useState<any[]>([]);
  const pluginsRef = useRef(plugins);
  pluginsRef.current = plugins;
  const logActivity = useCallback((text: string) => setActivity((a) => [...a.slice(-499), { t: Date.now(), text }]), []);
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const pins = useRef<Record<string, string>>({});
  const pendingPin = useRef<((v: string | null) => void) | null>(null);
  const boardsRef = useRef(boards);
  boardsRef.current = boards;

  const setPrefs = useCallback((p: Partial<Prefs>) => {
    setPrefsState((old) => {
      const n = { ...old, ...p };
      try {
        localStorage.setItem('specter-prefs', JSON.stringify(n));
      } catch {
        /* private window: preferences last for this session only */
      }
      return n;
    });
  }, []);

  const patch = useCallback((key: string, f: (b: Board) => Partial<Board>) => {
    setBoards((all) => (all[key] ? { ...all, [key]: { ...all[key], ...f(all[key]) } } : all));
  }, []);

  const refreshScript = useCallback(async (key: string) => {
    if (key.startsWith('adapter:')) return; // effect scripts are a Proptroller thing
    const r = await rpc(key, { op: 'get_script' }).catch(() => null);
    if (!r?.ok) {
      patch(key, () => ({ script: undefined, scriptStatus: { status: r?.error?.code === 'bad_request' || r?.error ? 'unsupported' : 'none' } }));
      return;
    }
    const text: string = r.result.text || '';
    const ws = prefsRef.current.workspace;
    const st = ws ? await call('library_identify', { folder: ws, text }).catch(() => null) : null;
    patch(key, () => ({ script: { text, check: r.result.check, sounds: r.result.sounds || {} }, scriptStatus: st || { status: text.trim() ? 'unknown' : 'none' } }));
  }, [patch]);

  const firmwareArgs = useCallback(() => firmwareArgsOf(prefsRef.current, pluginsRef.current), []);
  useEffect(() => { call('plugins').then((p) => setPlugins(Array.isArray(p) ? p : [])).catch(() => {}); }, []);

  const refreshFirmware = useCallback(async (key: string) => {
    if (key.startsWith('adapter:')) {
      const r = await rpc(key, { op: 'info' }).catch(() => null);
      if (r?.ok) patch(key, (b) => ({ info: { ...b.info, ...r.result } }));
      return;
    }
    const r = await rpc(key, { op: 'info' }).catch(() => null);
    if (!r?.ok) return;
    const info = r.result;
    const { workspace } = prefsRef.current;
    const custom = workspace ? await call('identify_firmware', { folder: workspace, info }).catch(() => null) : null;
    // the list of the firmware type the board reports (the stock one, or a plugin's)
    const plan = await call('update_plan', { ...firmwareArgs(), info }).catch((e) => ({ error: String(e.message || e) }));
    patch(key, () => ({ info, firmware: { custom: firmwareKind(custom, plan), plan } }));
  }, [patch, firmwareArgs]);

  const refreshShows = useCallback(async (key: string) => {
    if (key.startsWith('adapter:')) return;
    const r = await rpc(key, { op: 'list_shows' }).catch(() => null);
    if (!r?.ok) return;
    const shows = await Promise.all((r.result.shows || []).map(async (x: any) => {
      const g = await rpc(key, { op: 'get_show', show: x.id }).catch(() => null);
      const data = g?.result?.data;
      const inputs = (data?.triggers || []).filter((t: any) => t.on === 'input' || t.on === 'release').map((t: any) => String(t.input).toUpperCase());
      return { id: x.id, name: x.name, enabled: x.enabled !== false, inputs, targets: showTargets(data), held: wantsHeld(data) };
    }));
    patch(key, () => ({ shows }));
  }, [patch]);

  const added = useCallback(async (key: string, info: any, sim: boolean) => {
    setBoards((all) => ({ ...all, [key]: { key, info, online: true, sim, log: all[key]?.log || [], address: key.startsWith('http') ? key : undefined } }));
    const st = await rpc(key, { op: 'state' }).catch(() => null);
    if (st?.ok) patch(key, () => ({ state: st.result }));
    void refreshScript(key);
    void refreshFirmware(key);
    void refreshShows(key);
  }, [patch, refreshScript, refreshFirmware, refreshShows]);

  const connect = useCallback(async (address: string) => {
    const r = await call('connect', { address });
    await added(r.key, r.info, false);
    if (!prefsRef.current.boards.includes(r.key)) setPrefs({ boards: [...prefsRef.current.boards, r.key] });
    return r.key as string;
  }, [added, setPrefs]);

  const connectSerial = useCallback(async (path: string) => {
    const r = await call('connect', { serial: path });
    await added(r.key, r.info, false);
    return r.key as string;
  }, [added]);

  const startSim = useCallback(async (name: string) => {
    const r = await call('sim_start', { name });
    await added(r.key, r.info, true);
    return r.key as string;
  }, [added]);

  // devices from device adapters: stored like boards (key adapter:<id>:<device>)
  const adapterDevices = useCallback((aid: string, devices: any[], replace: boolean) => {
    setBoards((all) => {
      const n = { ...all };
      if (replace) for (const k of Object.keys(n)) if (n[k].adapter === aid && !devices.some((d) => `adapter:${aid}:${d.id}` === k)) delete n[k];
      for (const d of devices) {
        const key = `adapter:${aid}:${d.id}`;
        const old = n[key];
        const info = { capabilities: [], ...(old?.info || {}), ...(d.info || {}), name: d.name ?? d.info?.name ?? old?.info?.name ?? String(d.id) };
        n[key] = { ...old, key, adapter: aid, sim: false, log: old?.log || [], info, state: d.state ?? old?.state, online: d.online !== false,
          lastSeen: Date.now(), staleMs: d.stale_ms ?? old?.staleMs ?? STALE_MS, firmware: { custom: { kind: 'release' } }, scriptStatus: { status: 'unsupported' } };
      }
      return n;
    });
  }, []);
  const adapterEvent = useCallback((aid: string, device: string, msg: any) => {
    const key = `adapter:${aid}:${device}`;
    setBoards((all) => {
      const b = all[key];
      if (!b) return all;
      const text = describe(msg);
      const state = msg.event === 'state' ? msg.data : b.state;
      return { ...all, [key]: { ...b, state, online: true, lastSeen: Date.now(), log: [...b.log, ...changes(b.state, state), ...(text ? [{ t: Date.now(), text }] : [])].slice(-200) } };
    });
  }, []);
  // a device that has gone quiet counts as offline (its tiles and actions are then off; requests expire)
  useEffect(() => {
    const t = setInterval(() => setBoards((all) => {
      let changed = false;
      const n = { ...all };
      for (const [k, b] of Object.entries(all)) {
        if (b.adapter && b.online && Date.now() - (b.lastSeen || 0) > (b.staleMs || STALE_MS)) {
          n[k] = { ...b, online: false, log: [...b.log, { t: Date.now(), text: 'Not heard from: offline' }].slice(-200) };
          changed = true;
        }
      }
      return changed ? n : all;
    }), 250);
    return () => clearInterval(t);
  }, []);

  const remove = useCallback(async (key: string) => {
    if (!key.startsWith('adapter:')) await call('disconnect', { key });
    forgetBoard(key);
    unsavedSettings.delete(key); // typed settings of a board no longer in Studio are not kept (or asked about at close)
    settingsMeta.delete(key);
    setBoards((all) => {
      const n = { ...all };
      delete n[key];
      return n;
    });
    setPrefs({ boards: prefsRef.current.boards.filter((b) => b !== key) });
  }, [setPrefs]);

  const secretName = (key: string) => { const id = boardsRef.current[key]?.info?.id; return id ? `page-password:id:${id}` : `page-password:${key}`; };
  const askPin = useCallback((key: string, also?: string[]) => new Promise<string | null>((resolve) => {
    // a second question replaces the first: the first one is answered "cancelled", never left waiting
    pendingPin.current?.(null);
    pendingPin.current = resolve;
    setPinRequest({
      key,
      also,
      resolve: (v) => {
        setPinRequest(null);
        pendingPin.current = null;
        if (!v) return resolve(null);
        pins.current[key] = v.pin; // forgotten again if the board refuses it (change() asks again)
        if (v.remember) void call('secret_set', { name: secretName(key), value: v.pin }).catch((e) => logActivity(`The page password for ${boardsRef.current[key]?.info?.name || key} could not be remembered: ${String(e?.message || e)}`));
        resolve(v.pin);
      },
    });
  }), [logActivity]); // eslint-disable-line react-hooks/exhaustive-deps

  // the page password already known for a locked board: typed this session, or remembered in the keychain
  const pinFor = useCallback(async (key: string): Promise<string | undefined> => {
    if (pins.current[key]) return pins.current[key];
    if (!boardsRef.current[key]?.info?.capabilities?.includes('pin')) return undefined;
    // remembered by the board's own id (an address can move to another device); older Studios used the address
    const id = boardsRef.current[key]?.info?.id;
    let p = id ? await call('secret_get', { name: `page-password:id:${id}` }).catch(() => null) : null;
    if (!p) p = await call('secret_get', { name: `page-password:${key}` }).catch(() => null);
    if (p) pins.current[key] = p;
    return p || undefined;
  }, []);

  const change = useCallback(async (key: string, req: Record<string, unknown>) => {
    let pin = await pinFor(key);
    for (let i = 0; i < 3; i++) {
      const r = await pinBackoff(() => rpc(key, pin ? { ...req, pin } : req));
      if (r.ok || r.error?.code !== 'pin') return r;
      const p = await askPin(key);
      if (!p) return r;
      pin = p;
    }
    return rpc(key, req);
  }, [askPin, pinFor]);

  // a request with the page password Studio already knows, never asking (let-go retries must not pop questions)
  const quiet = useCallback(async (key: string, req: Record<string, unknown>) => {
    const pin = await pinFor(key);
    return rpc(key, pin ? { ...req, pin } : req);
  }, [pinFor]);
  const testOutput = useCallback((key: string, channel: string, on: boolean, level?: number) =>
    on ? holdOutput(change, key, channel, level) : releaseOutput(quiet, key, channel), [change, quiet]);

  // live states arrive up to 5 times a second per board: they are applied together, at most every 150 ms, in one
  // update (30 boards each changing 5 times a second would otherwise re-render Studio 150 times a second). Every
  // state is still compared with the one before it, so no press or effect start is missed in the activity log.
  const stateQueue = useRef<{ key: string; data: any }[]>([]);
  const stateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushStates = useCallback(() => {
    stateTimer.current = null;
    const q = stateQueue.current;
    stateQueue.current = [];
    if (!q.length) return;
    setBoards((all) => {
      let n = all;
      for (const { key, data } of q) {
        const b = n[key];
        if (!b) continue;
        if (n === all) n = { ...all };
        const more = changes(b.state, data);
        n[key] = { ...b, state: data, log: more.length ? [...b.log, ...more].slice(-200) : b.log, pressed: pressedNow(b.pressed, data) };
      }
      return n;
    });
  }, []);
  const queueState = useCallback((key: string, data: any) => {
    stateQueue.current.push({ key, data });
    if (!stateTimer.current) stateTimer.current = setTimeout(flushStates, 150);
  }, [flushStates]);

  // events from every board
  useEffect(() => onEvent((e: StudioEvent) => {
    if (e.kind === 'resync') {
      // Studio fell behind the device layer's events: read every board's state, shows and script again
      for (const k of Object.keys(boardsRef.current)) {
        if (k.startsWith('adapter:')) continue;
        void rpc(k, { op: 'state' }).then((r) => { if (r?.ok) queueState(k, r.result); }).catch(() => {});
        void refreshShows(k);
        void refreshScript(k);
      }
      return;
    }
    if (e.kind === 'online') {
      patch(e.key, () => ({ online: e.online }));
      if (e.online) {
        void flushOwed(quiet, e.key);
        void refreshFirmware(e.key);
        void refreshScript(e.key);
        void refreshShows(e.key);
        // back (after a restart, a Wi-Fi drop): its state now, not when it next changes
        void rpc(e.key, { op: 'state' }).then((st) => { if (st?.ok) patch(e.key, () => ({ state: st.result })); }).catch(() => {});
      }
    } else if (e.kind === 'update') {
      const failed = e.phase === 'rolled_back' || e.phase === 'failed';
      const words: Record<string, string> = { sending: 'Firmware update: sending', restarting: 'Firmware update: restarting', checking: 'Firmware update: checking the new firmware',
        valid: 'Firmware update finished', rolled_back: 'Firmware update did not start; the board went back to its old firmware', failed: `Firmware update failed${e.detail?.message ? ': ' + e.detail.message : ''}` };
      patch(e.key, (b) => ({
        update: { phase: e.phase, detail: e.detail },
        log: [...b.log.slice(-199), { t: Date.now(), text: words[e.phase] || `Firmware update: ${e.phase}` }],
        ...(failed ? { lastUpdate: { result: e.phase as any, version: b.firmware?.plan?.latest, message: e.detail?.message } } : e.phase === 'valid' ? { lastUpdate: undefined } : {}),
      }));
    } else if (e.kind === 'board') {
      const m = e.msg;
      if (m.event === 'log' && m.other_device) patch(e.key, () => ({ otherDevice: String(m.data) }));
      if (m.event === 'log' && m.data === 'the board is back at its address') patch(e.key, () => ({ otherDevice: undefined }));
      if (m.event === 'state') queueState(e.key, m.data);
      if (m.event === 'script_changed') void refreshScript(e.key);
      if (m.event === 'shows_changed') void refreshShows(e.key);
      if (m.event === 'params_changed') {
        // names, labels and roles may have changed: read the board's info again; an open settings form reloads
        patch(e.key, (b) => ({ paramsSeq: (b.paramsSeq || 0) + 1 }));
        void refreshFirmware(e.key);
      }
      const text = describe(m);
      if (text) patch(e.key, (b) => {
        const l = logLine(b, text);
        return { ...(l.text ? { log: [...b.log.slice(-199), { t: Date.now(), text: l.text }] } : {}), ...(l.soundQuiet !== undefined ? { soundQuiet: l.soundQuiet } : {}) };
      });
    }
  }), [patch, refreshFirmware, refreshScript, quiet, queueState]); // eslint-disable-line react-hooks/exhaustive-deps

  // boards the device layer already has (after a page reload), then the boards from last time
  useEffect(() => {
    void (async () => {
      const have: any[] = await call('connections').catch(() => []);
      for (const c of have) {
        if (c.key === 'checker') continue;
        // a board that is away right now is still shown (from its last info), offline, and comes back by itself
        const r = c.online ? await rpc(c.key, { op: 'info' }).catch(() => null) : null;
        const info = r?.ok ? r.result : c.info;
        if (!info) continue;
        await added(c.key, info, c.sim);
        if (!r?.ok) patch(c.key, () => ({ online: false }));
      }
      for (const a of prefsRef.current.boards) if (!have.some((c) => c.key === a)) void connect(a).catch(() => {});
    })();
  }, [connect, added]);

  // the device layer reads and writes files only inside the library folder it was told (S12)
  useEffect(() => { if (prefs.workspace) void call('workspace_set', { folder: prefs.workspace }).catch(() => {}); }, [prefs.workspace]);

  // a new workspace, release source or set of firmware lists from plugins: compare every board again (only a change
  // of the allowed firmware lists counts, not every plugin list or consent arriving)
  const firmwareLists = firmwarePlugins(plugins, prefs.pluginConsent).join(',');
  // a board seen for the first time: what it runs is remembered as it is (the Start fresh banner shows only for a
  // board that later runs another firmware or board package, freshStart.ts)
  const infoIds = Object.values(boards).map((b) => `${b.info?.id}|${b.info?.fw}|${b.info?.board}`).join(',');
  useEffect(() => {
    const next = noteFirstSeen(prefsRef.current.firmwareSeen || {}, Object.values(boards).filter((b) => !b.adapter).map((b) => b.info));
    if (next) setPrefs({ firmwareSeen: next });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [infoIds]);
  useEffect(() => {
    for (const k of Object.keys(boards)) {
      void refreshScript(k);
      void refreshFirmware(k);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefs.workspace, prefs.releases, prefs.betas, firmwareLists, libraryVersion]);

  const value = useMemo<Store>(() => ({
    prefs, setPrefs, boards, connect, connectSerial, startSim, remove, refreshScript, refreshFirmware, refreshShows, change, testOutput, askPin, pinFor,
    libraryVersion, bumpLibrary: () => setLibraryVersion((v) => v + 1), pinRequest, adapterDevices, adapterEvent, activity, logActivity, plugins, firmwareArgs,
  }), [plugins, firmwareArgs, adapterDevices, adapterEvent, activity, logActivity, prefs, setPrefs, boards, connect, connectSerial, startSim, remove, refreshScript, refreshFirmware, refreshShows, change, testOutput, askPin, pinFor, libraryVersion, pinRequest]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
