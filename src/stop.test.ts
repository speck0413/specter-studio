import { describe, expect, it } from 'vitest';
import { stopBoards, StopRpc } from './stop';

// a fake fleet: each board has a password (or none) and may need it for stopping (old firmware) or not (new)
function fleet(boards: Record<string, { pin?: string; stopNeedsPin?: boolean; down?: boolean; refuseStopAll?: boolean }>) {
  const log: string[] = [];
  const state: Record<string, { paused: boolean; stopped: boolean }> = {};
  const rpc: StopRpc = async (key, req) => {
    const b = boards[key];
    log.push(`${key} ${req.op}${req.pin ? ' pin=' + req.pin : ''}`);
    if (b.down) throw new Error('the board is not connected');
    if (b.pin && b.stopNeedsPin && req.pin !== b.pin) return { ok: false, error: { code: 'pin', message: 'locked' } };
    if (req.op === 'stop_all' && b.refuseStopAll) return { ok: false, error: { code: 'internal', message: 'no' } };
    state[key] ||= { paused: false, stopped: false };
    if (req.op === 'pause') state[key].paused = true;
    if (req.op === 'stop_all') state[key].stopped = true;
    return { ok: true, result: { kind: 'done' } };
  };
  return { rpc, log, state };
}

describe('stopBoards', () => {
  it('stops boards whose firmware never asks for the password without asking', async () => {
    const f = fleet({ a: { pin: 'x' }, b: {} });
    let asked = 0;
    const r = await stopBoards(['a', 'b'], f.rpc, async () => undefined, async () => { asked++; return null; });
    expect(r).toEqual({ a: { ok: true }, b: { ok: true } });
    expect(asked).toBe(0);
    expect(f.log.every((l) => !l.includes('pin='))).toBe(true);
  });

  it('three locked boards: one question, every board stopped with the same password', async () => {
    const f = fleet({ a: { pin: 'pw', stopNeedsPin: true }, b: { pin: 'pw', stopNeedsPin: true }, c: { pin: 'pw', stopNeedsPin: true } });
    const questions: string[][] = [];
    const r = await stopBoards(['a', 'b', 'c'], f.rpc, async () => undefined, async (locked) => { questions.push(locked); return 'pw'; });
    expect(questions).toEqual([['a', 'b', 'c']]);
    for (const k of ['a', 'b', 'c']) {
      expect(r[k].ok).toBe(true);
      expect(f.state[k]).toEqual({ paused: true, stopped: true });
    }
  });

  it('uses a known password before asking, and asks only about the rest', async () => {
    const f = fleet({ a: { pin: 'one', stopNeedsPin: true }, b: { pin: 'two', stopNeedsPin: true } });
    const questions: string[][] = [];
    const r = await stopBoards(['a', 'b'], f.rpc, async (k) => (k === 'a' ? 'one' : undefined), async (l) => { questions.push(l); return 'two'; });
    expect(questions).toEqual([['b']]);
    expect(r.a.ok && r.b.ok).toBe(true);
  });

  it('a wrong password or a cancel says so per board; a refused stop_all is not "stopped"', async () => {
    const f = fleet({ a: { pin: 'one', stopNeedsPin: true }, b: { pin: 'two', stopNeedsPin: true }, c: { refuseStopAll: true }, d: { down: true } });
    const r = await stopBoards(['a', 'b', 'c', 'd'], f.rpc, async () => undefined, async () => 'one');
    expect(r.a.ok).toBe(true);
    expect(r.b).toMatchObject({ ok: false, locked: true });
    expect(r.c).toMatchObject({ ok: false, message: 'no' });
    expect(r.d).toMatchObject({ ok: false, message: 'the board is not connected' });
    const cancelled = await stopBoards(['b'], fleet({ b: { pin: 'two', stopNeedsPin: true } }).rpc, async () => undefined, async () => null);
    expect(cancelled.b).toMatchObject({ ok: false, locked: true });
  });
});
