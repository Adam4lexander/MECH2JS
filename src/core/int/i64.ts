/**
 * Exact 64-bit integer products for the fixed-point code.
 *
 * The game's math leans on x86's 32x32->64 imul: matrix and trig code sums
 * three 64-bit products, shifts right 29 and adds bit 28 back to round. JS
 * doubles hold 53 bits, so a straight a*b loses the low bits exactly where
 * the rounding looks. These helpers split each operand into 16-bit halves so
 * every partial product is exact, and carry the result as (hi int32, lo
 * uint32). They are checked against a BigInt transcription by fuzzing
 * (test/unit/i64.test.ts).
 *
 * imul64/umul64 return through module-level registers to avoid allocating
 * in hot paths; read them immediately with regHi()/regLo().
 *
 * @portOnly language support, no counterpart in MW2.EXE
 */

const TWO32 = 4294967296;

let rHi = 0;
let rLo = 0;

/** High dword (int32 for imul64, uint32 for umul64) of the last product. */
export const regHi = (): number => rHi;
/** Low dword (uint32) of the last product. */
export const regLo = (): number => rLo;

/** hi:lo = (int64) a * (int64) b, both signed 32-bit. */
export function imul64(a: number, b: number): void {
  a |= 0;
  b |= 0;
  const al = a & 0xffff;
  const ah = a >> 16;
  const bl = b & 0xffff;
  const bh = b >> 16;
  const mid = ah * bl + al * bh; // |mid| < 2^32, exact
  const midLo = mid & 0xffff; // the low 16 bits survive ToInt32's wrap
  const midHi = (mid - midLo) / 65536;
  let l = al * bl + midLo * 65536; // < 2^33
  let carry = 0;
  if (l >= TWO32) {
    l -= TWO32;
    carry = 1;
  }
  rLo = l;
  rHi = (ah * bh + midHi + carry) | 0;
}

/** hi:lo = (uint64) a * (uint64) b, both unsigned 32-bit. */
export function umul64(a: number, b: number): void {
  a >>>= 0;
  b >>>= 0;
  const al = a & 0xffff;
  const ah = a >>> 16;
  const bl = b & 0xffff;
  const bh = b >>> 16;
  const mid = ah * bl + al * bh; // < 2^33, exact
  const midLo = mid % 65536;
  const midHi = (mid - midLo) / 65536;
  let l = al * bl + midLo * 65536;
  let carry = 0;
  if (l >= TWO32) {
    l -= TWO32;
    carry = 1;
  }
  rLo = l;
  rHi = (ah * bh + midHi + carry) >>> 0;
}

/** (hi:lo >> 29) truncated to int32, plus bit 28 added back as round-to-nearest. */
export function shr29r(h: number, l: number): number {
  return (((l >>> 29) | (h << 3)) + ((l >>> 28) & 1)) | 0;
}

/**
 * A 64-bit accumulator: sums and differences of signed products, wrapping
 * modulo 2^64 like the original longlong arithmetic.
 */
export class Acc64 {
  h = 0;
  l = 0;
  clear(): this {
    this.h = 0;
    this.l = 0;
    return this;
  }
  /** += (int64) a * b */
  mulAdd(a: number, b: number): this {
    imul64(a, b);
    let l = this.l + rLo;
    let c = 0;
    if (l >= TWO32) {
      l -= TWO32;
      c = 1;
    }
    this.l = l;
    this.h = (this.h + rHi + c) | 0;
    return this;
  }
  /** -= (int64) a * b */
  mulSub(a: number, b: number): this {
    imul64(a, b);
    let l = this.l - rLo;
    let c = 0;
    if (l < 0) {
      l += TWO32;
      c = 1;
    }
    this.l = l;
    this.h = (this.h - rHi - c) | 0;
    return this;
  }
  /** The idiom `(lo >> 29 | hi << 3) + ((lo >> 28) & 1)`. */
  shr29r(): number {
    return shr29r(this.h, this.l);
  }
  /** The idiom `(lo >> 27 | hi << 5) + ((lo >> 26) & 1)` - poly_clip_and_queue's view depth. */
  shr27r(): number {
    return (((this.l >>> 27) | (this.h << 5)) + ((this.l >>> 26) & 1)) | 0;
  }
}

/** (int)((int64)a * b >> 29) rounded by bit 28 - the product idiom of matrix_from_euler. */
export function mulr29(a: number, b: number): number {
  imul64(a, b);
  return shr29r(rHi, rLo);
}

const dotAcc = new Acc64();

/** Signed dot product of three pairs, >> 29 rounded: every row of transform_point / matrix_multiply. */
export function dot3r29(a0: number, b0: number, a1: number, b1: number, a2: number, b2: number): number {
  // Addition mod 2^64 is associative, so the original's summation order
  // (a1*b1 + a0*b0 + a2*b2) does not change the result.
  return dotAcc.clear().mulAdd(a0, b0).mulAdd(a1, b1).mulAdd(a2, b2).shr29r();
}

/** a*d - b*c, >> 29 rounded: the cross-product terms of matrix_cross_column. */
export function det2r29(a: number, d: number, b: number, c: number): number {
  return dotAcc.clear().mulAdd(a, d).mulSub(b, c).shr29r();
}

/** High dword of a signed 32x32 product (imul, keep EDX). */
export function mulHi(a: number, b: number): number {
  imul64(a, b);
  return rHi;
}

/** Low 32 bits of ((int64)a*b) >> s for 0 < s < 32, as int32 (shrd). */
export function mulShr(a: number, b: number, s: number): number {
  imul64(a, b);
  return ((rLo >>> s) | (rHi << (32 - s))) | 0;
}

/**
 * Unsigned 64/32 division of (n << shift) by d, where n < d so the quotient
 * fits in 32 bits - fixed_atan2's (min << 24) / max. Done as two exact long
 * division steps so no intermediate exceeds 2^53.
 */
export function udivShl(n: number, shift: number, d: number): number {
  n >>>= 0;
  d >>>= 0;
  if (d === 0) throw new RangeError('integer divide by zero');
  const s1 = shift >> 1;
  const s2 = shift - s1;
  const n1 = n * 2 ** s1;
  const q1 = Math.floor(n1 / d);
  const r1 = n1 - q1 * d;
  const n2 = r1 * 2 ** s2;
  const q2 = Math.floor(n2 / d);
  return (q1 * 2 ** s2 + q2) >>> 0;
}

/**
 * Low 32 bits of trunc((int64)(n << shift) / d), signed, with n sign-extended
 * to 64 bits first - the `CONCAT44(n >> 31 << s | n >>> (32 - s), n << s) / d`
 * idiom (idiv). Exact.
 */
export function sdivShl(n: number, shift: number, d: number): number {
  if ((d | 0) === 0) throw new RangeError('integer divide by zero');
  const q = (BigInt(n | 0) << BigInt(shift)) / BigInt(d | 0);
  return Number(BigInt.asIntN(32, q));
}
