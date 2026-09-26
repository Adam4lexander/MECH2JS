// Phase 3's exit check, "an enemy mech can be killed", end to end through
// main's loop: the player's own weapons, fired with the keyboard through
// KEYBOARD.DLL's handler, launch rounds that fly (projectiles_update_all),
// strike the enemy's parts (world_raycast), take its armour and structure
// (mech_apply_damage) until a section whose loss kills it goes, and
// mech_on_destroyed marks it dead. Nothing is called directly but the
// placement of the two mechs.
import { beforeAll, describe, expect, it } from 'vitest';
import { ExeImage } from '../../src/data/exe/ExeImage.ts';
import { ProjectFile } from '../../src/data/prj/ProjectFile.ts';
import { fixedAtan2, fixedCos, fixedSin } from '../../src/core/angle/trig.ts';
import { mulr16 } from '../../src/core/int/fx16.ts';
import type { MechEntity } from '../../src/generated/classes.gen.ts';
import { timerInterrupt } from '../../src/engine/timer.ts';
import { sceneNodeSetEuler, sceneNodeSetOrigin, sceneNodeWalk } from '../../src/engine/scene/sceneGraph.ts';
import { bootMission } from '../../src/mission/load.ts';
import { mainLoopFrame } from '../../src/mission/mainLoop.ts';
import { KeyboardDriver } from '../../src/sim/controls/giddi.ts';
import { input } from '../../src/sim/controls/input.ts';
import { mechAllegiance } from '../../src/sim/groups/groups.ts';
import { loadoutSections } from '../../src/sim/mech/loadout.ts';
import { mechs } from '../../src/sim/mech/mechGlobals.ts';
import { worldGroundHeightNear } from '../../src/sim/world/collision.ts';
import { gameSource, hasGameData, installFiles } from '../support/env.ts';

let exe: ExeImage;
let prj: ProjectFile;
let files: Map<string, Uint8Array>;

function frame(ticks = 7) {
  for (let i = 0; i < ticks; i++) timerInterrupt();
  mainLoopFrame();
}

function place(e: MechEntity, x: number, z: number, heading: number) {
  e.posX = x;
  e.posZ = z;
  e.posY = (worldGroundHeightNear(x, 0x7fff0000, z) + e.loadout!.rideHeight) | 0;
  e.heading = heading;
  sceneNodeSetOrigin(e.node!, e.posX, e.posY, e.posZ);
  sceneNodeSetEuler(e.node!, e.pitch, e.heading, e.roll, 0);
  sceneNodeWalk(e.node!);
}

describe.runIf(hasGameData)('kill', () => {
  beforeAll(async () => {
    const src = gameSource();
    exe = ExeImage.fromExe(await src.read('MW2.EXE'));
    prj = new ProjectFile(await src.read('MW2.PRJ'));
    files = installFiles();
  });

  it('the player\'s weapons destroy an enemy mech', () => {
    bootMission({ exe, prj, looseFiles: files, mission: 'AMY_SCN1' });
    const kb = input.devices[input.keyboardDevice]!.driver as KeyboardDriver;
    const p = mechs.mechTable[mechs.playerMechIndex]!;
    for (let f = 0; f < 400 && p.loadout!.status !== 2; f++) frame();
    expect(p.loadout!.status).toBe(2);

    let enemy: MechEntity | null = null;
    for (let i = 0; i < mechs.mechCount; i++) {
      const m = mechs.mechTable[i];
      if (m && i !== mechs.playerMechIndex && m.gamepieceClass === 1 && m.loadout && mechAllegiance(i) === 1) {
        enemy = m;
        break;
      }
    }
    expect(enemy).not.toBeNull();
    const en = enemy!;
    const l = en.loadout!;

    // Level ground 60 m from the enemy's spawn point, with the enemy facing
    // the player and the player facing it. fixed_sin is 2.29; >> 13 makes it 16.16.
    const ground = (x: number, z: number) => worldGroundHeightNear(x, 0x7fff0000, z);
    const ex = en.posX;
    const ez = en.posZ;
    const d = 6000;
    let px = 0;
    let pz = 0;
    let found = false;
    for (let deg = 0; deg < 360 && !found; deg += 15) {
      px = (ex + mulr16(fixedSin(deg << 16) >> 13, d)) | 0;
      pz = (ez + mulr16(fixedCos(deg << 16) >> 13, d)) | 0;
      found = Math.abs(ground(px, pz) - ground(ex, ez)) < 100;
    }
    expect(found).toBe(true);
    place(en, ex, ez, fixedAtan2(px - ex, pz - ez));
    place(p, px, pz, fixedAtan2(ex - px, ez - pz));

    const armour0 = loadoutSections(l).reduce((s, x) => s + x.armorFront + x.armorRear + x.internal, 0);
    kb.isr(0x2b); // '\' toggle_group_fire: group fire, so each pull fires the selected weapon's group
    frame();
    kb.isr(0xab);
    let f = 0;
    for (; f < 182 * 60 / 7 && l.status !== 4; f++) {
      // pull and release the trigger (Space) every 8 frames: arming is on the latch's rising edge
      if (f % 8 === 0) kb.isr(0x39);
      if (f % 8 === 4) kb.isr(0xb9);
      // keep the target where it was put: its AI is Phase 5
      if (l.status !== 4) place(en, ex, ez, en.heading);
      frame();
    }
    const armour1 = loadoutSections(l).reduce((s, x) => s + x.armorFront + x.armorRear + x.internal, 0);
    expect(armour1).toBeLessThan(armour0);
    expect(l.status).toBe(4);
    expect(en.flags & 6).toBe(6);
    // it died by a section whose loss kills: head (1), centre torso (3) or both legs (7, 8)
    const gone = (loc: number) => (loadoutSections(l)[loc - 1]!.flags & 0x2000) !== 0;
    expect(gone(1) || gone(3) || (gone(7) && gone(8))).toBe(true);
  });
});
