/**
 * The x87 steps that a double cannot reproduce.
 *
 * MW2.EXE converts with `fild`, multiplies by a double constant with `fmul`,
 * then truncates through clib_fp_trunc and stores with `fistp`. The x87
 * holds the product in its 64-bit significand, where a JS double keeps 53, so
 * a product that lies just below an integer can round up to it in a double
 * and truncate one higher. ai_choose_throttle's |legsPan| * (double)2/3 does
 * this for every multiple of 3: the double constant is a hair under 2/3, the
 * exact product sits a few nanounits below the integer, the x87 keeps that
 * and truncates down, and a double rounds up to the integer.
 *
 * ASSUMED, not established: the FPU runs at 64-bit precision, the control
 * word FNINIT leaves. Nothing read so far lowers it. clib_fp_trunc itself
 * writes 0x1f over the control word's high byte, which is 64-bit precision
 * with round-toward-zero, for the frndint only.
 *
 * @portOnly language support for x87 arithmetic, no counterpart in MW2.EXE
 */

const F64 = new DataView(new ArrayBuffer(8));

/** A finite double as sig * 2^exp exactly (sig a signed BigInt). */
function decompose(d: number): { sig: bigint; exp: number } {
  F64.setFloat64(0, d, true);
  const hi = F64.getUint32(4, true);
  const lo = F64.getUint32(0, true);
  const neg = (hi >>> 31) !== 0;
  const bexp = (hi >>> 20) & 0x7ff;
  let frac = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let exp: number;
  if (bexp === 0) exp = -1074;
  else {
    frac |= 1n << 52n;
    exp = bexp - 1075;
  }
  return { sig: neg ? -frac : frac, exp };
}

/** Rounds sig * 2^exp to a 64-bit significand, to nearest, ties to even. */
function roundExtended(sig: bigint, exp: number): { sig: bigint; exp: number } {
  const neg = sig < 0n;
  let m = neg ? -sig : sig;
  const bits = m.toString(2).length;
  if (bits > 64) {
    const shift = BigInt(bits - 64);
    const half = 1n << (shift - 1n);
    const rest = m & ((1n << shift) - 1n);
    m >>= shift;
    if (rest > half || (rest === half && (m & 1n) === 1n)) m += 1n;
    exp += bits - 64;
  }
  return { sig: neg ? -m : m, exp };
}

/** clib_fp_trunc then fistp of sig * 2^exp: toward zero; outside int32 the integer indefinite 0x80000000. */
function truncStore(sig: bigint, exp: number): number {
  let t: bigint;
  if (exp >= 0) t = sig << BigInt(exp);
  else t = sig / (1n << BigInt(-exp)); // BigInt division truncates toward zero
  if (t > 0x7fffffffn || t < -0x80000000n) return -0x80000000;
  return Number(t);
}

/** `fild i; fmul qword d; call clib_fp_trunc; fistp` - (int)(i * d) in extended precision. */
export function x87MulTrunc(i: number, d: number): number {
  const { sig, exp } = decompose(d);
  const r = roundExtended(BigInt(i | 0) * sig, exp);
  return truncStore(r.sig, r.exp);
}
