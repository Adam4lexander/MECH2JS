/**
 * Ramp and RampAngle: the game's time-based smoothers.
 *
 * NOT linear ramps. `duration` is a time constant in 182 Hz ticks: each step
 * closes (target - current) * elapsed / duration of the REMAINING gap and
 * re-stamps lastTick - an exponential approach that snaps to target once one
 * step's elapsed time reaches duration (see Ramp.duration in mw2_types.h).
 *
 * The originals read the global simTick; here it is passed in. Behaviour is
 * identical - the global is the only thing they read.
 */

import { cdiv, cmod, ftrunc } from './int/cint.ts';

/** Ramp - 16 (0x10) bytes. */
export interface Ramp {
  /** +0x00 simTick at the previous step */
  lastTick: number;
  /** +0x04 where it is heading */
  target: number;
  /** +0x08 where it is now */
  current: number;
  /** +0x0c time constant in 182 Hz ticks */
  duration: number;
}

/** RampAngle - Ramp plus a modulus (always 0x1680000, a full turn, in the game). */
export interface RampAngle extends Ramp {
  modulus: number;
}

export const newRamp = (): Ramp => ({ lastTick: 0, target: 0, current: 0, duration: 0 });
export const newRampAngle = (): RampAngle => ({ lastTick: 0, target: 0, current: 0, duration: 0, modulus: 0 });

/** The tick rate: 182.0 at 0x9342c (ramp_start) and 0x93434 (ramp_angle_start). */
export const TICKS_PER_SECOND = 182;

/**
 * @mw2 ramp_start 0x00049b40
 * @fidelity exact
 */
export function rampStart(ramp: Ramp, target: number, current: number, seconds: number, simTick: number): number {
  ramp.duration = ftrunc(seconds * 182.0);
  ramp.current = current | 0;
  ramp.lastTick = simTick | 0;
  ramp.target = target | 0;
  return ramp.duration > 0 ? 1 : 0;
}

/**
 * @mw2 ramp_step 0x00049b80
 * @fidelity exact
 */
export function rampStep(ramp: Ramp, simTick: number): number {
  const gap = (ramp.target - ramp.current) | 0;
  const d = cdiv(Math.imul(gap, (simTick - ramp.lastTick) | 0), ramp.duration);
  if ((gap < 0 && d <= gap) || (gap > 0 && gap <= d)) ramp.current = ramp.target;
  else ramp.current = (ramp.current + d) | 0;
  ramp.lastTick = simTick | 0;
  return ramp.current;
}

/**
 * @mw2 ramp_angle_start 0x00049be0
 * @fidelity exact
 */
export function rampAngleStart(ramp: RampAngle, target: number, current: number, seconds: number, modulus: number, simTick: number): number {
  ramp.duration = ftrunc(seconds * 182.0);
  ramp.current = current | 0;
  ramp.lastTick = simTick | 0;
  ramp.modulus = modulus | 0;
  ramp.target = target | 0;
  return ramp.duration > 0 ? 1 : 0;
}

/** Fold v (already reduced mod m) into +/- m/2. */
function fold(v: number, m: number): number {
  const half = m >> 1;
  if (half < v) return (v - m) | 0;
  if (v < -half) return (v + m) | 0;
  return v;
}

/**
 * @mw2 ramp_angle_step 0x00049c20
 * @fidelity exact
 */
export function rampAngleStep(ramp: RampAngle, simTick: number): number {
  const gap = fold(cmod((ramp.target - ramp.current) | 0, ramp.modulus), ramp.modulus);
  const d = cdiv(Math.imul(gap, (simTick - ramp.lastTick) | 0), ramp.duration);
  if ((gap < 0 && d <= gap) || (gap > 0 && gap <= d)) ramp.current = ramp.target;
  else ramp.current = (ramp.current + d) | 0;
  ramp.current = cmod(ramp.current, ramp.modulus);
  ramp.lastTick = simTick | 0;
  return ramp.current;
}

/**
 * @mw2 ramp_angle_set_target 0x00049cb0
 * @fidelity exact
 */
export function rampAngleSetTarget(ramp: RampAngle, angle: number): void {
  ramp.target = fold(cmod(angle, ramp.modulus), ramp.modulus);
}

/**
 * *p += (p[1] - *p) >> p[2], over {current, target, shift}.
 *
 * @mw2 lowpass_step 0x00049cf0
 * @fidelity exact
 */
export function lowpassStep(p: Int32Array | number[]): number {
  p[0] = (p[0]! + ((p[1]! - p[0]!) >> p[2]!)) | 0;
  return p[0]!;
}
