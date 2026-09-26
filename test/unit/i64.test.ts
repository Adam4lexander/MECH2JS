// The exact 64-bit helpers against a straight BigInt transcription of the C
// idioms they replace. Any carry or sign mistake shows up here long before it
// shows up as a mech drifting a centimetre per minute.
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { Acc64, det2r29, dot3r29, imul64, mulHi, mulr29, mulShr, regHi, regLo, udivShl, umul64 } from '../../src/core/int/i64.ts';

const i32 = fc.integer({ min: -0x80000000, max: 0x7fffffff });
const u32 = fc.integer({ min: 0, max: 0xffffffff });
const edge = fc.constantFrom(0, 1, -1, 0x7fffffff, -0x80000000, 0x20000000, -0x20000000, 0xffff, 0x10000, -0x10000);
const int = fc.oneof(i32, edge);

const M64 = (1n << 64n) - 1n;
const toI32 = (v: bigint): number => Number(BigInt.asIntN(32, v));
/** (int)((v >> 29) + bit28), exactly as the C idiom computes it over a wrapped int64. */
const oracleShr29r = (v: bigint): number => {
  const w = BigInt.asIntN(64, v);
  return toI32((w >> 29n) + ((w >> 28n) & 1n));
};

describe('i64', () => {
  it('imul64 matches BigInt', () => {
    fc.assert(
      fc.property(int, int, (a, b) => {
        imul64(a, b);
        const p = BigInt(a) * BigInt(b);
        expect(regHi()).toBe(Number(BigInt.asIntN(32, p >> 32n)));
        expect(regLo()).toBe(Number(p & 0xffffffffn));
      }),
      { numRuns: 20000 },
    );
  });

  it('umul64 matches BigInt', () => {
    fc.assert(
      fc.property(u32, u32, (a, b) => {
        umul64(a, b);
        const p = BigInt(a) * BigInt(b);
        expect(regHi()).toBe(Number(p >> 32n));
        expect(regLo()).toBe(Number(p & 0xffffffffn));
      }),
      { numRuns: 20000 },
    );
  });

  it('dot3r29 matches the C idiom', () => {
    fc.assert(
      fc.property(int, int, int, int, int, int, (a0, b0, a1, b1, a2, b2) => {
        const sum = (BigInt(a1) * BigInt(b1) + BigInt(a0) * BigInt(b0) + BigInt(a2) * BigInt(b2)) & M64;
        expect(dot3r29(a0, b0, a1, b1, a2, b2)).toBe(oracleShr29r(sum));
      }),
      { numRuns: 20000 },
    );
  });

  it('Acc64.shr27r matches the clipper idiom (lo >> 27 | hi << 5) + bit 26', () => {
    const acc = new Acc64();
    fc.assert(
      fc.property(int, int, int, int, int, int, (a0, b0, a1, b1, a2, b2) => {
        const w = BigInt.asIntN(64, BigInt(a0) * BigInt(b0) + BigInt(a1) * BigInt(b1) + BigInt(a2) * BigInt(b2));
        expect(acc.clear().mulAdd(a0, b0).mulAdd(a1, b1).mulAdd(a2, b2).shr27r()).toBe(toI32((w >> 27n) + ((w >> 26n) & 1n)));
      }),
      { numRuns: 20000 },
    );
  });

  it('det2r29 and mulr29 match the C idiom', () => {
    fc.assert(
      fc.property(int, int, int, int, (a, d, b, c) => {
        expect(det2r29(a, d, b, c)).toBe(oracleShr29r(BigInt(a) * BigInt(d) - BigInt(b) * BigInt(c)));
        expect(mulr29(a, b)).toBe(oracleShr29r(BigInt(a) * BigInt(b)));
      }),
      { numRuns: 20000 },
    );
  });

  it('Acc64 wraps modulo 2^64', () => {
    const acc = new Acc64();
    for (let k = 0; k < 4; k++) acc.mulAdd(-0x80000000, -0x80000000);
    // 4 * 2^62 = 2^64 -> wraps to 0
    expect(acc.h).toBe(0);
    expect(acc.l).toBe(0);
  });

  it('mulHi and mulShr', () => {
    fc.assert(
      fc.property(int, int, fc.integer({ min: 1, max: 31 }), (a, b, s) => {
        const p = BigInt(a) * BigInt(b);
        expect(mulHi(a, b)).toBe(Number(BigInt.asIntN(32, p >> 32n)));
        expect(mulShr(a, b, s)).toBe(toI32(p >> BigInt(s)));
      }),
      { numRuns: 20000 },
    );
  });

  it('udivShl is exact long division', () => {
    fc.assert(
      fc.property(u32, u32, (x, y) => {
        const d = Math.max(x, y, 1);
        const n = Math.min(x, y) === d ? 0 : Math.min(x, y);
        expect(udivShl(n, 24, d)).toBe(Number(((BigInt(n) << 24n) / BigInt(d)) & 0xffffffffn));
      }),
      { numRuns: 20000 },
    );
  });
});
