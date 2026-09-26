// fixed_sin / fixed_atan2 / fixed_asin against BigInt transcriptions of the
// decompiled bodies, over the same tables. The tables themselves are checked
// against the decompilation's listing in test/golden/trig.test.ts.
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { atanTable, fixedAsin, fixedAtan2, fixedCos, fixedSin, sinTable } from '../../src/core/angle/trig.ts';

const U32 = 0xffffffffn;
const tb = (t: Int32Array, i: bigint): bigint => BigInt(t[Number(i)]!);

function oracleSin(a: number): number {
  const p = BigInt.asIntN(64, BigInt(a) * 0x5b05b05bn);
  const u3 = (((p >> 29n) & U32) + ((p >> 28n) & 1n)) & U32;
  let off = (u3 >> 14n) & 0x3fcn;
  let u2 = u3;
  if (u3 & 0x1000000n) {
    u2 = ~u3 & U32;
    off ^= 0x3fcn;
  }
  const n = off / 4n;
  const diff = (tb(sinTable, n + 1n) - tb(sinTable, n)) & U32;
  const l = diff * (u2 & 0xffffn);
  let r = BigInt.asIntN(32, tb(sinTable, n) + ((l >> 16n) & U32) + ((l >> 15n) & 1n));
  if (u3 & 0x2000000n) r = BigInt.asIntN(32, -r);
  return Number(r);
}

function oracleAtan2(y: number, x: number): number {
  let yy = BigInt(y);
  let xx = BigInt(x);
  const yNeg = yy < 0n;
  if (yNeg) yy = -yy;
  let fl = 0;
  if (xx < 0n) {
    xx = -xx;
    fl = 2;
  }
  let num = yy;
  let r: bigint;
  const done = (v: bigint): number => {
    if (fl & 4) v = 0x5a0000n - v;
    if (fl & 2) v = 0xb40000n - v;
    if (yNeg) v = -v;
    return Number(BigInt.asIntN(32, v));
  };
  if (xx <= yy) {
    if (xx === yy) return done(0x2d0000n);
    fl |= 4;
    num = xx;
    xx = yy;
  }
  if (num === 0n) r = 0n;
  else {
    const q = ((num << 24n) / xx) & U32;
    const n = ((q >> 14n) & 0x3fcn) / 4n;
    const pr = ((q & 0xffffn) * (tb(atanTable, n + 1n) - tb(atanTable, n))) & U32;
    r = (pr >> 16n) + tb(atanTable, n) + ((pr >> 15n) & 1n);
  }
  return done(r);
}

const angle = fc.oneof(fc.integer({ min: -0x80000000, max: 0x7fffffff }), fc.integer({ min: -0x2d00000, max: 0x2d00000 }));
const coord = fc.integer({ min: -0x7fffffff, max: 0x7fffffff });

describe('fixed trig', () => {
  it('fixedSin matches the decompiled body', () => {
    fc.assert(fc.property(angle, (a) => { expect(fixedSin(a)).toBe(oracleSin(a)); }), { numRuns: 50000 });
  });

  it('fixedSin hits the cardinal points exactly', () => {
    expect(fixedSin(0)).toBe(0);
    expect(fixedSin(0x5a0000)).toBe(0x20000000);
    expect(fixedSin(0xb40000)).toBe(0);
    expect(fixedSin(-0x5a0000)).toBe(-0x20000000);
    expect(fixedCos(0)).toBe(0x20000000);
  });

  it('fixedAtan2 matches the decompiled body', () => {
    fc.assert(fc.property(coord, coord, (y, x) => { expect(fixedAtan2(y, x)).toBe(oracleAtan2(y, x)); }), { numRuns: 50000 });
  });

  it('fixedAtan2 quadrants', () => {
    expect(fixedAtan2(1, 1)).toBe(0x2d0000);
    expect(fixedAtan2(1000, 0)).toBe(0x5a0000);
    expect(fixedAtan2(0, -1000)).toBe(0xb40000);
    expect(fixedAtan2(-1000, 0)).toBe(-0x5a0000);
  });

  it('fixedAsin inverts fixedSin to within a table step', () => {
    for (let a = -0x5a0000; a <= 0x5a0000; a += 0x1234) {
      const back = fixedAsin(fixedSin(a));
      expect(Math.abs(back - a)).toBeLessThan(0x10000); // < 1 degree
    }
    expect(fixedAsin(0x20000000)).toBe(0x5a0000);
    expect(fixedAsin(-0x20000000)).toBe(-0x5a0000);
  });
});
