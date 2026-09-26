/**
 * The simulation clock. simTick counts 182 Hz ticks (see engine/timer.ts for
 * the evidence) and tickDelta is the ticks elapsed in the current frame.
 * sim_clock_step, the second call in main's loop, advances both from the
 * sim stopwatch.
 */
import { quirk } from '../core/provenance.ts';
import { LABEL } from '../generated/labels.gen.ts';
import { registerGlobals } from './globals.ts';
import { imageI32 } from './image.ts';
import { stopwatchCreate, stopwatchElapsed, stopwatchReset, stopwatchSet, timerInterrupt, timerSetPaused } from './timer.ts';

export const clock = registerGlobals(
  'clock',
  {
    simTick: 0,
    tickDelta: 0,
    /** 0x95848: simTick as of the previous frame */
    simClockLast: 0,
    /** 0 reads the stopwatch; 3 steps a fixed 12 ticks a frame (see sim_clock_step) */
    simClockMode: 0,
    /** 0x9584c: simClockMode saved while in mode 3 */
    dat0009584c: 0,
    /**
     * 0x95828: while non-zero, sim_clock_step enters (and stays in) the
     * fixed-step mode 3. Nothing known in MW2.EXE writes it; the port's
     * editor Step uses it (engine/mainLoop.ts), which is what it is shaped for.
     */
    dat00095828: 0,
    timeCompression: 0,
    timeExpansion: 0,
    simFrameMinTicks: 0,
    simStopwatch: 0,
    netStopwatch: 0,
    /** 0x95844: the third stopwatch audio_timer_init claims (family 0x100); what reads it is not established */
    dat00095844: 0,
    /** 0x95850: set once audio_timer_init has started the timer; sim_clock_step does nothing until then */
    dat00095850: 0,
  },
  () => {
    const c = clock;
    c.simTick = imageI32(LABEL.simTick, 0);
    c.tickDelta = imageI32(LABEL.tickDelta, 0);
    c.simClockLast = imageI32(LABEL.simClockLast, 0);
    c.simClockMode = imageI32(LABEL.simClockMode, 0);
    c.dat0009584c = imageI32(0x9584c, 0);
    c.dat00095828 = imageI32(0x95828, 0);
    c.timeCompression = imageI32(LABEL.timeCompression, 0);
    c.timeExpansion = imageI32(LABEL.timeExpansion, 0);
    c.simFrameMinTicks = imageI32(LABEL.simFrameMinTicks, 0);
    c.simStopwatch = imageI32(LABEL.simStopwatch, 0);
    c.netStopwatch = imageI32(LABEL.netStopwatch, 0);
    c.dat00095844 = imageI32(0x95844, 0);
    c.dat00095850 = imageI32(0x95850, 0);
  },
);

/**
 * What the busy-wait in sim_clock_step spins on. The original's timer
 * interrupt fires by itself while it spins; the port's host replaces this
 * with one that reads real time. The default fires one interrupt, which
 * keeps a headless run deterministic.
 */
let waitForTick: () => void = timerInterrupt;

/** @portOnly lets the host decide how the frame-rate cap's busy-wait passes time */
export function setClockWait(fn: () => void): void {
  waitForTick = fn;
}

/**
 * The timer half of audio_timer_init: claims the three stopwatches and
 * resets them, once. AIL_startup and the Miles timer registration it also
 * does are the audio port's (the port's timer is engine/timer.ts).
 *
 * @mw2 audio_timer_init 0x00015690
 * @fidelity partial
 * @divergence the AIL calls are not made; the host drives timerInterrupt instead of a Miles timer
 */
export function audioTimerInit(): void {
  const c = clock;
  if (c.dat00095850 === 0) {
    c.dat00095844 = (stopwatchCreate(0x100) << 16) >> 16;
    c.simStopwatch = (stopwatchCreate(0x80) << 16) >> 16;
    c.netStopwatch = (stopwatchCreate(0x80) << 16) >> 16;
    stopwatchReset(c.dat00095844);
    stopwatchReset(c.netStopwatch);
    stopwatchReset(c.simStopwatch);
    c.dat00095850 = 1;
  }
  c.simClockLast = 0;
  c.simTick = 0;
}

/**
 * Called by main once, just before the frame loop: mission time starts here.
 *
 * @mw2 sim_clock_reset 0x000159e0
 * @fidelity exact
 */
export function simClockReset(): void {
  const c = clock;
  stopwatchReset(c.dat00095844);
  stopwatchReset(c.netStopwatch);
  stopwatchReset(c.simStopwatch);
  c.simClockLast = 0;
  c.simTick = 0;
}

/**
 * Once per frame: simTick from the stopwatch (normal mode) or +12 (mode 3),
 * tickDelta = simTick - simClockLast, then time compression or expansion.
 *
 * QUIRK, confirmed in the disassembly (0x1585e, 0x15887): under compression
 * tickDelta becomes 8d but simTick is advanced by that 8d on top of the d
 * already in it, so the clock moves 9d while the frame reports 8d; under
 * expansion it moves d + d/4 while the frame reports d/4.
 *
 * @mw2 sim_clock_step 0x00015760
 * @fidelity exact
 */
export function simClockStep(): void {
  const c = clock;
  if (c.dat00095850 === 0) return;
  if (c.simClockMode === 0) {
    c.simTick = stopwatchElapsed(c.simStopwatch);
    if (0 < c.simFrameMinTicks) {
      while (((c.simTick - c.simClockLast) | 0) < c.simFrameMinTicks) {
        waitForTick();
        c.simTick = stopwatchElapsed(c.simStopwatch);
      }
    }
    if (c.dat00095828 !== 0) {
      c.dat0009584c = c.simClockMode;
      c.simClockMode = 3;
      timerSetPaused(0x80, 1);
    }
  } else if (c.simClockMode === 3) {
    c.simTick = (c.simTick + 0xc) | 0;
    if (c.dat00095828 === 0) {
      c.simClockMode = c.dat0009584c;
      timerSetPaused(0x80, 0);
      stopwatchSet(c.simStopwatch, c.simTick);
    }
  }
  c.tickDelta = (c.simTick - c.simClockLast) | 0;
  if (c.timeCompression !== 0 || c.timeExpansion !== 0) {
    if (c.timeCompression !== 0) c.tickDelta = (c.tickDelta * 8) | 0;
    else c.tickDelta >>= 2;
    quirk('time compression/expansion advances simTick by the adjusted delta on top of the real one', 'sim_clock_step');
    c.simTick = (c.simTick + c.tickDelta) | 0;
    stopwatchSet(c.simStopwatch, c.simTick);
  }
  if (c.tickDelta < 1) {
    c.tickDelta = 0;
    c.simTick = c.simClockLast;
  }
  c.simClockLast = c.simTick;
}
