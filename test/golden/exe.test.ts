// MW2.EXE unpacked by the port against decompiled/mw2/build/image.bin, byte
// for byte, plus the x87 constants the port hard-codes.
import fs from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { ExeImage } from '../../src/data/exe/ExeImage.ts';
import { K_DEG, K_SCALE, K_SIN, K_STEP } from '../../src/core/angle/trig.ts';
import { buildPath, gameSource, hasDecompiled, hasGameData } from '../support/env.ts';

describe.runIf(hasGameData && hasDecompiled)('MW2.EXE image', () => {
  let exe: ExeImage;
  beforeAll(async () => {
    exe = ExeImage.fromExe(await gameSource().read('MW2.EXE'));
  });

  it('is byte-identical to build/image.bin', () => {
    const want = new Uint8Array(fs.readFileSync(buildPath('image.bin')));
    expect(exe.low).toBe(0x10000);
    expect(exe.bytes.length).toBe(want.length);
    let first = -1;
    let count = 0;
    for (let i = 0; i < want.length; i++) {
      if (want[i] !== exe.bytes[i]) {
        if (first < 0) first = i;
        count++;
      }
    }
    expect({ first: first < 0 ? -1 : (first + exe.low).toString(16), count }).toEqual({ first: -1, count: 0 });
  });

  it('matches layout.json', () => {
    const layout = JSON.parse(fs.readFileSync(buildPath('layout.json'), 'utf8'));
    expect(exe.image.entryPoint).toBe(layout.entry_point);
    expect(exe.image.initialEsp).toBe(layout.initial_esp);
    expect(exe.image.fixups.off32).toBe(layout.fixups.off32);
    expect(exe.image.objects.map((o) => o.base)).toEqual(layout.objects.map((o: { base: number }) => o.base));
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
