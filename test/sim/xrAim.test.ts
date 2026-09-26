// The VR reticle's depth (render/xr/aim.ts) in AMY_SCN1's start position:
// below the horizon a ray meets the flat ground at the height the player
// stands on, the scenery where it is drawn, nothing straight ahead within
// the cap - and the collision globals the game's queries write are left as
// the sim had them.
import { beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { ExeImage } from '../../src/data/exe/ExeImage.ts';
import { ProjectFile } from '../../src/data/prj/ProjectFile.ts';
import { ailTimerService } from '../../src/engine/miles/ail.ts';
import { bootMission } from '../../src/mission/load.ts';
import { mainLoopFrame } from '../../src/mission/mainLoop.ts';
import { viewer } from '../../src/sim/camera/viewer.ts';
import { mechs } from '../../src/sim/mech/mechGlobals.ts';
import { collision, worldGroundHeightNear } from '../../src/sim/world/collision.ts';
import { SceneRenderer } from '../../src/render/SceneRenderer.ts';
import { cameraFromViewer } from '../../src/render/bridge/cameraViewer.ts';
import { aimDepth } from '../../src/render/xr/aim.ts';
import { gameSource, hasGameData, installFiles } from '../support/env.ts';

describe.runIf(hasGameData)('VR reticle depth', () => {
  let sr: SceneRenderer;
  const cam = new THREE.PerspectiveCamera();
  let meshes: THREE.Object3D[];

  beforeAll(async () => {
    const src = gameSource();
    bootMission({ exe: ExeImage.fromExe(await src.read('MW2.EXE')), prj: new ProjectFile(await src.read('MW2.PRJ')), looseFiles: installFiles(), mission: 'AMY_SCN1' });
    for (let f = 0; f < 40; f++) {
      for (let i = 0; i < 9; i++) ailTimerService();
      mainLoopFrame();
    }
    sr = new SceneRenderer();
    sr.sync(viewer());
    cameraFromViewer(viewer(), cam, 4 / 3);
    meshes = sr.pickables().filter((m) => {
      let r = m;
      while (r.parent) r = r.parent;
      return r === sr.scene;
    });
  });

  const depth = (px: number, py: number) => aimDepth(cam, new THREE.Vector2(px / 320 - 1, 1 - py / 240), meshes, () => false, 3, 300);

  it('meets the flat ground below the horizon at the height the player stands on', () => {
    const p = mechs.mechTable[mechs.playerMechIndex]!;
    const saved = { ...collision };
    const eyeAbove = cam.position.y - worldGroundHeightNear(p.posX, p.posY, p.posZ) / 100;
    Object.assign(collision, saved);
    // the ray through pixel row 470 of 480 meets the plane eyeAbove below the eye after eyeAbove / -dir.y metres
    const c = new THREE.Raycaster();
    c.setFromCamera(new THREE.Vector2(0, 1 - 470 / 240), cam);
    const k = c.ray.direction.dot(cam.getWorldDirection(new THREE.Vector3()));
    const want = (eyeAbove / -c.ray.direction.y) * k;
    expect(want).toBeGreaterThan(3);
    expect(want).toBeLessThan(300);
    expect(depth(320, 470)).toBeCloseTo(want, 1);
  });

  it('meets drawn scenery where the ray crosses it, and nothing within the cap straight ahead', () => {
    const side = depth(100, 400);
    expect(side).toBeGreaterThan(20);
    expect(side).toBeLessThan(120);
    expect(depth(320, 200)).toBe(300);
  });

  it('leaves the collision globals as they were', () => {
    const before = JSON.stringify({ ...collision });
    depth(320, 470);
    depth(100, 400);
    expect(JSON.stringify({ ...collision })).toBe(before);
  });
});
