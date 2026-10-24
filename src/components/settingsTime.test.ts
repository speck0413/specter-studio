import { describe, expect, it } from 'vitest';
import { isMs } from './SettingsPanel';

describe('times in settings are shown in seconds, as on the board\'s page', () => {
  it('a millisecond time setting (unit ms, key _ms)', () => {
    expect(isMs({ key: 'out1_max_on_ms', type: 'int', unit: 'ms' })).toBe(true);
    expect(isMs({ key: 'trig_debounce_ms', type: 'int', unit: 'ms' })).toBe(true);
  });
  it('not a profile alias with its own unit, nor a number that is not a time', () => {
    expect(isMs({ key: 'fire_time', type: 'int', unit: 'ms' })).toBe(false);
    expect(isMs({ key: 'pixel_count', type: 'int' })).toBe(false);
    expect(isMs({ key: 'x_ms', type: 'text', unit: 'ms' })).toBe(false);
  });
});
