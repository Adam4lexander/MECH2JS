// The timer, the stopwatches and sim_clock_step, driven one interrupt at a
// time as the host does.
import { beforeEach, describe, expect, it } from 'vitest';
import { resetAllGlobals } from '../../src/engine/globals.ts';
import { audioTimerInit, clock, simClockReset, simClockStep } from '../../src/engine/clock.ts';
import { stopwatchCreate, stopwatchElapsed, timer, timerInterrupt, timerSetPaused } from '../../src/engine/timer.ts';

const tick = (n: number) => {
  for (let i = 0; i < n; i++) timerInterrupt();
};

describe('timer and sim clock', () => {
  beforeEach(() => {
    resetAllGlobals();
    // the timer has been running since it was started (a base of 0 would read as a free slot)
    tick(1);
    audioTimerInit();
    simClockReset();
  });

  it('claims the three stopwatches audio_timer_init claims, in its order', () => {
    // 0x100 first (slot 0 of the other family), then two of family 0x80
    expect(clock.dat00095844).toBe(0);
    expect(clock.simStopwatch).toBe(0x80);
    expect(clock.netStopwatch).toBe(0x81);
    expect(stopwatchCreate(0x80)).toBe(0x82);
  });

  it('tickDelta is the interrupts since the last frame, and a frame with none holds simTick', () => {
    tick(5);
    simClockStep();
    expect([clock.simTick, clock.tickDelta]).toEqual([5, 5]);
    simClockStep();
    expect([clock.simTick, clock.tickDelta]).toEqual([5, 0]);
    tick(3);
    simClockStep();
    expect([clock.simTick, clock.tickDelta]).toEqual([8, 3]);
  });

  it('pausing freezes only the family-0x80 counter, which is the sim clock', () => {
    timerSetPaused(0x80, 1);
    tick(10);
    expect(timer.counter80).toBe(1);
    expect(timer.counter100).toBe(11);
    simClockStep();
    expect(clock.tickDelta).toBe(0);
    timerSetPaused(0x80, 0);
    tick(2);
    simClockStep();
    expect([clock.simTick, clock.tickDelta]).toEqual([2, 2]);
  });

  it('fixed-step mode: +12 a frame with the counter frozen, then real time resumes from the stepped clock', () => {
    tick(4);
    clock.dat00095828 = 1;
    simClockStep(); // reads 4 real ticks, then enters mode 3
    expect([clock.simTick, clock.tickDelta, clock.simClockMode]).toEqual([4, 4, 3]);
    tick(100); // frozen
    simClockStep();
    simClockStep();
    expect([clock.simTick, clock.tickDelta]).toEqual([28, 12]);
    clock.dat00095828 = 0;
    simClockStep(); // one more +12, then leaves mode 3 and sets the stopwatch to it
    expect([clock.simTick, clock.tickDelta, clock.simClockMode]).toEqual([40, 12, 0]);
    tick(1);
    simClockStep();
    expect([clock.simTick, clock.tickDelta]).toEqual([41, 1]);
    expect(stopwatchElapsed(clock.simStopwatch)).toBe(41);
  });

  it('time compression: the frame reports 8d while the clock moves 9d (the original\'s quirk)', () => {
    clock.timeCompression = 1;
    tick(2);
    simClockStep();
    expect([clock.simTick, clock.tickDelta]).toEqual([18, 16]);
    tick(1);
    simClockStep();
    expect([clock.simTick, clock.tickDelta]).toEqual([27, 8]);
  });

  it('time expansion: the frame reports d/4, and a delta that rounds to 0 holds the clock', () => {
    clock.timeExpansion = 1;
    tick(8);
    simClockStep();
    expect([clock.simTick, clock.tickDelta]).toEqual([10, 2]);
    tick(3);
    simClockStep();
    expect([clock.simTick, clock.tickDelta]).toEqual([10, 0]);
  });

  it('the frame-rate cap waits for simFrameMinTicks', () => {
    clock.simFrameMinTicks = 6;
    tick(1);
    simClockStep(); // the default wait fires one interrupt per spin
    expect([clock.simTick, clock.tickDelta]).toEqual([6, 6]);
  });
});
