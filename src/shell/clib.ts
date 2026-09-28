/**
 * The C runtime's random numbers and clock as MW2SHELL.EXE links them
 * (Watcom's rand / srand, filed with the Miles code at 0x4bc33.., and
 * clock): screen_register seeds rand from clock() and draws a new pilot's
 * starting honor from it; screen_training seeds it too.
 */
import { SHELL_LABEL } from '../generated/shell/labels.gen.ts';
import { mem } from './memory.ts';
import { hardware } from './host/hardware.ts';

/**
 * The LCG step: seed = seed * 0x41c64e6d + 0x3039; bits 16..30 of the new
 * seed. The seed is randSeed (rand_state returns its address).
 *
 * @mw2shell rand 0x0004bc39
 * @fidelity exact
 */
export function rand(): number {
  const m = mem();
  const seed = (Math.imul(m.i32(SHELL_LABEL.randSeed), 0x41c64e6d) + 0x3039) | 0;
  m.setI32(SHELL_LABEL.randSeed, seed);
  return (seed >>> 16) & 0x7fff;
}

/**
 * @mw2shell srand 0x0004bc5d
 * @fidelity exact
 */
export function srand(seed: number): void {
  mem().setI32(SHELL_LABEL.randSeed, seed);
}

/**
 * Upper-cases a C string in place (toupper on each character up to its
 * strlen, re-measured every step) - Watcom's strupr. Returns the string.
 *
 * @mw2shell strupr 0x00010090
 * @fidelity exact
 */
export function strupr(addr: number): number {
  const m = mem();
  for (let i = 0; i < m.cstr(addr).length; i++) {
    const c = m.u8(addr + i);
    if (c >= 0x61 && c <= 0x7a) m.setU8(addr + i, c - 0x20);
  }
  return addr;
}

/**
 * clock(): hundredths of a second since the program started (the DOS time
 * of day less the start-up time, wrapping at midnight).
 *
 * @mw2shell clock_impl 0x0005a7a4
 * @fidelity partial
 * @divergence counts the host's timer (hardware.timeMs, which runs from the machine's start, not the program's) rather than the DOS time of day; only rand's seed depends on it
 */
export function clock(): number {
  return Math.floor(hardware.timeMs / 10) | 0;
}
