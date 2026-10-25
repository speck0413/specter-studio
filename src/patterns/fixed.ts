// The pattern language's maths in 16.16 fixed point, with integers only, so a board's interpreter (the firmware's
// pattern_math.h, the same steps in C++) gives exactly the same numbers as Studio's preview: no Math.sin, no
// Math.random, nothing that differs between JavaScript engines or chips. Every value is a 32-bit integer holding
// value × 65536. JavaScript numbers hold integers exactly up to 2^53, and every step below stays under that.
//
// Written from the textbook series (sine, the exponential) and the Abramowitz and Stegun arctangent; the shared
// golden vectors (firmware/pattern-golden) check both implementations against each other.

export const ONE = 65536;
const Q30 = 1 << 30;
const INT_MIN = -0x80000000;
const INT_MAX = 0x7fffffff;

/** floor(a × b / 2^s) wrapped to 32 bits, exactly, for 32-bit a and b and s from 16 to 31. */
export function mulS(a: number, b: number, s: number): number {
  const ah = a >> 16, al = a & 0xffff;
  const hi = ah * b, lo = al * b; // each under 2^47: exact
  const k = 2 ** (s - 16);
  const q = Math.floor(hi / k);
  const r = hi - q * k;
  return (q + Math.floor((r * 65536 + lo) / 2 ** s)) | 0;
}

/** 16.16 multiply: the exact 64-bit product shifted down by 16, wrapped to 32 bits (no low bits lost). */
export const fmul = (a: number, b: number) => mulS(a, b, 16);

/** 16.16 divide, rounded toward zero; dividing by zero gives the largest number of the right sign (0 / 0 is 0). */
export function fdiv(a: number, b: number): number {
  if (b === 0) return a > 0 ? INT_MAX : a < 0 ? INT_MIN : 0;
  return Math.trunc((a * ONE) / b) | 0; // the numerator is under 2^53, so this is the exact integer quotient
}

/** The whole part of the square root of a whole number from 0 to 2^53. */
export function isqrt(v: number): number {
  if (v <= 0) return 0;
  let r = Math.floor(Math.sqrt(v));
  while (r * r > v) r--;
  while ((r + 1) * (r + 1) <= v) r++;
  return r;
}

const SIN_C = [172272, -5026995, 85569306, -693598668, 1686629713]; // sin(πx/2) = x(c1 + x²(c3 + …)), Q30
/** sine of a fraction of a turn held in 24 bits (0 to 0xffffff), as Q30 (2^30 is 1). */
function sinTurn24(t: number): number {
  const quarter = t >>> 22;
  let u = t & 0x3fffff;
  if (quarter & 1) u = 0x400000 - u;
  const x = u * 256; // Q30, 0 to 2^30
  const x2 = mulS(x, x, 30);
  let p = SIN_C[0];
  for (let i = 1; i < SIN_C.length; i++) p = (SIN_C[i] + mulS(p, x2, 30)) | 0;
  const s = mulS(p, x, 30);
  return quarter >= 2 ? -s : s;
}
const q30to16 = (v: number) => (v + 8192) >> 14;
const INV_2PI_Q30 = 170891319;
/** radians (16.16) as a fraction of a turn in 24 bits */
const turns24 = (x: number) => mulS(x, INV_2PI_Q30, 22) & 0xffffff;

export const fsin = (x: number) => q30to16(sinTurn24(turns24(x)));
export const fcos = (x: number) => q30to16(sinTurn24((turns24(x) + 0x400000) & 0xffffff));
export const ftan = (x: number) => fdiv(fsin(x), fcos(x));
/** wave(x): (1 + sin(x turns)) / 2, from 0 to 1 */
export function fwave(x: number): number {
  return (q30to16(sinTurn24((x & 0xffff) * 256)) + ONE) >> 1;
}

const ATAN_C = [-4353012, 23473316, -60032783, 103530234, -149341741, 214174299, -357876604, 1073741108]; // Q30
/** arctangent of r from 0 to 1 (Q30), in radians as Q30 */
function atanQ30(r: number): number {
  const z = mulS(r, r, 30);
  let p = ATAN_C[0];
  for (let i = 1; i < ATAN_C.length; i++) p = (ATAN_C[i] + mulS(p, z, 30)) | 0;
  return mulS(p, r, 30);
}
const HALF_PI_Q30 = 1686629713;
const PI16 = 205887;
export function fatan2(y: number, x: number): number {
  if (x === 0 && y === 0) return 0;
  const ax = Math.abs(x), ay = Math.abs(y); // up to 2^31
  let a: number;
  if (ay <= ax) a = atanQ30(Math.floor((ay * 4194304) / ax) * 256);
  else a = HALF_PI_Q30 - atanQ30(Math.floor((ax * 4194304) / ay) * 256);
  let r = q30to16(a);
  if (x < 0) r = PI16 - r;
  return y < 0 ? -r | 0 : r;
}
export const fatan = (x: number) => fatan2(x, ONE);
/** the other side of a right angle with hypotenuse 1: sqrt(1 - x²), for x from -1 to 1 */
const cosOf = (x: number) => isqrt(2 ** 32 - x * x);
const clampOne = (x: number) => (x < -ONE ? -ONE : x > ONE ? ONE : x);
export function fasin(x: number): number { x = clampOne(x); return fatan2(x, cosOf(x)); }
export function facos(x: number): number { x = clampOne(x); return fatan2(cosOf(x), x); }

