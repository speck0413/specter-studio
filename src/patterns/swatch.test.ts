import { describe, expect, it } from 'vitest';
import { hexToRgb, pickerHex, rgbToHsv } from './swatch';

describe('a colour control’s swatch', () => {
  it('shows no colour when none is set, never a made-up red', () => {
    expect(pickerHex('hsvPicker', undefined)).toBeNull();
    expect(pickerHex('rgbPicker', undefined)).toBeNull();
    expect(pickerHex('hsvPicker', [])).toBeNull();
    expect(pickerHex('rgbPicker', [1, Number.NaN, 0])).toBeNull();
  });
  it('shows the colour set on it', () => {
    expect(pickerHex('hsvPicker', [1 / 3, 1, 1])).toBe('#00ff00');
    expect(pickerHex('hsvPicker', [0.08, 1, 1])).toBe('#ff7a00');
    expect(pickerHex('rgbPicker', [1, 0.5, 0])).toBe('#ff8000');
    // what the picker gives back is shown again as it was picked
    expect(pickerHex('hsvPicker', rgbToHsv(...hexToRgb('#3366cc')))).toBe('#3366cc');
    expect(pickerHex('rgbPicker', hexToRgb('#3366cc'))).toBe('#3366cc');
  });
});
