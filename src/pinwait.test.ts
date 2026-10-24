import { describe, expect, it } from 'vitest';
import { pinBackoff, pinWaitMs } from './pinwait';

describe('the page password wait after a wrong try (newer firmware)', () => {
  const wait = (n: number) => ({ ok: false, error: { code: 'pin', message: `wrong page password: wait ${n} s before the next try` } });
  it('reads the wait; a plain "locked" asks again (no wait)', () => {
    expect(pinWaitMs(wait(2))).toBe(2100);
    expect(pinWaitMs({ ok: false, error: { code: 'pin', message: 'the page is locked: enter the page password' } })).toBe(0);
    expect(pinWaitMs({ ok: true })).toBe(0);
  });
  it('sends the same try again after the wait, so a right password is taken', async () => {
    const answers = [wait(1), { ok: true }];
    const slept: number[] = [];
    const r = await pinBackoff(async () => answers.shift(), async (ms) => { slept.push(ms); });
    expect(r).toEqual({ ok: true });
    expect(slept).toEqual([1100]);
  });
});
