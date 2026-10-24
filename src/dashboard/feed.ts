// The Dashboard's live feed and what it knows about each board's runs, kept while Studio runs (DashboardWork
// fills it from every board, the Dashboard, the board cards and the board page read it), and written to the
// library one file per show night (core nightlog.rs; which night: nights.ts).
import { useSyncExternalStore } from 'react';
import type { FeedEvent } from './events';
import { placeEvent, type NightCursor } from './nights';

/** The newest events kept in memory for the feed (the night files keep everything). */
export const FEED_MAX = 2000;
/** Events are written to the night file this often (and when the window closes). */
export const FEED_FLUSH_MS = 2000;

export interface LastRun { at: number; uptime?: number }

type Writer = (night: string, events: FeedEvent[]) => Promise<void>;

export class Feed {
  events: FeedEvent[] = [];
  /** the last run per board (by topic label): when Studio heard it, and the board's uptime then */
  lastRun: Record<string, LastRun> = {};
  cursor: NightCursor | null = null;
  private listeners = new Set<() => void>();
  private pending = new Map<string, FeedEvent[]>();
  private version = 0;
  writer: Writer | null = null;

  subscribe = (f: () => void) => { this.listeners.add(f); return () => { this.listeners.delete(f); }; };
  getVersion = () => this.version;
  private changed() { this.version++; for (const f of this.listeners) f(); }

  /** A new event: into the feed, the board's last run, and the night file's queue. */
  add(e: FeedEvent, label?: string, runUptime?: number) {
    this.events = [...this.events.slice(-(FEED_MAX - 1)), e];
    if (e.type === 'run' && label) this.lastRun = { ...this.lastRun, [label]: { at: e.t, uptime: runUptime } };
    const p = placeEvent(this.cursor, e.t, e.type === 'run');
    this.cursor = p.cursor;
    if (this.writer) {
      const q = this.pending.get(p.night) || [];
      q.push(e);
      this.pending.set(p.night, q);
    }
    this.changed();
  }

  /** A board's state: when it reports a run Studio has not heard about (it ran while Studio was closed, or before
   * the board was added), its time is worked out from the board's uptime. */
  noteState(label: string, state: any, now: number) {
    const last = state?.last_run_uptime_ms, up = state?.uptime_ms;
    if (typeof last !== 'number' || last < 0 || typeof up !== 'number') return;
    const known = this.lastRun[label];
    if (known && known.uptime === last) return;
    if (known && known.uptime === undefined && now - known.at < 2000) { this.lastRun = { ...this.lastRun, [label]: { ...known, uptime: last } }; return; }
    this.lastRun = { ...this.lastRun, [label]: { at: now - Math.max(0, up - last), uptime: last } };
    this.changed();
  }

  clear() { this.events = []; this.changed(); }

  /** Writes what is queued (each night's events in one append). */
  async flush() {
    if (!this.writer || !this.pending.size) return;
    const all = [...this.pending.entries()];
    this.pending.clear();
    for (const [night, evs] of all) await this.writer(night, evs).catch(() => { /* the library folder is away: the feed still shows them */ });
  }
}

export const feed = new Feed();

/** Re-renders on every feed change. */
export function useFeed(): Feed {
  useSyncExternalStore(feed.subscribe, feed.getVersion);
  return feed;
}
