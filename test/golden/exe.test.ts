// The x87 constants the port hard-codes, as MW2.EXE holds them.
import { beforeAll, describe, expect, it } from 'vitest';
import { ExeImage } from '../../src/data/exe/ExeImage.ts';
import { K_DEG, K_SCALE, K_SIN, K_STEP } from '../../src/core/angle/trig.ts';
import { gameSource, hasGameData } from '../support/env.ts';

describe.runIf(hasGameData)('MW2.EXE image', () => {
  let exe: ExeImage;
  beforeAll(async () => {
    exe = ExeImage.fromExe(await gameSource().read('MW2.EXE'));
  });

  it('holds the trig constants the port hard-codes', () => {
    expect(exe.f64(0x90fac)).toBe(K_SIN);
    expect(exe.f64(0x90fb4)).toBe(K_SCALE);
    expect(exe.f64(0x90fbc)).toBe(K_STEP);
    expect(exe.f64(0x90fc4)).toBe(K_DEG);
    expect(exe.f64(0x90fec)).toBe(536870912.0); // matrix_renormalise's K
    expect(exe.f64(0x9342c)).toBe(182.0); // ramp_start's tick rate
    expect(exe.f64(0x934bc)).toBe(1.0172836491999064e-6); // random_tables_init
  });
});
