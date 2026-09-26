// Targeting and the target readout, driven through the keyboard: NEXT_TARGET
// ('t', GAMEKEY.MAP command 0x44 -> control advance_target) walks the ring
// mechs -> gamethings -> tracked objects with mode 8 (mechs and gamethings)
// from the current target, and TARGET_NEAREST_ENEMY ('e', 0x47) keeps the
// smallest slant range among the enemies mode 0x40008 admits. The expected
// targets are worked out from the validators' own verdicts over every
// candidate, in ring order, not recorded from a run. Then the target
// readout (hudWidgets[14]) must put text pixels in its pane.
import { beforeAll, describe, expect, it } from 'vitest';
import { ExeImage } from '../../src/data/exe/ExeImage.ts';
import { ProjectFile } from '../../src/data/prj/ProjectFile.ts';
import { timerInterrupt } from '../../src/engine/timer.ts';
import { vfxWindowClear } from '../../src/engine/vfx/vfx.ts';
import { bootMission } from '../../src/mission/load.ts';
import { mainLoopFrame } from '../../src/mission/mainLoop.ts';
import { aiValidateGamething, aiValidateTarget, targeting } from '../../src/sim/ai/targeting.ts';
import { widget } from '../../src/sim/cockpit/hud.ts';
import { KeyboardDriver } from '../../src/sim/controls/giddi.ts';
import { input } from '../../src/sim/controls/input.ts';
import { defaultCanvas } from '../../src/sim/display/video.ts';
import { mechs } from '../../src/sim/mech/mechGlobals.ts';
import { things } from '../../src/sim/things/gameThings.ts';
import { gameSource, hasGameData, installFiles } from '../support/env.ts';

let exe: ExeImage;
let prj: ProjectFile;
let files: Map<string, Uint8Array>;

function frame(ticks = 7) {
  for (let i = 0; i < ticks; i++) timerInterrupt();
  mainLoopFrame();
}

/** Every mech and gamething handle the validators accept for the player under `mode`, in ring order, with its slant range. */
function candidates(mode: number): { handle: number; slant: number }[] {
  const p = mechs.mechTable[mechs.playerMechIndex]!;
  const saved = { x: p.targetX, y: p.targetY, z: p.targetZ, h: p.desiredHeading, s: p.targetSlantRange, d: p.targetDistance, t: p.torsoTilt };
  const out: { handle: number; slant: number }[] = [];
  const reticle = targeting.playerTargetFromReticle;
  targeting.playerTargetFromReticle = 0;
  for (let i = 0; i < mechs.mechCount; i++) if (aiValidateTarget(mechs.playerMechIndex, i, mode) === 1) out.push({ handle: 0x200 | i, slant: p.targetSlantRange });
  for (let i = 0; i < things.gameThingCount; i++) if (aiValidateGamething(mechs.playerMechIndex, i, mode) === 1) out.push({ handle: 0x400 | i, slant: p.targetSlantRange });
  targeting.playerTargetFromReticle = reticle;
  Object.assign(p, { targetX: saved.x, targetY: saved.y, targetZ: saved.z, desiredHeading: saved.h, targetSlantRange: saved.s, targetDistance: saved.d, torsoTilt: saved.t });
  return out;
}

const ringPos = (h: number) => ((h & 0xf00) === 0x200 ? 0 : (h & 0xf00) === 0x400 ? 0x10000 : 0x20000) + (h & 0xff);

describe.runIf(hasGameData)('targeting', () => {
  beforeAll(async () => {
    const src = gameSource();
    exe = ExeImage.fromExe(await src.read('MW2.EXE'));
    prj = new ProjectFile(await src.read('MW2.PRJ'));
    files = installFiles();
  });

  it("'t' steps to the next acceptable target, 'e' to the nearest enemy, and the readout draws it", () => {
    bootMission({ exe, prj, looseFiles: files, mission: 'AMY_SCN1' });
    const kb = input.devices[input.keyboardDevice]!.driver as KeyboardDriver;
    const p = mechs.mechTable[mechs.playerMechIndex]!;
    for (let f = 0; f < 400 && p.loadout!.status !== 2; f++) frame();
    expect(p.loadout!.status).toBe(2);

    // NEXT_TARGET, twice: each press lands on the first candidate after the current one in ring order
    for (let press = 0; press < 2; press++) {
      const before = p.targetHandle;
      const all = candidates(8);
      expect(all.length).toBeGreaterThan(0);
      const restart = (before & 0x1000) !== 0;
      const after = restart ? -1 : ringPos(before);
      const want = all.find((c) => ringPos(c.handle) > after) ?? all[0]!;
      kb.isr(0x14);
      frame();
      kb.isr(0x94);
      frame();
      expect((p.targetHandle & 0x1000) !== 0 ? 'none' : p.targetHandle.toString(16)).toBe(want.handle.toString(16));
    }

    // TARGET_NEAREST_ENEMY: the smallest slant range among the enemies, kept if within 1750 m
    const before = p.targetHandle;
    const enemies = candidates(0x40008);
    kb.isr(0x12);
    frame();
    kb.isr(0x92);
    frame();
    if (enemies.length === 0 || Math.min(...enemies.map((c) => c.slant)) > 0x2ab98) expect(p.targetHandle).toBe(before);
    else {
      const best = enemies.reduce((a, c) => (c.slant < a.slant ? c : a));
      expect(p.targetHandle.toString(16)).toBe(best.handle.toString(16));
    }

    // the readout names the target in its pane
    expect(p.targetHandle & 0x1000).toBe(0);
    vfxWindowClear(defaultCanvas);
    frame();
    const pane = widget(14).window as { left: number; top: number; right: number; bottom: number };
    let inside = 0;
    const pitch = defaultCanvas.xMax + 1;
    for (let y = pane.top; y <= pane.bottom; y++) for (let x = pane.left; x <= pane.right; x++) inside += defaultCanvas.drawn[y * pitch + x]!;
    expect(widget(14).label.length).toBeGreaterThan(0);
    expect(inside).toBeGreaterThan(0);
  });
});
