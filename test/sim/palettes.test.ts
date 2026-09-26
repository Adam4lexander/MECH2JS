// Palette fades on the shipped palettes, through the port's DAC. A fade of
// N frames moves every component by trunc(k * delta / N) after k frames -
// the closed form of palette_fade_state_step's remainder carry, computed
// here without it - and lands exactly on the target, which
// palette_apply_pending then uploads. Every upload goes through the monitor
// brightness table. The start-of-mission fade-in and the end-of-mission fade
// leave their in-between DACs for the host, paced to their durations.
import { beforeAll, describe, expect, it } from 'vitest';
import { ExeImage } from '../../src/data/exe/ExeImage.ts';
import { ProjectFile } from '../../src/data/prj/ProjectFile.ts';
import { clock } from '../../src/engine/clock.ts';
import { ailTimerService } from '../../src/engine/miles/ail.ts';
import { bootMission } from '../../src/mission/load.ts';
import { mainLoopFrame } from '../../src/mission/mainLoop.ts';
import { paletteApplySlot, palettes, paletteStartFade } from '../../src/sim/world/palettes.ts';
import { paletteFadeScreenToPreset } from '../../src/mission/end.ts';
import { gameSource, hasGameData, installFiles } from '../support/env.ts';

let exe: ExeImage;
let prj: ProjectFile;
let files: Map<string, Uint8Array>;

function frame(n = 1) {
  for (let k = 0; k < n; k++) {
    for (let i = 0; i < 7; i++) ailTimerService();
    mainLoopFrame();
  }
}

const pal = (slot: number) => prj.readResource('PAL', palettes.paletteResourceIds[slot]!)!;

/** the table[level] brightness_tables_build computes, recomputed */
const table = (level: number) => Array.from({ length: 64 }, (_, i) => Math.trunc(Math.pow(i / 63, 1 / (level / 16 + 0.5)) * 63 + 1e-9));

/** the waits palette_fade_used_colours spreads over maxDelta passes */
function totalWaits(duration: number, maxDelta: number): number {
  const inc = Math.floor((duration * 0x10000) / maxDelta);
  let pace = 0x8000;
  let n = 0;
  for (let i = 0; i < maxDelta; i++) {
    pace += inc;
    n += pace >>> 16;
    pace &= 0xffff;
  }
  return n;
}

describe.runIf(hasGameData)('palette fades', () => {
  beforeAll(async () => {
    const src = gameSource();
    exe = ExeImage.fromExe(await src.read('MW2.EXE'));
    prj = new ProjectFile(await src.read('MW2.PRJ'));
    files = installFiles();
  });

  it('builds the brightness tables: level 8 the identity, 63 always 63, darker below and brighter above', () => {
    bootMission({ exe, prj, looseFiles: files, mission: 'AMY_SCN1' });
    const t = palettes.brightnessTables;
    for (let l = 0; l < 16; l++) {
      expect(Array.from(t.subarray(l * 64, l * 64 + 64)), `table ${l}`).toEqual(table(l));
    }
    expect(palettes.brightnessShown).toBe(8);
  });

  it('fades the screen to PAL 1 (ALLBLK) before the loop: from the black DAC, nothing moves', () => {
    bootMission({ exe, prj, looseFiles: files, mission: 'AMY_SCN1' });
    const p1 = prj.readResource('PAL', 1)!;
    expect(prj.resourceName('PAL', 1)).toBe('ALLBLK');
    expect(Math.max(...Array.from(p1))).toBe(0);
    expect(Array.from(palettes.dac)).toEqual(new Array(0x300).fill(0));
    expect(palettes.dacPlayback).toEqual([]);
    expect([palettes.paletteCurrentSlot, palettes.paletteRestoreSlot]).toEqual([0x10, 0x10]);
  });

  it('a flash steps by trunc(k * delta / N), lands on the target, comes back and is restored exactly', () => {
    bootMission({ exe, prj, looseFiles: files, mission: 'AMY_SCN1' });
    frame(80);
    while (palettes.paletteFadeStepsLeft > 0) frame();
    frame(2);
    const base = palettes.paletteCurrentSlot;
    const src = pal(base);
    const dst = pal(0x11);
    expect(Array.from(palettes.dac)).toEqual(Array.from(src.subarray(0, 0x300)));
    expect(paletteStartFade(0x11, 0x16c, 1)).toBe(1);
    const n = palettes.paletteFadeStepsLeft;
    expect(n).toBe(Math.max(1, Math.trunc(((0x16c >> 1) * 0x10000) / clock.tickDelta) >> 16));
    for (let k = 1; k <= n; k++) {
      frame();
      for (let i = 0; i < 0x300; i++) {
        const want = (src[i]! + Math.trunc((k * (dst[i]! - src[i]!)) / n)) & 0xff;
        if (palettes.dac[i] !== want) expect(`${k}/${n} component ${i}: ${palettes.dac[i]}`).toBe(`${k}/${n} component ${i}: ${want}`);
      }
    }
    expect(Array.from(palettes.dac)).toEqual(Array.from(dst.subarray(0, 0x300)));
    // the return leg, then palette_apply_pending's exact upload of the restore slot
    while (palettes.paletteFadeStepsLeft > 0) frame();
    frame();
    expect(palettes.paletteCurrentSlot).toBe(palettes.paletteRestoreSlot);
    expect(Array.from(palettes.dac)).toEqual(Array.from(pal(palettes.paletteRestoreSlot).subarray(0, 0x300)));
  });

  it('every upload goes through the brightness table', () => {
    bootMission({ exe, prj, looseFiles: files, mission: 'AMY_SCN1' });
    palettes.brightnessShown = 13;
    paletteApplySlot(0x10);
    const t = table(13);
    const src = pal(0x10);
    expect(Array.from(palettes.dac)).toEqual(Array.from(src.subarray(0, 0x300), (c) => t[c]!));
    expect(Array.from(palettes.paletteDac)).toEqual(Array.from(src.subarray(0, 0x300)));
  });

  it('the mission end fades the screen to slot 0x10 over 0x5a waits and uploads it', () => {
    bootMission({ exe, prj, looseFiles: files, mission: 'AMY_SCN1' });
    frame(80);
    const before = palettes.dac.slice();
    palettes.dacPlayback.length = 0;
    paletteFadeScreenToPreset(0);
    // every colour counts as used (the 3D view's are the GPU's): the largest distance to slot 0x10 sets the passes
    const target = pal(0x10);
    let maxd = 0;
    for (let i = 0; i < 0x300; i++) maxd = Math.max(maxd, Math.abs(before[i]! - target[i]!));
    const q = palettes.dacPlayback;
    expect(q.reduce((n, f) => n + f.waits, 0)).toBe(totalWaits(0x5a, maxd));
    expect(Array.from(palettes.dac)).toEqual(Array.from(pal(0x10).subarray(0, 0x300)));
  });
});
