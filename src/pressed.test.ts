import { describe, expect, it } from 'vitest';
import { pressedNow } from './store';

describe('inputs seen pressed (an unplugged switch looks like an idle one until it is pressed)', () => {
  it('stamps the inputs pressed in a state and keeps the ones seen before', () => {
    const a = pressedNow(undefined, { inputs: [{ input: 'TRIG1', raw: true }, { input: 'TRIG2', raw: false }] })!;
    expect(Object.keys(a)).toEqual(['TRIG1']);
    const b = pressedNow(a, { inputs: [{ input: 'TRIG2', active: true }] })!;
    expect(Object.keys(b).sort()).toEqual(['TRIG1', 'TRIG2']);
  });
  it('leaves the same object when nothing is pressed (no re-render)', () => {
    const a = { TRIG1: 1 };
    expect(pressedNow(a, { inputs: [{ input: 'TRIG1', raw: false }] })).toBe(a);
    expect(pressedNow(undefined, {})).toBeUndefined();
  });
});
