import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushOwed, holdOutput, isHeld, owedReleases, releaseOutput, resetHeld, Send, settling, SETTLE_MS } from './held';

// a board whose connection can drop: requests fail while it is away
function board() {
  const b = { up: true, on: new Set<string>(), sent: [] as string[] };
  const send: Send = async (_key, req) => {
    b.sent.push(`${req.channel}=${req.level}`);
    if (!b.up) throw new Error('the board is not connected');
    if (req.level) b.on.add(req.channel as string); else b.on.delete(req.channel as string);
    return { ok: true };
  };
  return { b, send };
}

afterEach(() => { resetHeld(); vi.useRealTimers(); });

describe('test outputs', () => {
  it('a let-go during a short drop is sent again when the board is back', async () => {
    const { b, send } = board();
    await holdOutput(send, 'k', 'out1');
    expect(isHeld('k', 'OUT1')).toBe(true);
    b.up = false;
    expect(await releaseOutput(send, 'k', 'OUT1')).toBe(false);
    expect(isHeld('k', 'OUT1')).toBe(false);
    expect(owedReleases('k')).toEqual(['OUT1']);
    expect(b.on.has('OUT1')).toBe(true); // still on at the board
    b.up = true;
    await flushOwed(send, 'k');
    expect(b.on.has('OUT1')).toBe(false);
    expect(owedReleases('k')).toEqual([]);
  });

  it('keeps trying every second until the board takes it', async () => {
    vi.useFakeTimers();
    const { b, send } = board();
    await holdOutput(send, 'k', 'OUT2');
    b.up = false;
    await releaseOutput(send, 'k', 'OUT2');
    await vi.advanceTimersByTimeAsync(3000);
    expect(b.on.has('OUT2')).toBe(true);
    b.up = true;
    await vi.advanceTimersByTimeAsync(1100);
    expect(b.on.has('OUT2')).toBe(false);
    expect(owedReleases('k')).toEqual([]);
  });

  it('a let-go that reached the board is not "left on" while the board\'s state catches up; an owed one is', async () => {
    const { b, send } = board();
    await holdOutput(send, 'k', 'OUT1');
    await releaseOutput(send, 'k', 'OUT1');
    expect(settling('k', 'OUT1')).toBe(true);
    expect(settling('k', 'OUT1', Date.now() + SETTLE_MS + 1)).toBe(false);
    await holdOutput(send, 'k', 'OUT2');
    b.up = false;
    await releaseOutput(send, 'k', 'OUT2');
    expect(settling('k', 'OUT2')).toBe(false); // owed: the note may show (and offers Release)
  });

  it('pressing again cancels what was owed (the new press owns the output)', async () => {
    const { b, send } = board();
    await holdOutput(send, 'k', 'OUT3');
    b.up = false;
    await releaseOutput(send, 'k', 'OUT3');
    b.up = true;
    await holdOutput(send, 'k', 'OUT3');
    expect(owedReleases('k')).toEqual([]);
    await flushOwed(send, 'k');
    expect(b.on.has('OUT3')).toBe(true);
  });
});
