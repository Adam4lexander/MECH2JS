/**
 * The game's two table-driven random number generators.
 *
 * Both tables hold 127 values drawn once at startup from the Miles Sound
 * System's LCG (x = x * 0x41c64e6d + 0x3039, returning bits 16..30).
 *
 * THE SEED: random_tables_init seeds the LCG with whatever is in EAX on entry
 * (miles_driver_sub_0761a3 stores in_EAX). main loads that from [ebp-8]
 * (0x15c23), which it set from EDX at 0x15a51 - main's second argument,
 * argv. So the original seeds its RNG with the ADDRESS of the argv array
 * under DOS/4GW: stable for one machine and memory layout, not a designed
 * value. The port takes the seed as a parameter; the default is arbitrary and
 * marked as such.
 */

import { unestablished } from './provenance.ts';

export const DEFAULT_RANDOM_SEED = 0x0012_3456;

/** The Miles LCG state (DAT_000a3478). */
let lcgState = 0;

/**
 * @mw2 miles_driver_sub_0761a3 0x000761a3
 * @fidelity exact
 */
export function milesSrand(seed: number): void {
  lcgState = seed >>> 0;
}

/**
 * @mw2 miles_driver_sub_07617f 0x0007617f
 * @fidelity exact
 */
export function milesRand(): number {
  lcgState = (Math.imul(lcgState, 0x41c64e6d) + 0x3039) >>> 0;
  return (lcgState >>> 16) & 0x7fff;
}

/** randomNextTable @0x152e00: entries 1..127 are used (index 0 unused). */
export const randomNextTable = new Int32Array(128);
/** randomRangeTable @0x152ffc: entries 0..126. */
export const randomRangeTable = new Int32Array(127);
let randomRangeCursor = 0;
let randomNextCursor = 0;

/**
 * Fills both tables. randomRangeTable gets raw LCG draws; randomNextTable gets
 * trunc(1024 * (S * (2*sqrt(90)/983010) - sqrt(90))) with S the sum of 30
 * draws - an Irwin-Hall approximation to N(0, 1024^2) (constants at 0x934ac
 * 90.0, 0x934b4 2.0, 0x934bc 1/983010, 0x934c4 1024.0; x87 order: sqrt(90)
 * is stored, then multiplied by 2 and by 1/983010).
 *
 * @mw2 random_tables_init 0x00049fe0
 * @fidelity partial
 * @divergence the seed is a parameter; the original's is the argv pointer
 */
export function randomTablesInit(seed = DEFAULT_RANDOM_SEED): void {
  if (seed === DEFAULT_RANDOM_SEED) {
    unestablished('random seed: the original uses the argv pointer address; a fixed default is used', 'random_tables_init');
  }
  milesSrand(seed);
  // The original writes the range table 1-based from a base one entry low,
  // i.e. into entries 0..126.
  for (let i = 0; i < 0x7f; i++) randomRangeTable[i] = milesRand();
  const root90 = Math.sqrt(90.0);
  const k = root90 * 2.0 * 1.0172836491999064e-6;
  for (let i = 1; i <= 0x7f; i++) {
    let s = 0;
    for (let j = 0; j < 0x1e; j++) s = (s + milesRand()) | 0;
    randomNextTable[i] = Math.trunc((s * k - root90) * 1024.0) | 0;
  }
  randomRangeCursor = 0;
  randomNextCursor = 0;
}

/**
 * Uniform 0..n-1 (for n <= 32768), from the table.
 *
 * @mw2 random_range 0x0004a070
 * @fidelity exact
 */
export function randomRange(n: number): number {
  const i = randomRangeCursor;
  randomRangeCursor = (randomRangeCursor + 1) % 0x7f;
  return randomRangeTable[i]! % (n | 0) | 0;
}

/**
 * Roughly N(0, 1024^2), bounded by +/-9714. Reads entries 1..127.
 *
 * @mw2 random_next 0x0004a0b0
 * @fidelity exact
 */
export function randomNext(): number {
  const i = randomNextCursor + 1;
  randomNextCursor = i % 0x7f;
  return randomNextTable[i]!;
}

/** Cursor state, for snapshots and the inspector. @portOnly */
export function randomCursors(): { range: number; next: number } {
  return { range: randomRangeCursor, next: randomNextCursor };
}
