/**
 * The 16.16 product and quotient idioms of the movement code, each exact
 * over the full int32 range (via imul64 or BigInt), as MW2.EXE computes them.
 *
 * @portOnly arithmetic idioms, no counterpart function in MW2.EXE
 */
import { mulShr } from './i64.ts';

/** `(lo >> 16 | hi << 16) + ((lo >> 15) & 1)`: (int64)a * b >> 16, rounded by bit 15 - the 16.16 product. */
export function mulr16(a: number, b: number): number {
  return (mulShr(a, b, 16) + ((mulShr(a, b, 15) & 1) !== 0 ? 1 : 0)) | 0;
}

/** Low 32 bits of trunc((int64)a * b / d) - imul then idiv. */
export function mulDiv64(a: number, b: number, d: number): number {
  if ((d | 0) === 0) throw new RangeError('integer divide by zero');
  const q = (BigInt(a | 0) * BigInt(b | 0)) / BigInt(d | 0);
  return Number(BigInt.asIntN(32, q));
}
