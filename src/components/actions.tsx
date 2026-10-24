// Board actions shared by the grid, the board page and the library: send an effect, save a board's script,
// update firmware, back up and restore. One message line and one "name it" dialog for all of them.
import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { Alert, Button, Stack, Dialog, DialogActions, DialogContent, DialogTitle, List, ListItemButton, ListItemText, TextField, Typography } from '@mui/material';
import { call, fileStampLocal, nowLocal, rpc } from '../api';
import { stopBoards } from '../stop';
import { saveNewEffect, scriptBody, takenNote } from '../library';
import { emptyScript, leaveNote, libraryNameFor } from '../scriptLinks';
import { chooseDestination, qualify } from '../scriptsRepo';
import { inFlight } from '../drafts';
import { useStore } from '../store';
import { pinBackoff } from '../pinwait';
import { supportsScripts } from '../words';
import { boardOf, freshWords } from '../firmware';
import { BoardDefaults, FRESH_BACK_WAIT_MS, FRESH_FIRST_WAIT_MS, hasDefaultsOp, keepValues, scriptQuestion, sigOf } from '../freshStart';
/** A board on USB: its key is this plus the port (core Studio::connect). */
const SERIAL = 'serial:';
import { AFTER_RESTART_LATER, restartWords, sendSetup, sendWhenBack, SetupError, takesPackages } from '../boardPackages';

type Msg = { tone: 'success' | 'error' | 'info' | 'warning'; text: string; action?: { label: string; run: () => void }; action2?: { label: string; run: () => void } } | null;
/** The phone page's words for Resume (firmware web/app.js). */
export const RESUME_NOTE = 'Resume lets the shows start again (nothing turns back on by itself).';
/** A window event: go to a line of an effect in its editor (detail: { name, line, col? }), from a board's refusal. */
export const GOTO_LINE = 'specter-goto-line';
export interface SendOptions { text?: string; gotoName?: string; replacesBoardScript?: boolean }
/** A board on USB moving to the generic image: the board package goes on in the same write (board_setup's
 * `package`, `profile`, `script`), and its name and Wi-Fi are given back afterwards. */
export interface UsbSwitch { setup: any; keep?: KeepNet }
/** Start fresh but give the board back its name and Wi-Fi network (the password typed again). */
export interface KeepNet { name?: string; ssid?: string; pass?: string }
/** board_setup's arguments (boardPackages.ts packageArg / fileArg). */
export interface SetupChoice { package: any; defaults: boolean; profile?: { plugin: string; file: string }; script?: { plugin: string; file: string } }
interface Actions {
  busy: Record<string, string>;
  message: Msg;
  clear: () => void;
  /** `asked`: the caller already asked about interrupting what runs (okToInterrupt). `opts.text`: send this text
   * (edited on the board's page) instead of the library's `name`; `name` may then be '' (not in the library) and
   * "Go to line" on a refusal goes to `opts.gotoName`. `opts.replacesBoardScript`: the person chose to replace
   * the board's own script (it is not kept in the library first). */
  sendEffect: (key: string, name: string, asked?: boolean, opts?: SendOptions) => Promise<boolean>;
  /** Asks first when any of these boards is running an effect or a show right now (sending would cut it off). */
  okToInterrupt: (keys: string[], what?: string) => Promise<boolean>;
  saveBoardScript: (key: string) => Promise<void>;
  /** Reads the board's script from the board and keeps it in Your library as a new effect (named after the effect or
   * the board, never over one already there; asks which script source when there are several). Returns the name it
   * got, with a note left for the effect's page, or null when nothing was saved (the message says why). */
  saveBoardScriptAsNew: (key: string) => Promise<string | null>;
  updateFirmware: (key: string, asked?: boolean) => Promise<string | null>; // 'valid', 'rolled_back', or null when it failed
  /** installs another firmware type (`fw`, named `name`) over Wi-Fi: the caller has asked the person (switchWords) */
  switchFirmware: (key: string, fw: string, name: string, usb?: UsbSwitch) => Promise<string | null>;
  /** asks (freshWords), then the board's factory_reset: it restarts with its firmware's own defaults (and, with
   * `forgetBoard`, without its stored board package) */
  startFresh: (key: string, typeName: string, forgetBoard?: boolean, keep?: KeepNet) => Promise<boolean>;
  /** after a change of firmware: the new firmware's own script (and profile) instead of the board's, its other
   * settings, Wi-Fi and name kept; the board's script is saved to the library first unless it is there unchanged */
  useDefaultScript: (key: string, typeName: string, d: BoardDefaults) => Promise<boolean>;
  /** puts a board package, profile and script on a board (board_setup's requests, one by one), then asks before
   * the restart that starts a new board package. `pkgName`: the chosen package's name for the question. */
  setupBoard: (key: string, choice: SetupChoice, pkgName?: string) => Promise<boolean>;
  backup: (key: string) => Promise<void>;
  restore: (key: string, path: string) => Promise<void>;
  askName: (title: string, initial?: string) => Promise<string | null>;
  pickEffect: (title: string) => Promise<string | null>;
  confirm: (title: string, text: string, yes: string) => Promise<boolean>;
  stop: (key: string) => Promise<void>;
  restart: (key: string) => Promise<void>;
  /** every board that is online: stopped together, with one message and one button to start them all again */
  stopAll: () => Promise<void>;
  /** `pause` off on these boards: shows start on their triggers again; nothing turns back on by itself */
  resume: (keys: string[]) => Promise<void>;
}
const Ctx = createContext<Actions>(null as any);
export const useBoardActions = () => useContext(Ctx);

