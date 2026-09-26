/**
 * The mission's whole-second clock, which every objective time limit is
 * measured in.
 */
import { cdiv } from '../core/int/cint.ts';
import { LABEL } from '../generated/labels.gen.ts';
import { clock } from '../engine/clock.ts';
import { registerGlobals } from '../engine/globals.ts';
import { imageI32 } from '../engine/image.ts';

export const missionClock = registerGlobals(
  'missionClock',
  {
    /** 0xd4030: simTick / 0xb6 (182 ticks a second) */
    missionSeconds: 0,
  },
  () => {
    missionClock.missionSeconds = imageI32(LABEL.missionSeconds, 0);
  },
);

/**
 * missionSeconds = simTick / 0xb6, a signed divide (idiv).
 *
 * @mw2 mission_clock_update 0x000170c0
 * @fidelity exact
 */
export function missionClockUpdate(): void {
  missionClock.missionSeconds = cdiv(clock.simTick | 0, 0xb6);
}
