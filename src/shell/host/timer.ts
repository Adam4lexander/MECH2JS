/**
 * The shell's clock: a 250 Hz AIL timer whose callback counts ticks
 * (decompiled/mw2shell/src/sound/sound_detect.c). The host advances it in
 * real time (hardware.timeMs).
 */
import { hardware } from './hardware.ts';

/**
 * Starts the tick counter the first time it is called: AIL started if
 * nothing has, the callback at 0x3f494 registered at 250 Hz.
 *
 * @mw2shell timer_start 0x0003f4a0
 * @fidelity partial
 * @divergence the host's clock is the timer; AIL's start-up is the host's audio
 */
export function timerStart(): void {
  // the host advances hardware.timeMs
}

/**
 * The tick count times 4: milliseconds.
 *
 * @mw2shell timer_read 0x0003f508
 * @fidelity exact
 */
export function timerRead(): number {
  return Math.floor(hardware.timeMs / 4) * 4;
}
