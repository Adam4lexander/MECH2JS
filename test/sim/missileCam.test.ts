// The missile camera (ORDINANCE_VIEW, F10 in GAMEKEY.MAP, command 0xe): after
// the player launches a missile, the key puts the camera in mode 3, the
// viewer rides the missile's pose each frame, and when the round is gone the
// camera goes back to the mode it came from.
import { beforeAll, describe, expect, it } from 'vitest';
import { ExeImage } from '../../src/data/exe/ExeImage.ts';
import { ProjectFile } from '../../src/data/prj/ProjectFile.ts';
import { ailTimerService } from '../../src/engine/miles/ail.ts';
import { bootMission } from '../../src/mission/load.ts';
import { mainLoopFrame } from '../../src/mission/mainLoop.ts';
import { cameraGlobals } from '../../src/sim/camera/viewer.ts';
import { KeyboardDriver } from '../../src/sim/controls/giddi.ts';
import { input } from '../../src/sim/controls/input.ts';
import { simTables } from '../../src/sim/effects/simTables.ts';
import { weaponTypes } from '../../src/sim/mech/config.ts';
import { loadoutWeapons } from '../../src/sim/mech/loadout.ts';
import { mechs } from '../../src/sim/mech/mechGlobals.ts';
import { gameSource, hasGameData, installFiles } from '../support/env.ts';

let exe: ExeImage;
let prj: ProjectFile;
let files: Map<string, Uint8Array>;

function frame(ticks = 7) {
  for (let i = 0; i < ticks; i++) ailTimerService();
  mainLoopFrame();
}

describe.runIf(hasGameData)('missile camera', () => {
  beforeAll(async () => {
    const src = gameSource();
    exe = ExeImage.fromExe(await src.read('MW2.EXE'));
    prj = new ProjectFile(await src.read('MW2.PRJ'));
    files = installFiles();
  });

  it('F10 follows the player\'s last missile and returns when it is gone', () => {
    bootMission({ exe, prj, looseFiles: files, mission: 'AMY_SCN1' });
    const kb = input.devices[input.keyboardDevice]!.driver as KeyboardDriver;
    const p = mechs.mechTable[mechs.playerMechIndex]!;
    const l = p.loadout!;
    for (let f = 0; f < 400 && l.status !== 2; f++) frame();
    expect(l.status).toBe(2);

    // with nothing launched the key does nothing
    const mode0 = cameraGlobals.cameraMode;
    kb.isr(0x44);
    frame();
    kb.isr(0xc4);
    frame();
    expect(cameraGlobals.cameraMode).toBe(mode0);

    // select a missile launcher (projectile kind 3 or 4) and fire it
    const types = weaponTypes();
    const i = loadoutWeapons(l).findIndex((w) => w.type >= 0 && (types[w.type]!.projectileKind === 3 || types[w.type]!.projectileKind === 4));
    expect(i).toBeGreaterThanOrEqual(0);
    l.selectedWeapon = i;
    kb.isr(0x39);
    for (let f = 0; f < 40 && simTables.playerLastMissile < 1; f++) frame();
    kb.isr(0xb9);
    expect(simTables.playerLastMissile).toBeGreaterThan(0);

    kb.isr(0x44);
    frame();
    kb.isr(0xc4);
    expect(cameraGlobals.cameraMode).toBe(3);
    const slot = simTables.missileCamProjectile;
    expect(slot).toBe(simTables.playerLastMissile);
    // main's loop runs camera_update before projectiles_update_all, so each
    // frame the viewer takes the pose the missile's previous step wrote
    const pose = Array.from(simTables.missileCamPose);
    expect(pose[6]).not.toBe(0);
    frame();
    const v = cameraGlobals.viewerPosition ?? cameraGlobals.mainViewer;
    expect([v.posX, v.posY, v.posZ, v.yaw, v.pitch, v.roll]).toEqual(pose.slice(0, 6));
    expect(Array.from(simTables.missileCamPose)).not.toEqual(pose);

    let f = 0;
    for (; f < 400 && simTables.projectiles[slot]!.active !== 0; f++) frame();
    expect(simTables.projectiles[slot]!.active).toBe(0);
    frame();
    expect(simTables.missileCamProjectile).toBe(-1);
    expect(cameraGlobals.cameraMode).toBe(mode0);
  });
});
