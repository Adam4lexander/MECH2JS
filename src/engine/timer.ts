/**
 * The 182 Hz timer and its stopwatches (clib_start, 0x61df8..0x61ffc).
 *
 * In the original, a Miles timer programmed by audio_timer_init
 * (AIL_set_timer_divisor 0x199c: 1193182 Hz / 6556 = 182.0 Hz) calls the
 * interrupt routine at 0x61df8 182 times a second. It increments two
 * counters, each unless its pause bit in 0xa192a is set:
 *
 *   0xa1b2e  family 0x80   frozen by bit 0x200 (timer_set_paused mask 0x80)
 *   0xa1b32  family 0x100  frozen by bit 0x100 (timer_set_paused mask 0x100)
 *
 * A stopwatch is a slot in one of two 64-entry base tables (0xa192e for
 * family 0x80, 0xa1a2e for the other); its elapsed time is counter - base.
 * A base of 0 marks a free slot, which is why stopwatch_create bumps a zero
 * counter to 1.
 *
 * The port has no interrupt. The host calls timerInterrupt() once per 1/182 s
 * of real time it wants the game to see (app/Host.ts), and a test calls it
 * directly, which is what makes a run replayable.
 */
import { registerGlobals } from './globals.ts';

const SLOTS = 64;

export const timer = registerGlobals(
  'timer',
  {
    /** 0xa192a: pause bits the interrupt tests (0x200 freezes counter80, 0x100 counter100) */
    timerPauseBits: 0,
    /** 0xa1b2e: the counter family-0x80 stopwatches read (the sim clock's) */
    counter80: 0,
    /** 0xa1b32: the counter the other stopwatches read */
    counter100: 0,
    /** 0xa192e: bases of the family-0x80 stopwatches */
    slotBase80: new Int32Array(SLOTS),
    /** 0xa1a2e: bases of the other stopwatches */
    slotBase100: new Int32Array(SLOTS),
  },
  () => {
    timer.timerPauseBits = 0;
    timer.counter80 = 0;
    timer.counter100 = 0;
    timer.slotBase80.fill(0);
    timer.slotBase100.fill(0);
  },
);

/**
 * One timer interrupt: the routine at 0x61df8, reproduced exactly. It has no
 * function of its own in the decompilation (Miles calls it through the
 * pointer AIL_register_timer was given), so it carries no @mw2 tag.
 *
 * @portOnly the timer routine at 0x61df8 (no Ghidra function)
 */
export function timerInterrupt(): void {
  const t = timer;
  if ((t.timerPauseBits & 0x200) === 0) t.counter80 = (t.counter80 + 1) | 0;
  if ((t.timerPauseBits & 0x100) === 0) t.counter100 = (t.counter100 + 1) | 0;
}

function table(slot: number): [Int32Array, number, number] {
  return (slot & 0x80) === 0 ? [timer.slotBase100, slot, timer.counter100] : [timer.slotBase80, slot ^ 0x80, timer.counter80];
}

/**
 * Claims a free slot and stamps it with the current counter. Returns the
 * slot, carrying 0x80 for the first family, or 0xffff when none is free.
 *
 * @mw2 stopwatch_create 0x00061e28
 * @fidelity exact
 * @divergence the scan stops at the table's 64 entries; the original scans on for a zero or -1 word, which only matters past 64 live stopwatches
 */
export function stopwatchCreate(family: number): number {
  const fam80 = (family & 0x80) !== 0;
  const base = fam80 ? timer.slotBase80 : timer.slotBase100;
  for (let i = 0; i < SLOTS; i++) {
    if (base[i] === 0) {
      const c = fam80 ? timer.counter80 : timer.counter100;
      base[i] = c === 0 ? 1 : c;
      return fam80 ? i | 0x80 : i;
    }
    if (base[i] === -1) break;
  }
  return 0xffff;
}

/**
 * @mw2 stopwatch_elapsed 0x00061eb3
 * @fidelity exact
 */
export function stopwatchElapsed(slot: number): number {
  const [base, i, counter] = table(slot);
  return (counter - base[i]!) | 0;
}

/**
 * @mw2 stopwatch_reset 0x00061ef3
 * @fidelity exact
 */
export function stopwatchReset(slot: number): void {
  const [base, i, counter] = table(slot);
  base[i] = counter;
}

/**
 * @mw2 stopwatch_set 0x00061f33
 * @fidelity exact
 */
export function stopwatchSet(slot: number, elapsed: number): void {
  const [base, i, counter] = table(slot);
  base[i] = (counter - elapsed) | 0;
}

/**
 * @mw2 stopwatch_free 0x00061f76
 * @fidelity exact
 */
export function stopwatchFree(slot: number): void {
  const [base, i] = table(slot);
  base[i] = 0;
}

/**
 * Freezes (paused != 0) or resumes the counters named by mask: 0x80 is
 * counter80 (bit 0x200), 0x100 counter100 (bit 0x100). The test of `paused`
 * is on its low 16 bits.
 *
 * @mw2 timer_set_paused 0x00061fb0
 * @fidelity exact
 */
export function timerSetPaused(mask: number, paused: number): void {
  let bits = 0;
  if (mask & 0x80) bits = 0x200;
  if (mask & 0x100) bits |= 0x100;
  if ((paused & 0xffff) === 0) timer.timerPauseBits &= ~bits;
  else timer.timerPauseBits |= bits;
}
