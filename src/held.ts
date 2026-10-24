// Outputs Studio turned on for a test ("Hold to test", Record effect): which ones are held right now, and the
// let-go requests that did not reach the board. A let-go that fails (the connection dropped for a moment, the
// board did not answer) is owed: it is sent again when the board is back online and every second until the
// board takes it, so a short drop never leaves an output on. Older firmware does not let go of manual outputs
// when the session closes; newer firmware does, and a second let-go does no harm.
import type { Envelope } from './api';

export type Send = (key: string, req: Record<string, unknown>) => Promise<Envelope>;

const held = new Map<string, Set<string>>();
const owed = new Map<string, Set<string>>();
const letGoAt = new Map<string, number>(); // `${key}|${channel}` -> when Studio let go (the board's state follows a moment later)
/** How long after a let-go the board's state may still show the output on without it counting as left on. */
export const SETTLE_MS = 2000;
const listeners = new Set<() => void>();
let retry: ReturnType<typeof setInterval> | undefined;
let sender: Send | null = null;

const set = (m: Map<string, Set<string>>, key: string) => { let s = m.get(key); if (!s) m.set(key, (s = new Set())); return s; };
const changed = () => listeners.forEach((l) => l());

/** Called after every change (the "still on from a test" note re-checks). */
export function onHeldChanged(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; }

/** True while Studio itself holds that output on (a test button is down, a recording drives it). */
export function isHeld(key: string, channel: string) {
  return !!held.get(key)?.has(channel.toUpperCase());
}

/** True for a moment after a let-go that reached the board: its next state still says on, which is no news. */
export function settling(key: string, channel: string, now = Date.now()) {
  const ch = channel.toUpperCase();
  const t = letGoAt.get(`${key}|${ch}`);
  return t !== undefined && now - t < SETTLE_MS && !owed.get(key)?.has(ch);
}
export function owedReleases(key: string): string[] {
  return [...(owed.get(key) || [])];
}

/** Turns an output on for a test and remembers it. */
export async function holdOutput(send: Send, key: string, channel: string, level = 1000): Promise<Envelope> {
  const ch = channel.toUpperCase();
  set(held, key).add(ch);
  owed.get(key)?.delete(ch);
  changed();
  return send(key, { op: 'set_output', channel: ch, level });
}

async function sendRelease(send: Send, key: string, ch: string): Promise<boolean> {
  const r = await send(key, { op: 'set_output', channel: ch, level: null }).catch(() => null);
  // a refused let-go is owed too (page password, a board that did not answer); anything but ok is tried again
  return !!r?.ok;
}

/** Lets go of a test output; a let-go that does not reach the board is sent again until it does. */
export async function releaseOutput(send: Send, key: string, channel: string): Promise<boolean> {
  const ch = channel.toUpperCase();
  held.get(key)?.delete(ch);
  letGoAt.set(`${key}|${ch}`, Date.now());
  setTimeout(changed, SETTLE_MS + 50); // look again once the board's state has had time to follow
  changed();
  const ok = await sendRelease(send, key, ch);
  if (!ok && !isHeld(key, ch)) {
    set(owed, key).add(ch);
    sender = send;
    startRetry();
    changed();
  }
  return ok;
}

/** Sends every owed let-go for a board again (it just came back online). */
export async function flushOwed(send: Send, key: string) {
  for (const ch of owedReleases(key)) {
    if (isHeld(key, ch)) continue;
    if (await sendRelease(send, key, ch)) owed.get(key)?.delete(ch);
  }
  if (!owed.get(key)?.size) owed.delete(key);
  changed();
}

function startRetry() {
  if (retry) return;
  retry = setInterval(() => {
    if (!owed.size) { clearInterval(retry); retry = undefined; return; }
    for (const k of [...owed.keys()]) void flushOwed(sender!, k);
  }, 1000);
}

/** The board is gone from Studio: nothing more to send it. */
export function forgetBoard(key: string) {
  held.delete(key);
  owed.delete(key);
  changed();
}

/** Tests only. */
export function resetHeld() {
  held.clear(); owed.clear(); letGoAt.clear();
  if (retry) clearInterval(retry);
  retry = undefined;
}
