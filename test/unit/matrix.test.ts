import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  matrixFromEuler,
  matrixIdentity,
  matrixMultiply,
  matrixToEuler,
  newTransform,
  transformCompose,
  transformPoint,
} from '../../src/core/math/matrix.ts';

const r29 = (v: bigint): number => Number(BigInt.asIntN(32, (BigInt.asIntN(64, v) >> 29n) + ((BigInt.asIntN(64, v) >> 28n) & 1n)));
const int = fc.integer({ min: -0x80000000, max: 0x7fffffff });
const ang = fc.integer({ min: -0xb40000, max: 0xb40000 });

describe('matrix', () => {
  it('matrixMultiply matches the C idiom', () => {
    fc.assert(
      fc.property(fc.array(int, { minLength: 9, maxLength: 9 }), fc.array(int, { minLength: 9, maxLength: 9 }), (a, b) => {
        const out = new Int32Array(9);
        matrixMultiply(Int32Array.from(a), Int32Array.from(b), out);
        for (let r = 0; r < 3; r++)
          for (let c = 0; c < 3; c++) {
            const s = BigInt(a[r * 3]!) * BigInt(b[c]!) + BigInt(a[r * 3 + 1]!) * BigInt(b[c + 3]!) + BigInt(a[r * 3 + 2]!) * BigInt(b[c + 6]!);
            expect(out[r * 3 + c]).toBe(r29(s));
          }
      }),
      { numRuns: 3000 },
    );
  });

  it('identity leaves points alone; compose(outer, inner) applies inner first', () => {
    const id = newTransform();
    matrixIdentity(id);
    const p = [123, -456, 789];
    transformPoint(id, p);
    expect(p).toEqual([123, -456, 789]);

    const yaw90 = newTransform();
    matrixFromEuler(yaw90, 0, 0x5a0000, 0, 0, 0, 0, 0);
    const move = newTransform();
    matrixIdentity(move);
    move[9] = 1000;
    const both = newTransform();
    transformCompose(yaw90, move, both); // move, then rotate
    const q = [0, 0, 0];
    transformPoint(both, q);
    // Ry(90) takes +X to -Z (right-handed, column vectors).
    expect(q).toEqual([0, 0, -1000]);
  });

  it('matrixFromEuler order 0 is Ry*Rx*Rz and round-trips through matrixToEuler', () => {
    fc.assert(
      fc.property(fc.integer({ min: -0x500000, max: 0x500000 }), ang, ang, (pitch, yaw, roll) => {
        const m = newTransform();
        matrixFromEuler(m, pitch, yaw, roll, 0, 0, 0, 0);
        const e = matrixToEuler(m);
        const near = (a: number, b: number) => {
          let d = (a - b) % 0x1680000;
          if (d > 0xb40000) d -= 0x1680000;
          if (d < -0xb40000) d += 0x1680000;
          return Math.abs(d) < 0x8000; // half a degree
        };
        expect(near(e.pitch, pitch)).toBe(true);
        expect(near(e.yaw, yaw)).toBe(true);
        expect(near(e.roll, roll)).toBe(true);
      }),
      { numRuns: 2000 },
    );
  });
});
