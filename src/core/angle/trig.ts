/**
 * Fixed-point trigonometry: the tables math_build_trig_tables builds at
 * startup and the table readers every angle in the sim goes through.
 *
 * Units: angles are 16.16 degrees (see angle.ts). fixed_sin / fixed_cos
 * return 2.29 fixed point (1.0 = 0x20000000); fixed_asin takes one. The
 * tables are rebuilt from the recipe because they are not in the image - only
 * the code that fills them is (tools/dump_trig_tables.py has the derivation).
 */

import { imul64, mulHi, regHi, regLo, shr29r, udivShl } from '../int/i64.ts';

/**
 * The four x87 multipliers math_build_trig_tables reads, as stored in the
 * image (fmul operands at 0x3aaa2, 0x3aaaa, 0x3aab8, 0x3aacf). K_SIN is the
 * double closest to 0.00613592314453125, which is pi/512 ROUNDED - the table
 * follows the stored constant, not pi. test/golden/exe.test.ts checks these
 * against the bytes of MW2.EXE.
 */
export const K_SIN = 0.00613592314453125; // [0x90fac]
export const K_SCALE = 536870912.0; // [0x90fb4] 2^29
export const K_STEP = 0.00390625; // [0x90fbc] 1/256
export const K_DEG = 3754936.210460003; // [0x90fc4] ~65536*180/pi

/** sinTable @0xfe1d4: 256 entries + 2 guards, 2.29 fixed point. */
export const sinTable = new Int32Array(258);
/** atanTable @0xfe5dc: 256 entries + 2 guards, 16.16 degrees. */
export const atanTable = new Int32Array(258);

/**
 * Fills sinTable and atanTable. The original runs on the x87 at 53-bit
 * precision (core/int/x87.ts), as JS doubles do; the golden test against
 * listing/trig_tables.txt (dump_trig_tables.py) checks every entry.
 *
 * @mw2 math_build_trig_tables 0x0003aa90
 * @fidelity exact
 */
export function mathBuildTrigTables(): number {
  for (let i = 0; i < 0x100; i++) {
    sinTable[i] = Math.trunc(Math.sin(i * K_SIN) * K_SCALE);
    atanTable[i] = Math.trunc(Math.atan(i * K_STEP) * K_DEG);
  }
  sinTable[256] = sinTable[257] = 0x20000000;
  atanTable[256] = atanTable[257] = 0x2d0000;
  return 1;
}

mathBuildTrigTables();

/**
 * Sine of a 16.16-degree angle, as 2.29. Scales the angle to a phase whose
 * bits 16..23 index a 256-step quarter wave, bit 24 reflects, bit 25 negates,
 * and the low 16 bits interpolate (rounded) between adjacent entries.
 *
 * @mw2 fixed_sin 0x0003a838
 * @fidelity exact
 */
export function fixedSin(angle: number): number {
  imul64(angle, 0x5b05b05b);
  const u3 = shr29r(regHi(), regLo()) >>> 0;
  let off = (u3 >>> 14) & 0x3fc;
  let u2 = u3;
  if ((u3 & 0x1000000) !== 0) {
    u2 = ~u3 >>> 0;
    off ^= 0x3fc;
  }
  const n = off >> 2;
  const base = sinTable[n]!;
  const diff = (sinTable[n + 1]! - base) >>> 0;
  const prod = diff * (u2 & 0xffff); // < 2^48, exact in a double
  const q = Math.floor(prod / 65536) >>> 0;
  const roundBit = Math.floor(prod / 32768) & 1;
  let r = (base + q + roundBit) | 0;
  if ((u3 & 0x2000000) !== 0) r = -r | 0;
  return r;
}

/**
 * @mw2 fixed_cos 0x0003a8a8
 * @fidelity exact
 */
export function fixedCos(angle: number): number {
  return fixedSin((angle + 0x5a0000) | 0);
}

/**
 * Inverse sine: argument 2.29, result 16.16 degrees. Binary search for the
 * largest i with sinTable[i] <= |s|, interpolate with a truncating idiv, then
 * convert with the high dword of v * 0x5a000000. Truncates where fixed_sin
 * rounds, so fixed_asin(fixed_sin(a)) need not return a.
 *
 * The two branches the annotation shows can never run with the shipped table
 * (zero step -> divide fault; r >= step) are kept for fidelity.
 *
 * @mw2 fixed_asin 0x0003a8b7
 * @fidelity exact
 */
export function fixedAsin(sine: number): number {
  sine |= 0;
  if (sine === 0) return 0;
  let s = (sine < 0 ? -sine : sine) >>> 0;
  let result: number;
  if ((s | 0) < 0x20000000) {
    let i = 0;
    let v = 0;
    if (sinTable[128]! >>> 0 <= s) {
      i = 128;
      v = 0x800000;
    }
    for (let step = 64, bit = 0x400000; step >= 1; step >>= 1, bit >>= 1) {
      if (sinTable[i + step]! >>> 0 <= s) {
        i += step;
        v |= bit;
      }
    }
    s = (s - sinTable[i]!) >>> 0;
    if (s !== 0) {
      const stepSize = (sinTable[i + 1]! - sinTable[i]!) >>> 0;
      if (stepSize === 0 || s < stepSize) {
        // signed 64-bit (s << 16) / step, keep AX. s < 2^30 so the product is exact.
        const q = Math.trunc(((s | 0) * 65536) / (stepSize | 0));
        v = (v & 0xffff0000) | (q & 0xffff);
      } else {
        v = (v + 0x10000) | 0;
      }
    }
    result = mulHi(v, 0x5a000000);
  } else {
    result = 0x5a0000;
  }
  return sine < 0 ? -result | 0 : result;
}

/**
 * @mw2 fixed_acos 0x0003a9cc
 * @fidelity exact
 */
export function fixedAcos(cosine: number): number {
  return (0x5a0000 - fixedAsin(cosine)) | 0;
}

/**
 * Arctangent of y/x in 16.16 degrees. Records both signs, divides the smaller
 * magnitude by the larger (<< 24), interpolates atanTable, then undoes the
 * swap (90 - r), the x sign (180 - r) and the y sign (negate).
 *
 * @mw2 fixed_atan2 0x0003a9e5
 * @fidelity exact
 */
export function fixedAtan2(y: number, x: number): number {
  y |= 0;
  x |= 0;
  const yNeg = y < 0;
  if (yNeg) y = -y | 0;
  let flags = yNeg ? 1 : 0;
  if (x < 0) {
    x = -x | 0;
    flags = 2; // the original overwrites the y flag in cl; yNeg is kept separately
  }
  let num = y;
  let r: number;
  if (x <= y) {
    if (y === x) {
      r = 0x2d0000;
      return finish(r, flags, yNeg);
    }
    flags |= 4;
    num = x;
    x = y;
  }
  if (num === 0) {
    r = 0;
  } else {
    const q = udivShl(num, 24, x);
    const off = (q >>> 14) & 0x3fc;
    const n = off >> 2;
    const p = Math.imul(q & 0xffff, (atanTable[n + 1]! - atanTable[n]!) | 0) >>> 0;
    r = ((p >>> 16) + atanTable[n]! + ((p >>> 15) & 1)) | 0;
  }
  return finish(r, flags, yNeg);
}

function finish(r: number, flags: number, yNeg: boolean): number {
  if ((flags & 4) !== 0) r = (0x5a0000 - r) | 0;
  if ((flags & 2) !== 0) r = (0xb40000 - r) | 0;
  if (yNeg) r = -r | 0;
  return r;
}