export function fsqrt(x: number): number {
  return x <= 0 ? 0 : isqrt(x * ONE);
}
export function fhypot(a: number, b: number): number {
  let A = Math.abs(a), B = Math.abs(b), k = 0;
  while (A >= 2 ** 26 || B >= 2 ** 26) { A = Math.floor(A / 2); B = Math.floor(B / 2); k++; }
  const r = isqrt(A * A + B * B) * 2 ** k;
  return r > INT_MAX ? INT_MAX : r;
}

/** log2 of a positive whole number up to 2^31 read as 16.16 (x / 65536); 16 bits of fraction */
function log2u(x: number): number {
  const m = 31 - Math.clz32(x);
  let mm = m >= 29 ? Math.floor(x / 2 ** (m - 29)) : x * 2 ** (29 - m); // Q29, 1 to 2
  let frac = 0;
  for (let bit = 15; bit >= 0; bit--) {
    mm = mulS(mm, mm, 29);
    if (mm >= Q30) { mm = Math.floor(mm / 2); frac += 2 ** bit; }
  }
  return (m - 16) * ONE + frac;
}
export const flog2 = (x: number) => (x <= 0 ? INT_MIN : log2u(x));
const LN2_Q30 = 744261118;
export const flog = (x: number) => (x <= 0 ? INT_MIN : mulS(log2u(x), LN2_Q30, 30));

const EXP2_C = [1419, 16377, 165394, 1431680, 10327387, 59597083, 257941248, 744261118]; // (ln 2)^n / n!, Q30
/** 2^y for 16.16 y; past the largest number it stays at the largest */
function fexp2(y: number): number {
  const k = y >> 16, f = (y & 0xffff) * 16384; // f as Q30
  let p = EXP2_C[0];
  for (let i = 1; i < EXP2_C.length; i++) p = (EXP2_C[i] + mulS(p, f, 30)) | 0;
  const v = Q30 + mulS(p, f, 30); // 2^frac as Q30, 2^30 to 2^31 (a plain number here; uint32 on the board)
  const shift = 14 - k;
  if (shift < 0) return INT_MAX;
  if (shift === 0) return v > INT_MAX ? INT_MAX : v;
  if (shift >= 32) return 0;
  return Math.floor((v + 2 ** (shift - 1)) / 2 ** shift);
}
const LOG2E_Q30 = 1549082005;
export function fexp(x: number): number {
  if (x >= 11 * ONE) return INT_MAX;
  if (x <= -12 * ONE) return 0;
  return fexp2(mulS(x, LOG2E_Q30, 30));
}
export function fpow(a: number, b: number): number {
  if (b === 0) return ONE;
  if (a === 0) return b > 0 ? 0 : INT_MAX;
  const whole = (b & 0xffff) === 0;
  if (a < 0 && !whole) return 0;
  const l = log2u(Math.abs(a)); // within ±2^20, so b × l is exact
  const y = Math.floor((b * l) / ONE);
  const mag = y >= 15 * ONE ? INT_MAX : y < -17 * ONE ? 0 : fexp2(y);
  return a < 0 && ((b >> 16) & 1) ? -mag | 0 : mag;
}

/** smoothstep(lo, hi, x): 0 below lo, 1 above hi, an S-curve between */
export function smoothstep(lo: number, hi: number, x: number): number {
  if (hi === lo) return x < lo ? 0 : ONE;
  let t = fdiv((x - lo) | 0, (hi - lo) | 0);
  t = t < 0 ? 0 : t > ONE ? ONE : t;
  return fmul(fmul(t, t), 3 * ONE - 2 * t);
}

/** hsv to red, green and blue (16.16, 0 to 1 each); the hue wraps around */
export function hsv(h: number, s: number, v: number): [number, number, number] {
  h &= 0xffff;
  s = s < 0 ? 0 : s > ONE ? ONE : s;
  v = v < 0 ? 0 : v > ONE ? ONE : v;
  const h6 = h * 6, i = h6 >> 16, fr = h6 & 0xffff;
  const p = fmul(v, ONE - s), q = fmul(v, ONE - fmul(fr, s)), t = fmul(v, ONE - fmul(ONE - fr, s));
  switch (i) {
    case 0: return [v, t, p];
    case 1: return [q, v, p];
    case 2: return [p, v, t];
    case 3: return [p, q, v];
    case 4: return [t, p, v];
    default: return [v, p, q];
  }
}

/** A colour part (16.16, 0 to 1) as 0 to 255, halves up. */
export const channel = (c: number) => (c * 255 + 32768) >> 16;

/** The golden vectors' random numbers (and a test's): xorshift32 from a seed, 16 bits a call. */
export function xorshift16(seed: number): () => number {
  let x = seed | 0 || 1;
  return () => {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    return x >>> 16;
  };
}
