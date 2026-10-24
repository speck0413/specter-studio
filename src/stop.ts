// STOP for one board or many: every output off and triggers ignored (`pause` on), shows ended and manual tests
// released (`stop_all`). Stopping is tried without the page password first (newer firmware never asks for it);
// boards that still want it are tried with a password Studio already knows, and only the ones left are asked
// about, all in one question. A board counts as stopped only when both requests were taken.
import type { Envelope } from './api';
import { pinBackoff } from './pinwait';

export type StopRpc = (key: string, req: Record<string, unknown>) => Promise<Envelope>;
export interface StopResult { ok: boolean; message?: string; locked?: boolean }

const failed = (e: unknown): Envelope => ({ ok: false, error: { code: 'failed', message: String((e as any)?.message || e) } });

async function both(rpc: StopRpc, key: string, pin?: string): Promise<[Envelope, Envelope]> {
  const p = pin ? { pin } : {};
  // pause first: from that moment triggers are ignored and outputs are off, even if stop_all is refused
  // a try right after a wrong password waits as long as the board says (newer firmware), then goes again
  const a = await pinBackoff(() => rpc(key, { op: 'pause', on: true, ...p }).catch(failed));
  const b = await pinBackoff(() => rpc(key, { op: 'stop_all', ...p }).catch(failed));
  return [a, b];
}
const wantsPin = ([a, b]: [Envelope, Envelope]) => a.error?.code === 'pin' || b.error?.code === 'pin';
const result = ([a, b]: [Envelope, Envelope]): StopResult =>
  a.ok && b.ok ? { ok: true } : { ok: false, locked: wantsPin([a, b]), message: (!a.ok ? a.error?.message : b.error?.message) || 'the board did not answer' };

/**
 * Stops every board in `keys` at once. `knownPin` gives a password Studio already has (typed this session or
 * remembered); `ask` asks the person once for the boards still locked (null = cancelled).
 */
export async function stopBoards(keys: string[], rpc: StopRpc, knownPin: (key: string) => Promise<string | undefined>,
  ask: (locked: string[]) => Promise<string | null>): Promise<Record<string, StopResult>> {
  const out: Record<string, StopResult> = {};
  const first = await Promise.all(keys.map((k) => both(rpc, k)));
  let locked: string[] = [];
  keys.forEach((k, i) => { if (wantsPin(first[i])) locked.push(k); else out[k] = result(first[i]); });
  if (locked.length) {
    const tries = await Promise.all(locked.map(async (k) => { const pin = await knownPin(k).catch(() => undefined); return pin ? both(rpc, k, pin) : null; }));
    const still: string[] = [];
    locked.forEach((k, i) => { const t = tries[i]; if (t && !wantsPin(t)) out[k] = result(t); else still.push(k); });
    locked = still;
  }
  if (locked.length) {
    const pin = await ask(locked);
    if (!pin) for (const k of locked) out[k] = { ok: false, locked: true, message: 'the board is locked and the page password was not given' };
    else {
      const tries = await Promise.all(locked.map((k) => both(rpc, k, pin)));
      locked.forEach((k, i) => {
        out[k] = wantsPin(tries[i]) ? { ok: false, locked: true, message: 'that page password is not this board\'s' } : result(tries[i]);
      });
    }
  }
  return out;
}
