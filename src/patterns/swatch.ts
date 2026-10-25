// The colours of a pattern's colour controls (hsvPicker…, rgbPicker…): values 0 to 1, shown as #rrggbb. A control
// nobody has set has no colour Studio can honestly show: the pattern sets its own start in its code (any variable,
// any way), so the swatch says so instead of showing a made-up one.

export const hex = (r: number, g: number, b: number) => '#' + [r, g, b].map((x) => Math.round(x).toString(16).padStart(2, '0')).join('');
export function hexToRgb(h: string): [number, number, number] {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((x) => x / 255) as [number, number, number];
}
export function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h /= 6; if (h < 0) h += 1;
  return [h, mx ? d / mx : 0, mx];
}
export function hsvToHex(h: number, s: number, v: number) {
  const i = Math.floor(h * 6), f = h * 6 - i, p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  const [r, g, b] = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][((i % 6) + 6) % 6];
  return hex(r * 255, g * 255, b * 255);
}

/** The colour a picker control shows: the one set on it (#rrggbb), or null when none is (the pattern's own start). */
export function pickerHex(kind: 'hsvPicker' | 'rgbPicker', set: number[] | undefined): string | null {
  if (!set || set.length < 3 || !set.slice(0, 3).every(Number.isFinite)) return null;
  const [a, b, c] = set;
  return kind === 'hsvPicker' ? hsvToHex(a, b, c) : hex(a * 255, b * 255, c * 255);
}
