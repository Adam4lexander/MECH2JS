/**
 * The x87 steps both executables use to turn floating point back into an
 * integer: `call clib_fp_trunc; fistp` - toward zero, and the integer
 * indefinite (0x80000000) when the value does not fit.
 *
 * ESTABLISHED: the FPU runs at 53-bit (double) precision, round to nearest.
 * Watcom's start-up runs __init_8087 from its init table at priority 2
 * (MW2.EXE: the entry at 0xa465c -> 0x783db; MW2SHELL.EXE: 0x8755e ->
 * 0x59f93). It detects the FPU and loads control word 0x127f (MW2.EXE from
 * 0xa4520, the shell from 0x87478) - precision control 10, double. The only
 * other fldcw in MW2.EXE is clib_fp_trunc's, which sets 64-bit precision
 * with round-toward-zero for its frndint and restores the word after it.
 * Every fadd/fmul/fdiv/fsqrt therefore rounds its result to a double's
 * 53-bit significand, as JS arithmetic does, and a double computation in
 * the original's order gives the original's answer.
 *
 * CORRECTION (2026-09-28): this file used to ASSUME the 64-bit precision
 * FNINIT leaves, and computed products in an extended significand; that
 * made ai_choose_throttle, the new pilot's honor and the mech lab's gyro
 * and armour masses truncate one lower than the original wherever a double
 * product rounds up onto an integer (|legsPan| * 2/3 for multiples of 3;
 * 32767 * (1/32767)).
 *
 * @portOnly language support for x87 arithmetic, no counterpart in MW2.EXE
 */

/** `call clib_fp_trunc; fistp dword`: toward zero; outside int32 (or NaN) the integer indefinite 0x80000000. */
export function x87TruncStore(v: number): number {
  const t = Math.trunc(v);
  if (!(t <= 0x7fffffff && t >= -0x80000000)) return -0x80000000;
  return t | 0;
}

/** `fild i; fmul qword d; call clib_fp_trunc; fistp` - (int)(i * d), the product rounded to a double. */
export function x87MulTrunc(i: number, d: number): number {
  return x87TruncStore((i | 0) * d);
}
