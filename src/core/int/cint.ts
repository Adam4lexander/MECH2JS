/**
 * C integer semantics for the port. The sim is exact fixed-point, so every
 * store into a C-typed field goes through one of these, and every division
 * and remainder uses C's truncating rules.
 *
 * JS bitwise operators already work on int32 (| 0, >>, >>>, Math.imul), and
 * JS `%` on integers already truncates like C99. What is missing is width
 * coercion for the narrow types and a divide that truncates and faults.
 *
 * @portOnly language support, no counterpart in MW2.EXE
 */

export const i8 = (v: number): number => (v << 24) >> 24;
export const u8 = (v: number): number => v & 0xff;
export const i16 = (v: number): number => (v << 16) >> 16;
export const u16 = (v: number): number => v & 0xffff;
export const i32 = (v: number): number => v | 0;
export const u32 = (v: number): number => v >>> 0;

/** Signed 32-bit division, truncating toward zero, faulting on zero like x86 idiv. */
export function cdiv(a: number, b: number): number {
  if ((b | 0) === 0) throw new RangeError('integer divide by zero');
  return ((a | 0) / (b | 0)) | 0;
}

/** Unsigned 32-bit division (div). */
export function udiv(a: number, b: number): number {
  const d = b >>> 0;
  if (d === 0) throw new RangeError('integer divide by zero');
  return Math.floor((a >>> 0) / d) >>> 0;
}

/** Signed remainder with the sign of the dividend (C99 %). */
export function cmod(a: number, b: number): number {
  if ((b | 0) === 0) throw new RangeError('integer divide by zero');
  return (a | 0) % (b | 0) | 0;
}

/** Unsigned remainder. */
export function umod(a: number, b: number): number {
  const d = b >>> 0;
  if (d === 0) throw new RangeError('integer divide by zero');
  return (a >>> 0) % d;
}

/** Wrapping int32 add / subtract / multiply. */
export const add32 = (a: number, b: number): number => (a + b) | 0;
export const sub32 = (a: number, b: number): number => (a - b) | 0;
export const mul32 = (a: number, b: number): number => Math.imul(a, b);

/** Absolute value as C's abs() on int: abs(INT_MIN) stays INT_MIN. */
export const iabs = (v: number): number => (v < 0 ? -v | 0 : v | 0);

/** C truncation of a double to int (clib_fp_trunc followed by fistp). */
export const ftrunc = (v: number): number => Math.trunc(v) | 0;
