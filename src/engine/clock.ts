/**
 * The simulation clock's globals. simTick counts 182 Hz ticks (the PIT
 * timer; see ramp_start for the evidence that a tick is 1/182 s) and
 * tickDelta is the ticks elapsed in the current frame. The functions that
 * advance them (sim_clock_step, sim_clock_reset) are ported with the frame
 * loop.
 */
import { LABEL } from '../generated/labels.gen.ts';
import { registerGlobals } from './globals.ts';
import { imageI32 } from './image.ts';

export const clock = registerGlobals(
  'clock',
  {
    simTick: 0,
    tickDelta: 0,
  },
  () => {
    clock.simTick = imageI32(LABEL.simTick, 0);
    clock.tickDelta = imageI32(LABEL.tickDelta, 0);
  },
);
