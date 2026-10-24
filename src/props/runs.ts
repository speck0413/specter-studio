// What each board is running now, for the board cards' run bar and the Dashboard's trigger flash. Kept by the
// board's name as the MQTT topics have it (topicLabel), so a board Studio talks to directly and one that only
// reports over MQTT are one entry. Fed by PropRunsWork from what boards already send:
//   * a `run` event (PROTOCOL.md "Events"): a run started: `kind` script (an effect of the show script, `name`),
//     show (`name`) or effect (the built-in effect). Only these flash: never a state read after a reconnect.
//   * the state (direct boards up to 5 times a second, MQTT `<p>/state` at most once a second): `script.effects`
//     with `running`, `shows` with `state`/`elapsed_ms`/`length_ms`: when a run ends, or one that started before
//     Studio was listening.
import { useSyncExternalStore } from 'react';
import { nameKey } from './look';

export type RunKind = 'script' | 'show' | 'effect';
export interface Run { kind: RunKind; name: string; started: number; /** the board's own length (shows) */ lengthMs?: number; seq: number }
export interface Flash { kind: RunKind; name: string; at: number; seq: number }

/** How long after a run starts a state that does not show it yet is ignored (the state may be older than the run
 * event; MQTT states come at most once a second). */
export const START_GRACE_MS = 1200;
/** A run with no end in sight is let go after this long (a board that stopped reporting its state). */
export const RUN_CAP_MS = 15 * 60_000;
/** How long the trigger flash covers a card. */
export const FLASH_MS = 1200;

const statusOn = (st: any, k: string) => (Array.isArray(st?.status) ? st.status.some((s: any) => s?.key === k && (s.value === true || s.value === 1 || s.value === 'true')) : false);

/** What a board's state says runs: the effects of its script, its shows, the built-in effect. */
export function runningIn(st: any): { kind: RunKind; name: string; lengthMs?: number; elapsedMs?: number }[] {
  const out: { kind: RunKind; name: string; lengthMs?: number; elapsedMs?: number }[] = [];
  for (const e of Array.isArray(st?.script?.effects) ? st.script.effects : []) if (e?.running) out.push({ kind: 'script', name: String(e.name ?? '') });
  for (const s of Array.isArray(st?.shows) ? st.shows : []) {
    if (s?.state === 'running') out.push({ kind: 'show', name: String(s.name ?? s.id ?? ''), lengthMs: typeof s.length_ms === 'number' && s.length_ms > 0 ? s.length_ms : undefined, elapsedMs: typeof s.elapsed_ms === 'number' ? s.elapsed_ms : undefined });
  }
  if (!st?.script?.effects?.length && (statusOn(st, 'pulsing') || statusOn(st, 'recovering'))) out.push({ kind: 'effect', name: 'pulse_and_recover' });
  return out;
}

const same = (a: { kind: RunKind; name: string }, b: { kind: RunKind; name: string }) => a.kind === b.kind && nameKey(a.name) === nameKey(b.name);

export class RunTracker {
  runs: Record<string, Run | undefined> = {};
  flashes: Record<string, Flash | undefined> = {};
  private seq = 0;
  private listeners = new Set<() => void>();
  private version = 0;
  subscribe = (f: () => void) => { this.listeners.add(f); return () => { this.listeners.delete(f); }; };
  getVersion = () => this.version;
  private changed() { this.version++; for (const f of this.listeners) f(); }

  /** A `run` event's data: the run starts now, and the card flashes. */
  runEvent(label: string, d: any, now: number) {
    if (!d || typeof d !== 'object') return;
    const kind: RunKind = d.kind === 'script' ? 'script' : d.kind === 'effect' ? 'effect' : 'show';
    const name = String(d.name ?? d.show ?? '');
    const seq = ++this.seq;
    this.runs = { ...this.runs, [label]: { kind, name, started: now, seq } };
    this.flashes = { ...this.flashes, [label]: { kind, name, at: now, seq } };
    this.changed();
  }

  /** A board's state: ends the run it no longer shows, takes a show's own length, and starts (without a flash) a run
   * that began before Studio heard of it. */
  noteState(label: string, st: any, now: number) {
    if (!st || typeof st !== 'object') return;
    const on = runningIn(st);
    const cur = this.runs[label];
    let next: Run | undefined = cur;
    if (cur) {
      const still = on.find((r) => same(r, cur)) || (cur.kind === 'show' && !cur.name ? on.find((r) => r.kind === 'show') : undefined);
      // a firmware whose state says nothing about scripts cannot end a script run: the cap does
      const silent = cur.kind === 'script' && !Array.isArray(st.script?.effects);
      if (still) {
        if (still.lengthMs !== undefined && (cur.lengthMs !== still.lengthMs || still.elapsedMs !== undefined)) {
          next = { ...cur, lengthMs: still.lengthMs, started: still.elapsedMs !== undefined ? Math.min(cur.started, now - still.elapsedMs) : cur.started };
        }
      } else if ((!silent && now - cur.started > START_GRACE_MS) || now - cur.started > RUN_CAP_MS) {
        next = undefined;
      }
    }
    if (!next && on.length && !(cur && now - cur.started <= START_GRACE_MS)) {
      const r = on[on.length - 1];
      next = { kind: r.kind, name: r.name, started: now - (r.elapsedMs || 0), lengthMs: r.lengthMs, seq: ++this.seq };
    }
    if (next === cur) return;
    this.runs = { ...this.runs, [label]: next };
    this.changed();
  }

  /** Lets go of a board's run (it went offline, or was removed). */
  forget(label: string) {
    if (!this.runs[label]) return;
    this.runs = { ...this.runs, [label]: undefined };
    this.changed();
  }
}

export const runs = new RunTracker();

/** Re-renders when any board's run starts, ends or flashes. */
export function useRuns(): RunTracker {
  useSyncExternalStore(runs.subscribe, runs.getVersion);
  return runs;
}