export function ActionsProvider({ children }: { children: React.ReactNode }) {
  const store = useStore();
  const { prefs } = store;
  // the boards as they are now, read when an action runs: the actions stay the same functions while boards change
  // (every consumer of this context would re-render on every board state otherwise)
  const boardsRef = useRef(store.boards);
  boardsRef.current = store.boards;
  const [busy, setBusy] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<Msg>(null);
  const [confirmReq, setConfirmReq] = useState<{ title: string; text: string; yes: string; resolve: (v: boolean) => void } | null>(null);
  const confirm = useCallback((title: string, text: string, yes: string) => new Promise<boolean>((resolve) => setConfirmReq({ title, text, yes, resolve: (v) => { setConfirmReq(null); resolve(v); } })), []);
  const [effectReq, setEffectReq] = useState<{ title: string; list: any[]; resolve: (v: string | null) => void } | null>(null);
  const [nameReq, setNameReq] = useState<{ title: string; value: string; resolve: (v: string | null) => void } | null>(null);
  const nameOf = (key: string) => boardsRef.current[key]?.info?.name || key;

  const work = useCallback(async (key: string, what: string, f: () => Promise<void>) => {
    setBusy((b) => ({ ...b, [key]: what }));
    const id = `board:${key}:${Math.random()}`;
    inFlight.set(id, `${nameOf(key)}: ${what.replace(/….*$/, '').toLowerCase()}`);
    try {
      await f();
    } catch (e: any) {
      setMessage({ tone: 'error', text: `${nameOf(key)}: ${e.message || e}` });
    } finally {
      inFlight.delete(id);
      setBusy((b) => { const n = { ...b }; delete n[key]; return n; });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const askName = useCallback((title: string, initial = '') => new Promise<string | null>((resolve) => {
    setNameReq({ title, value: initial, resolve: (v) => { setNameReq(null); resolve(v); } });
  }), []);

  // a request that may need the page password: "pin: ..." from the device layer asks for it and tries again
  const withPin = useCallback(async <T,>(key: string, f: (pin?: string) => Promise<T>): Promise<T> => {
    try {
      return await f(await store.pinFor(key));
    } catch (e: any) {
      if (!String(e.message || e).startsWith('pin:')) throw e;
      const pin = await store.askPin(key);
      if (!pin) throw new Error('the board is locked: cancelled');
      return f(pin);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.askPin, store.pinFor]);

  // STOP: every output off at once and triggers ignored (pause), shows ended and manual tests released (stop_all),
  // tried without the page password first; locked boards that still want it are asked about once (stop.ts).
  // The board stays stopped until it is resumed (`pause` off, after the `stop_all` of STOP: nothing turns back on
  // by itself, PROTOCOL.md) or restarted. Resume is a change: it may ask for the page password.
  const resumeAll = useCallback(async (keys: string[]) => {
    const rs = await Promise.all(keys.map((k) => store.change(k, { op: 'pause', on: false }).catch((e: any) => ({ ok: false, error: { message: String(e.message || e) } }))));
    const bad = keys.filter((_, i) => !rs[i].ok);
    setMessage(bad.length ? { tone: 'error', text: bad.map((k) => `${nameOf(k)} did not resume: ${rs[keys.indexOf(k)].error?.message}`).join(' ') }
      : { tone: 'success', text: `${keys.length === 1 ? `${nameOf(keys[0])} is` : `${keys.length} boards are`} running again: shows start on their triggers. Nothing turned back on by itself.` });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.change]);
  const restartAll = useCallback(async (keys: string[]) => {
    const rs = await Promise.all(keys.map((k) => store.change(k, { op: 'reboot' }).catch((e: any) => ({ ok: false, error: { message: String(e.message || e) } }))));
    const bad = keys.filter((_, i) => !rs[i].ok);
    if (bad.length) {
      setMessage({ tone: 'error', text: bad.map((k) => `${nameOf(k)}: ${rs[keys.indexOf(k)].error?.message}`).join(' ') });
      return;
    }
    const waiting = keys.length === 1 ? `${nameOf(keys[0])} is restarting. It is ready again in a few seconds.` : `${keys.length} boards are restarting. They are ready again in a few seconds.`;
    setMessage({ tone: 'info', text: waiting });
    // back: online with a fresh uptime (the device layer reconnects as soon as the board answers again)
    const t0 = Date.now();
    const before = Object.fromEntries(keys.map((k) => [k, Number(boardsRef.current[k]?.state?.uptime_ms ?? Infinity)]));
    // a board is back when it answers again after the session dropped (a real board's restart), or with an uptime
    // below the one it had (a practice board restarts without dropping the session)
    const away = new Set<string>();
    const isBack = (k: string) => {
      const b = boardsRef.current[k];
      if (!b?.online) { away.add(k); return false; }
      const up = Number(b.state?.uptime_ms);
      return away.has(k) || (Number.isFinite(up) && (Number.isFinite(before[k]) ? up < before[k] : up < Date.now() - t0 + 2000));
    };
    while (Date.now() - t0 < 60_000 && !keys.map(isBack).every(Boolean)) await new Promise((r) => setTimeout(r, 100));
    const secs = Math.max(1, Math.round((Date.now() - t0) / 1000));
    const back = keys.filter(isBack);
    setMessage((m) => (m?.text !== waiting ? m : back.length === keys.length
      ? { tone: 'success', text: keys.length === 1 ? `${nameOf(keys[0])} is back (it restarted in ${secs} s).` : `All ${keys.length} boards are back (${secs} s).` }
      : { tone: 'warning', text: `${keys.filter((k) => !back.includes(k)).map(nameOf).join(', ')} did not come back within a minute. Check its power and its Wi-Fi; Studio keeps trying.` }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.change]);
  const halt = useCallback((keys: string[]) => stopBoards(keys, rpc, store.pinFor, (locked) => store.askPin(locked[0], locked.slice(1))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store.pinFor, store.askPin]);
  const stop = useCallback(async (key: string) => {
    const r1 = (await halt([key]))[key];
    setMessage(r1.ok ? { tone: 'warning', text: `${nameOf(key)} is stopped: everything is off and triggers are ignored. ${RESUME_NOTE} Or restart the board.`,
      action: { label: 'Resume', run: () => void resumeAll([key]) }, action2: { label: 'Restart it now', run: () => void restartAll([key]) } }
      : { tone: 'error', text: `${nameOf(key)} did not stop: ${r1.message}` });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [halt, restartAll, resumeAll]);
  const stopAll = useCallback(async () => {
    const keys = Object.values(boardsRef.current).filter((b) => b.online).map((b) => b.key);
    const rs = await halt(keys);
    const ok = keys.filter((k) => rs[k].ok);
    const bad = keys.filter((k) => !rs[k].ok).map((k) => `${nameOf(k)} did not stop: ${rs[k].message}`);
    const which = ok.length === 1 ? `${nameOf(ok[0])} is stopped` : ok.length === keys.length ? `All ${ok.length} boards are stopped` : `${ok.length} boards are stopped (${ok.map(nameOf).join(', ')})`;
    setMessage(!ok.length ? { tone: 'error', text: bad.join(' ') || 'No board is online.' }
      : { tone: bad.length ? 'error' : 'warning', text: `${which}: everything is off and triggers are ignored.${bad.length ? ' ' + bad.join(' ') : ''}`,
        action: { label: ok.length === 1 ? 'Resume' : 'Resume them all', run: () => void resumeAll(ok) },
        action2: { label: ok.length === 1 ? 'Restart it now' : 'Start them all again', run: () => void restartAll(ok) } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [halt, restartAll, resumeAll]);

  // the Restart button asks first: a restart cuts off whatever runs and drops the board for a few seconds
  const restart = useCallback(async (key: string) => {
    const running = runningOn(key);
    // a stopped board has nothing running: Restart is how it starts again, no question
    if (!boardsRef.current[key]?.state?.paused && !(await confirm(`Restart ${nameOf(key)}?`, `${running.length ? `${nameOf(key)} is running ${running.join(' and ')} right now; a restart stops it. ` : ''}The board is gone for a few seconds, then starts again with its settings, shows and effect script.`, 'Restart'))) return;
    await restartAll([key]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restartAll, confirm]);

  // "which effect?": the library's effects in a list
  const pickEffect = useCallback(async (title: string) => {
    const list = prefs.workspace ? await call('library_list', { folder: prefs.workspace }).catch(() => []) : [];
    return new Promise<string | null>((resolve) => setEffectReq({ title, list, resolve: (v) => { setEffectReq(null); resolve(v); } }));
  }, [prefs.workspace]);

  // what a board is doing right now that a new effect script, a restart or an upload would cut off
  const runningOn = (key: string): string[] => {
    const st = boardsRef.current[key]?.state;
    return [...(st?.script?.effects || []).filter((e: any) => e.running).map((e: any) => `the effect “${e.name}”`),
      ...(st?.shows || []).filter((x: any) => x.state === 'running').map((x: any) => `the show “${x.name}”`)];
  };
  const okToInterrupt = useCallback(async (keys: string[], what = 'Sending') => {
    const busyOnes = keys.filter((k) => runningOn(k).length);
    if (!busyOnes.length) return true;
    const lines = busyOnes.map((k) => `${nameOf(k)} is running ${runningOn(k).join(' and ')}`).join('; ');
    return confirm(busyOnes.length === 1 ? `Interrupt ${nameOf(busyOnes[0])}?` : `Interrupt ${busyOnes.length} boards?`,
      `${lines} right now. ${what} stops it.`, `${what.split(' ')[0]} anyway`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirm]);

  const sendEffect = useCallback(async (key: string, name: string, asked = false, opts: SendOptions = {}) => {
    const edit = opts.text !== undefined ? { text: opts.text, gotoName: opts.gotoName || name } : null;
    const b = boardsRef.current[key];
    const what = name ? `“${name}”` : 'the effect script';
    if (b && !supportsScripts(b)) {
      setMessage({ tone: 'warning', text: `${nameOf(key)} cannot run effect scripts yet. Update its firmware first.` });
      return false;
    }
    if (!asked && !(await okToInterrupt([key], `Sending ${what}`))) return false;
    let ok = false;
    await work(key, `Sending ${what}…`, async () => {
      // never lose work: an effect script on the board that is not in the library (or was changed there) is kept
      // in the library before the new one takes its place; not when the person is sending their own edit of it or
      // chose to replace it
      let kept = '';
      const st = b?.scriptStatus?.status;
      if (!edit && !opts.replacesBoardScript && b?.script?.text && (st === 'unknown' || st === 'changed')) {
        kept = (await saveNewEffect(prefs.workspace, `kept from ${nameOf(key)}`, b.script.text, { ask: false })).name;
        store.bumpLibrary();
      }
      const args = edit ? { key, folder: prefs.workspace, text: edit.text, now: nowLocal(), ...(name ? { name } : {}) } : { key, folder: prefs.workspace, name };
      let r = await call('send_script', { ...args, pin: await store.pinFor(key) });
      for (let i = 0; i < 3 && !r.ok && r.error?.code === 'pin'; i++) {
        const pin = await store.askPin(key);
        if (!pin) return;
        r = await pinBackoff(() => call('send_script', { ...args, pin }));
      }
      if (!r.ok) throw new Error(r.error?.message || 'the board refused');
      const c = r.result;
      if (!c.ok) {
        const first = c.errors?.[0];
        const goto = opts.gotoName || name;
        setMessage({ tone: 'error', text: `${nameOf(key)} did not take ${what}: ${first?.message || 'it has problems'}`,
          ...(first?.line > 0 ? { action: { label: `Go to line ${first.line}`, run: () => window.dispatchEvent(new CustomEvent(GOTO_LINE, { detail: { name: goto, line: first.line, col: first.col } })) } } : {}) });
        return;
      }
      ok = true;
      setMessage({ tone: 'success', text: `${name ? `“${name}”` : 'The effect script'} is on ${nameOf(key)} and running.${kept ? ` Its old effect script is kept in Your library as “${kept}”.` : ''}${c.warnings?.length ? ' Note: ' + c.warnings[0].message : ''}` });
      await store.refreshScript(key);
    });
    return ok;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefs.workspace, work, store.refreshScript, store.askPin, store.bumpLibrary, okToInterrupt]);

  const saveBoardScript = useCallback(async (key: string) => {
    const b = boardsRef.current[key];
    const text = b?.script?.text;
    if (!text) return;
    const typed = await askName(`Save ${nameOf(key)}'s effect script to your library`, b?.scriptStatus?.name || `${nameOf(key)} effect`);
    if (!typed) return;
    // a full "source/name" is kept; a plain name goes where new scripts go (scriptsRepo.ts)
    const name = typed.includes('/') ? typed : qualify(await chooseDestination(typed), typed);
    await work(key, 'Saving…', async () => {
      await call('library_save', { folder: prefs.workspace, name, text, now: nowLocal() });
      store.bumpLibrary();
      setMessage({ tone: 'success', text: `Saved “${name}” to your library.` });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefs.workspace, askName, work, store.bumpLibrary]);

  const saveBoardScriptAsNew = useCallback(async (key: string): Promise<string | null> => {
    if (!prefs.workspace) { setMessage({ tone: 'warning', text: 'Choose your library folder in Settings first.' }); return null; }
    let saved: string | null = null;
    await work(key, 'Saving its effect script to Your library…', async () => {
      const r = await rpc(key, { op: 'get_script' });
      if (!r.ok) throw new Error(r.error?.message || 'the board did not send its effect script');
      const text: string = r.result?.text || '';
      if (emptyScript(text)) { setMessage({ tone: 'info', text: `${nameOf(key)} has no effect script.` }); return; }
      const asked = libraryNameFor(text, nameOf(key));
      const got = await saveNewEffect(prefs.workspace, asked, scriptBody(text), { keepText: true });
      store.bumpLibrary();
      leaveNote(got.name, `Saved ${nameOf(key)}'s effect script to Your library as “${got.name}”.${got.renamed ? ' ' + takenNote(asked, got.name) : ''}`);
      saved = got.name;
    });
    return saved;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefs.workspace, work, store.bumpLibrary]);

  const updateFirmware = useCallback(async (key: string, asked = false) => {
    let outcome: string | null = null;
    if (!asked && !(await confirm(`Update the firmware of ${nameOf(key)}?`, 'The board restarts with the new firmware (a few minutes). Its settings and effects are kept, and it goes back to the old firmware by itself if the new one does not start.', 'Update'))) return null;
    await work(key, 'Updating firmware… (the board restarts; this can take a few minutes)', async () => {
      // no `fw`: the device layer takes the list of the type the board reports, and never switches type
      const r = await withPin(key, (pin) => call('update', { key, ...store.firmwareArgs(), pin, folder: prefs.workspace }));
      outcome = r.result;
      if (r.result === 'valid') setMessage({ tone: 'success', text: `${nameOf(key)} now runs firmware ${r.info.fw_version}.` });
      else setMessage({ tone: 'warning', text: `${nameOf(key)} could not start the new firmware and went back to the old one (${r.info.fw_version}). Nothing was lost.` });
      await store.refreshFirmware(key);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return outcome;
  }, [prefs.releases, prefs.workspace, work, withPin, store.refreshFirmware, store.firmwareArgs, confirm]);

  const startFresh = useCallback(async (key: string, typeName: string, forgetBoard = false, keep?: KeepNet) => {
    const b = boardsRef.current[key];
    const pkgs = takesPackages(b?.info);
    const name = nameOf(key);
    // firmware with get_defaults (capability `defaults`) also has factory_reset keep_wifi: the board keeps its name,
    // Wi-Fi network and password itself; older firmware gets them back from Studio afterwards (password typed again)
    const onBoard = !!keep && hasDefaultsOp(b?.info);
    const keeping = onBoard || (!!keep && keepValues(keep).length > 0);
    const w = freshWords(name, typeName, pkgs ? (forgetBoard ? 'forget' : 'keep') : undefined, onBoard ? 'board' : keeping);
    if (!(await confirm(w.title, w.text, 'Start fresh'))) return false;
    let ok = false;
    await work(key, 'Starting fresh…', async () => {
      // how to tell it restarted: its uptime starts again (asked now, not the last state shown), or its name went back
      const st0 = keeping ? await store.change(key, { op: 'state' }).catch(() => null) : null;
      const upBefore = Number(st0?.result?.uptime_ms ?? b?.state?.uptime_ms ?? Infinity);
      const r = await store.change(key, { op: 'factory_reset', ...(pkgs && forgetBoard ? { forget_board: true } : {}), ...(onBoard ? { keep_wifi: true } : {}) });
      if (!r?.ok) throw new Error(r?.error?.message || 'the board refused');
      ok = true;
      // what it runs now is what Studio has seen: no "this board now runs …" banner for it
      const sig = sigOf(b?.info);
      if (sig) store.setPrefs({ firmwareSeen: { ...(store.prefs.firmwareSeen || {}), [b.info.id]: sig } });
      const left = 'It has left your Wi-Fi: join its own Wi-Fi (“Proptroller-…”) or plug it in with USB to set it up again.';
      if (!keeping) {
        setMessage({ tone: 'success', text: `${name} restarts with the ${typeName} firmware's defaults. ${left}` });
        return;
      }
      // it comes back on its network (keep_wifi), or Studio gives it back its name and Wi-Fi once it answers again on
      // the same connection (USB, or a practice board)
      setBusy((x) => ({ ...x, [key]: onBoard ? 'Starting fresh… (it comes back on your Wi-Fi)' : 'Starting fresh… then giving it back its name and Wi-Fi' }));
      await new Promise((res) => setTimeout(res, FRESH_FIRST_WAIT_MS));
      const until = Date.now() + FRESH_BACK_WAIT_MS;
      let back = false;
      while (!back && Date.now() < until) {
        const st = await store.change(key, { op: 'state' }).catch(() => null);
        const inf = st?.ok ? await store.change(key, { op: 'info' }).catch(() => null) : null;
        back = !!st?.ok && (!Number.isFinite(upBefore) || Number(st.result?.uptime_ms) < upBefore || (!onBoard && !!inf?.ok && inf.result?.name !== name));
        if (!back) await new Promise((res) => setTimeout(res, 500));
      }
      if (onBoard) {
        setMessage(back ? { tone: 'success', text: `${name} started fresh with the ${typeName} firmware's defaults and kept its name and Wi-Fi.` }
          : { tone: 'info', text: `${name} restarts with the ${typeName} firmware's defaults and keeps its name and Wi-Fi: it comes back on your network by itself.` });
        return;
      }
      if (!back) {
        setMessage({ tone: 'warning', text: `${name} restarts with the ${typeName} firmware's defaults. ${left} Then set its name (${keep!.name || 'unnamed'})${keep!.ssid ? ` and Wi-Fi (${keep!.ssid})` : ''} again in Settings.` });
        return;
      }
      const p = await store.change(key, { op: 'set_params', values: keepValues(keep!) });
      if (!p?.ok) throw new Error(`it started fresh, but did not take its name and Wi-Fi back: ${p?.error?.message || 'it gave no reason'}`);
      setMessage({ tone: 'success', text: `${name} started fresh with the ${typeName} firmware's defaults and kept its name${keep!.ssid ? ' and Wi-Fi' : ''}.` });
    });
    return ok;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [work, confirm, store.change, store.setPrefs, store.prefs.firmwareSeen]);

  const useDefaultScript = useCallback(async (key: string, typeName: string, d: BoardDefaults) => {
    const q = scriptQuestion(d, typeName);
    if (!q) return false;
    const b = boardsRef.current[key];
    let ok = false;
    await work(key, `Putting ${typeName}'s script on…`, async () => {
      // nothing is lost: the board's script goes to the library first, unless it is there unchanged
      let kept = '';
      const st = b?.scriptStatus?.status;
      if (b?.script?.text && (st === 'unknown' || st === 'changed' || !st)) {
        kept = (await saveNewEffect(prefs.workspace, `kept from ${nameOf(key)}`, b.script.text, { ask: false })).name;
        store.bumpLibrary();
      }
      const r = await store.change(key, { op: 'apply_defaults', only: q.only });
      if (!r?.ok) throw new Error(`the board did not take ${typeName}'s script: ${r?.error?.message || 'it gave no reason'}`);
      ok = true;
      const sig = sigOf(b?.info);
      if (sig) store.setPrefs({ firmwareSeen: { ...(store.prefs.firmwareSeen || {}), [b.info.id]: sig } });
      const refused: string[] = r.result?.refused || [];
      const where = kept ? ` Its old script is kept in Your library as “${kept}”.` : st === 'current' ? ' Its old script is in Your library already.' : '';
      setMessage({ tone: refused.length ? 'warning' : 'success', text: `${nameOf(key)} now runs ${typeName}'s script${d.script_name ? ` “${d.script_name}”` : ''}${q.also}. Its other settings, Wi-Fi and name are kept.${where}${refused.length ? ` Not taken: ${refused.join(' ')}` : ''}` });
      await store.refreshScript(key);
    });
    return ok;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [work, prefs.workspace, store.change, store.setPrefs, store.prefs.firmwareSeen, store.refreshScript, store.bumpLibrary]);

  const setupBoard = useCallback(async (key: string, choice: SetupChoice, pkgName?: string) => {
    let restart = false;
    let ok = false;
    let after: any[] = [];
    await work(key, 'Sending…', async () => {
      const plan = await call('board_setup', { ...store.firmwareArgs(), ...choice });
      after = plan.after_restart || [];
      if (!plan.requests.length) throw new Error('nothing to send: choose a board package, a profile or a script');
      let r;
      try {
        r = await sendSetup((req) => store.change(key, req), plan.requests, (doing) => setBusy((b) => ({ ...b, [key]: doing })));
      } catch (e: any) {
        // the board package went on before a later part was refused: its restart is still asked
        restart = e instanceof SetupError && e.sent.includes('set_board');
        throw e;
      }
      ok = true;
      restart = plan.restart_needed;
      const notes = r.warnings.length ? ` Note: ${r.warnings.join(' ')}` : '';
      setMessage({ tone: r.warnings.length ? 'warning' : 'success', text: `${nameOf(key)} has ${restart ? `the board package${r.name ? ` “${r.name}”` : ''}` : 'it'} stored.${notes}` });
      await store.refreshScript(key);
    });
    if (!restart) return ok;
    const w = restartWords(nameOf(key), pkgName);
    if (await confirm(w.title, w.text, w.yes)) {
      await restartAll([key]);
      // the profile and script that the package's defaults would have replaced at that boot
      if (ok && after.length) {
        await work(key, 'Sending the profile and script…', async () => {
          if (!(await sendWhenBack((req) => store.change(key, req), after, (doing) => setBusy((b) => ({ ...b, [key]: doing })))))
            throw new Error(`it did not answer after the restart. ${AFTER_RESTART_LATER}`);
          setMessage({ tone: 'success', text: `${nameOf(key)} restarted with the new board package and has your profile and script.` });
          await store.refreshScript(key);
        });
      }
    } else if (ok) setMessage({ tone: 'info', text: `${nameOf(key)} keeps its old pins until it restarts. Use Restart when you are ready.${after.length ? ` ${AFTER_RESTART_LATER}` : ''}` });
    return ok;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [work, confirm, restartAll, store.change, store.firmwareArgs, store.refreshScript]);

  // a board on USB (its key is "serial:<port>"): the new image goes on through the port, never over Wi-Fi
  const switchFirmwareUsb = useCallback(async (key: string, fw: string, name: string, opts?: UsbSwitch) => {
    const port = key.slice(SERIAL.length);
    const info = boardsRef.current[key]?.info || {};
    let outcome: string | null = null;
    if (info.mcu !== 'esp32-devkit') {
      setMessage({ tone: 'info', text: `${nameOf(key)} takes new firmware through its BOOTSEL drive: hold BOOTSEL while you plug it in, then use Add a board > Put firmware on a new board (USB).` });
      return null;
    }
    await work(key, `Installing the ${name} firmware over USB… (this takes a minute or two)`, async () => {
      // its settings to a file first (another firmware keeps its settings its own way)
      const saved = await call('backup', { key, folder: prefs.backups, now: fileStampLocal() }).catch(() => '');
      // the device layer closes Studio's session on the port before it writes, then the board starts the new firmware
      // with a board package: in the same write (a file system holding it), so the board never runs another pin map
      const r = await call('usb_install', { ...store.firmwareArgs(), fw, board: boardOf(info), mcu: info.mcu, port, confirm: true, ...(opts ? { setup: opts.setup } : {}) });
      outcome = 'valid';
      let back = '';
      for (let i = 0; i < 10 && !back; i++) back = await store.connectSerial(port).catch(async () => { await new Promise((ok) => setTimeout(ok, 1000)); return ''; });
      const where = back ? '' : ' Plug it in again and use “Plugged in with USB” to see it here.';
      // a profile or script that did not fit beside the package, then its name and Wi-Fi back
      let notes = '';
      if (back && Array.isArray(r.send_after) && r.send_after.length) {
        await sendSetup((req) => store.change(back, req), r.send_after);
      }
      const values = opts?.keep ? keepValues(opts.keep) : [];
      if (back && values.length) {
        const p = await store.change(back, { op: 'set_params', values });
        notes = p?.ok ? ` It kept its name${opts!.keep!.ssid ? ' and Wi-Fi' : ''}.` : ` It did not take its name and Wi-Fi back (${p?.error?.message || 'no reason given'}): set them in Settings.`;
      }
      const pkg = r.board_package ? ` with the board package “${r.board_package}”` : '';
      setMessage({ tone: 'success', text: `${nameOf(key)} now has the ${r.type_name} firmware ${r.version}${pkg}.${notes}${saved ? ' Its old settings are saved in your backups folder.' : ''}${where}`,
        ...(back ? { action: { label: "Start fresh with this firmware's defaults…", run: () => { void startFresh(back, name); } } } : {}) });
    });
    return outcome;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefs.backups, work, store.firmwareArgs, store.connectSerial]);

  const switchFirmware = useCallback(async (key: string, fw: string, name: string, usb?: UsbSwitch) => {
    if (key.startsWith(SERIAL)) return switchFirmwareUsb(key, fw, name, usb);
    let outcome: string | null = null;
    await work(key, `Installing the ${name} firmware… (the board restarts; this can take a few minutes)`, async () => {
      const r = await withPin(key, (pin) => call('update', { key, ...store.firmwareArgs(), fw, switch_type: true, pin, folder: prefs.workspace, backups: prefs.backups, now: fileStampLocal() }));
      outcome = r.result;
      const saved = r.backup ? ' Its old settings are saved in your backups folder.' : '';
      if (r.result !== 'valid') setMessage({ tone: 'warning', text: `${nameOf(key)} could not start the ${name} firmware and went back to its old firmware (${r.info?.fw_version}). Nothing was lost.` });
      else if (r.info?.fw && r.info.fw !== fw) setMessage({ tone: 'warning', text: `${nameOf(key)} took the new firmware (${r.info.fw_version}) but still reports the “${r.info.fw}” firmware type.${saved}` });
      // the new firmware's own defaults apply only on a fresh board: offered, never done by itself
      else setMessage({ tone: 'success', text: `${nameOf(key)} now runs the ${name} firmware ${r.info?.fw_version}.${saved}`,
        action: { label: "Start fresh with this firmware's defaults…", run: () => { void startFresh(key, name); } } });
      await store.refreshFirmware(key);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return outcome;
  }, [prefs.workspace, prefs.backups, work, withPin, store.refreshFirmware, store.firmwareArgs, startFresh, switchFirmwareUsb]);

  const backup = useCallback(async (key: string) => {
    await work(key, 'Backing up…', async () => {
      const path = await call('backup', { key, folder: prefs.backups, now: fileStampLocal() });
      setMessage({ tone: 'success', text: prefs.advanced ? `Backed up ${nameOf(key)} to ${path}` : `Backed up ${nameOf(key)} to your backups folder (${prefs.backups}).` });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefs.backups, prefs.advanced, work]);

  const restore = useCallback(async (key: string, path: string) => {
    if (!(await confirm(`Restore ${nameOf(key)} from this backup?`, "This replaces the board's settings, shows and effect script with the ones in the backup. Its Wi-Fi and page lock stay as they are.", 'Restore'))) return;
    await work(key, 'Restoring…', async () => {
      const r = await withPin(key, (pin) => call('restore', { key, path, pin }));
      setMessage({ tone: 'success', text: `Restored ${nameOf(key)}.${r.skipped?.length ? ` Not restored (this board does not have them): ${r.skipped.join(', ')}.` : ''}` });
      await store.refreshScript(key);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [work, withPin, store.refreshScript, confirm]);

  const clear = useCallback(() => setMessage(null), []);
  const value = useMemo(() => ({ busy, message, clear, sendEffect, okToInterrupt, saveBoardScript, saveBoardScriptAsNew, updateFirmware, switchFirmware, startFresh, setupBoard, useDefaultScript, backup, restore, askName, pickEffect, confirm, stop, restart, stopAll, resume: resumeAll }),
    [busy, message, clear, sendEffect, okToInterrupt, saveBoardScript, saveBoardScriptAsNew, updateFirmware, switchFirmware, startFresh, setupBoard, useDefaultScript, backup, restore, askName, pickEffect, confirm, stop, restart, stopAll, resumeAll]);

  return (
    <Ctx.Provider value={value}>
      {children}
      {confirmReq && (
        <Dialog open onClose={() => confirmReq.resolve(false)} fullWidth maxWidth="sm">
          <DialogTitle>{confirmReq.title}</DialogTitle>
          <DialogContent><Typography>{confirmReq.text}</Typography></DialogContent>
          <DialogActions>
            <Button onClick={() => confirmReq.resolve(false)} autoFocus>Cancel</Button>
            <Button variant="contained" color="warning" onClick={() => confirmReq.resolve(true)}>{confirmReq.yes}</Button>
          </DialogActions>
        </Dialog>
      )}
      {effectReq && (
        <Dialog open onClose={() => effectReq.resolve(null)} fullWidth maxWidth="sm">
          <DialogTitle>{effectReq.title}</DialogTitle>
          <DialogContent>
            {effectReq.list.length === 0 && <Typography>Your library has no effects yet.</Typography>}
            <List component="div" aria-label="Effects in your library">
              {effectReq.list.map((e) => <ListItemButton key={e.name} onClick={() => effectReq.resolve(e.name)}><ListItemText primary={e.name} secondary={e.saved ? `saved ${e.saved}` : undefined} /></ListItemButton>)}
            </List>
          </DialogContent>
          <DialogActions><Button onClick={() => effectReq.resolve(null)}>Cancel</Button></DialogActions>
        </Dialog>
      )}
      {nameReq && (
        <Dialog open onClose={() => nameReq.resolve(null)} fullWidth maxWidth="sm">
          <form onSubmit={(e) => { e.preventDefault(); nameReq.resolve(nameReq.value.trim() || null); }}>
            <DialogTitle>{nameReq.title}</DialogTitle>
            <DialogContent>
              <Typography variant="body2" color="text.secondary" gutterBottom>Any name you like, for example “lamp and prop - lab room 1”.</Typography>
              <TextField autoFocus fullWidth label="Name" value={nameReq.value} onChange={(e) => setNameReq({ ...nameReq, value: e.target.value })} />
            </DialogContent>
            <DialogActions>
              <Button onClick={() => nameReq.resolve(null)}>Cancel</Button>
              <Button type="submit" variant="contained" disabled={!nameReq.value.trim()}>Save</Button>
            </DialogActions>
          </form>
        </Dialog>
      )}
    </Ctx.Provider>
  );
}

/** The last board action's message, with its button (for example "Start them all again" after a stop). */
export function ActionMessage() {
  const act = useBoardActions();
  const m = act.message;
  if (!m) return null;
  return <Alert severity={m.tone} onClose={act.clear} data-testid="action-message"
    action={(m.action || m.action2) && <Stack direction="row" spacing={1}>
      {[m.action, m.action2].filter((a) => !!a).map((a) => <Button key={a!.label} color="inherit" size="small" onClick={() => { act.clear(); a!.run(); }}>{a!.label}</Button>)}
    </Stack>}>{m.text}</Alert>;
}
