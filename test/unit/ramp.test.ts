import { describe, expect, it } from 'vitest';
import { newRamp, newRampAngle, rampAngleSetTarget, rampAngleStart, rampAngleStep, rampStart, rampStep } from '../../src/core/ramp.ts';
import { randomNext, randomRange, randomTablesInit } from '../../src/core/random.ts';

describe('ramp', () => {
  it('is an exponential approach, not linear', () => {
    const r = newRamp();
    expect(rampStart(r, 1000, 0, 1.0, 0)).toBe(1);
    expect(r.duration).toBe(182);
    // 91 ticks = half the time constant closes half the REMAINING gap
    expect(rampStep(r, 91)).toBe(500);
    expect(rampStep(r, 182)).toBe(750);
    // one step spanning a full duration snaps to target
    expect(rampStep(r, 364)).toBe(1000);
  });

  it('angle ramp turns the short way round', () => {
    const r = newRampAngle();
    rampAngleStart(r, 0, 0x1600000, 0.2, 0x1680000, 0); // from 352 deg toward 0
    const next = rampAngleStep(r, 10);
    expect(next).toBeGreaterThan(0x1600000); // moved forward through 360, not back
    rampAngleSetTarget(r, 0x1000000); // 256 deg folds to -104 deg
    expect(r.target).toBe(0x1000000 - 0x1680000);
  });
});

describe('random', () => {
  it('is deterministic for a seed, and range stays in bounds', () => {
    randomTablesInit(42);
    const a = Array.from({ length: 300 }, () => randomRange(7));
    randomTablesInit(42);
    const b = Array.from({ length: 300 }, () => randomRange(7));
    expect(a).toEqual(b);
    expect(a.every((v) => v >= 0 && v < 7)).toBe(true);
    const n = Array.from({ length: 127 }, () => randomNext());
    expect(Math.max(...n.map(Math.abs))).toBeLessThanOrEqual(9714);
  });
});
