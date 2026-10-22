// The hand-built cockpits against the game: every chassis the mission picker
// offers resolves to a design, and the canopy table (render/cockpit/glass.ts)
// is its exterior's glass as it stands about the cockpit eye.
import { beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { ExeImage } from '../../src/data/exe/ExeImage.ts';
import { ProjectFile } from '../../src/data/prj/ProjectFile.ts';
import { mechCatalog, type MechChoice } from '../../src/data/catalog/mechs.ts';
import { ailTimerService } from '../../src/engine/miles/ail.ts';
import { Viewer } from '../../src/generated/classes.gen.ts';
import { bootMission } from '../../src/mission/load.ts';
import { mainLoopFrame } from '../../src/mission/mainLoop.ts';
import { cameraGlobals, viewer } from '../../src/sim/camera/viewer.ts';
import { mechs } from '../../src/sim/mech/mechGlobals.ts';
import { mechApplyDetailLevel } from '../../src/sim/world/detailRecords.ts';
import { SceneRenderer } from '../../src/render/SceneRenderer.ts';
import { cameraFromViewer, viewerFromCamera } from '../../src/render/bridge/cameraViewer.ts';
import { cockpitChassis } from '../../src/render/cockpit/chassis.ts';
import { DESIGNS } from '../../src/render/cockpit/designs/index.ts';
import { CANOPY } from '../../src/render/cockpit/glass.ts';
import { gameSource, hasGameData, installFiles } from '../support/env.ts';

type Entries = Map<{ type: number; index: number; currentMesh: unknown }, { group: THREE.Group; meshes: Array<{ block: unknown; basePos: Float32Array; draw: Float32Array; polyStart: Int32Array; polyTris: Int32Array }> }>;

/**
 * The player mech's glass as the exterior draws it: its parts rebuilt at
 * detail level 0, synced from a viewer 25 m ahead looking back (finest LOD),
 * every mode-0x4000 ramp-0xe triangle through its part's node into the
 * cockpit eye's space. Each triangle's corners rounded to the millimetre,
 * as glass.ts holds them.
 */
function exteriorGlass(): number[][] {
  const eyeCam = new THREE.PerspectiveCamera();
  cameraFromViewer(viewer(), eyeCam, 4 / 3);
  eyeCam.updateMatrixWorld(true);
  const inv = eyeCam.matrixWorld.clone().invert();
  const p = mechs.playerMechIndex;
  mechApplyDetailLevel(p, 0);
  cameraGlobals.cockpitViewActive = 0;
  const eye = new THREE.Vector3().setFromMatrixPosition(eyeCam.matrixWorld);
  const ext = new THREE.PerspectiveCamera();
  ext.position.copy(eye).addScaledVector(new THREE.Vector3(0, 0, -1).transformDirection(eyeCam.matrixWorld), 25);
  ext.lookAt(eye);
  ext.updateMatrixWorld(true);
  const xv = viewerFromCamera(ext, viewer(), new Viewer());
  xv.lodScale = 0x7fffffff;
  const sr = new SceneRenderer();
  sr.sync(xv);
  const out: number[][] = [];
  const v = new THREE.Vector3();
  for (const [obj, e] of (sr as unknown as { entries: Entries }).entries) {
    if (((obj.type >> 8) & 0xf) !== 1 || (obj.index & 0xffff) !== p) continue;
    e.group.updateMatrixWorld(true);
    const M = inv.clone().multiply(e.group.matrixWorld);
    for (const m of e.meshes) {
      if (obj.currentMesh && m.block !== obj.currentMesh) continue;
      for (let q = 0; q < m.polyStart.length; q++) {
        const s = m.polyStart[q]!;
        const w = m.draw[s]!;
        if (w < 0 || (w & 0x7000) !== 0x4000 || (w & 0xf0) !== 0xe0) continue;
        for (let t = 0; t < m.polyTris[q]!; t++) {
          const k = (s + t * 3) * 3;
          // the fans' spare slots are all zeros
          if (m.basePos.subarray(k, k + 9).every((c) => c === 0)) continue;
          const tri: number[] = [];
          for (let j = 0; j < 3; j++) {
            v.set(m.basePos[k + j * 3]!, m.basePos[k + j * 3 + 1]!, m.basePos[k + j * 3 + 2]!).applyMatrix4(M);
            tri.push(+v.x.toFixed(3), +v.y.toFixed(3), +v.z.toFixed(3));
          }
          out.push(tri);
        }
      }
    }
  }
  sr.destroy();
  return out;
}

const sorted = (tris: number[][]) => tris.map((t) => t.join(',')).sort();

describe.runIf(hasGameData)('hand-built cockpits', () => {
  let exe: ExeImage;
  let prj: ProjectFile;
  const chassis: MechChoice[] = [];

  beforeAll(async () => {
    const src = gameSource();
    exe = ExeImage.fromExe(await src.read('MW2.EXE'));
    prj = new ProjectFile(await src.read('MW2.PRJ'));
    const seen = new Set<string>();
    for (const m of mechCatalog(prj)) if (!seen.has(m.stream.name)) {
      seen.add(m.stream.name);
      chassis.push(m);
    }
  });

  it("gives every chassis a design, and its canopy is its exterior's glass about its eye", () => {
    const keys = new Set<string>();
    for (const m of chassis) {
      bootMission({ exe, prj, looseFiles: installFiles({ pilot: { name: 'T', mech: m }, starmates: [] }), mission: 'BLONSCN1' });
      for (let f = 0; f < 3; f++) {
        for (let i = 0; i < 9; i++) ailTimerService();
        mainLoopFrame();
      }
      const key = cockpitChassis(prj);
      // the turret gamepiece has no cockpit shell: it keeps the original view
      if (m.stream.name === 'dumbfuck') {
        expect(key).toBe('');
        continue;
      }
      expect(DESIGNS[key], `${m.stream.name} -> ${key}`).toBeDefined();
      keys.add(key);
      const table = CANOPY[key]!.tris;
      const rows = Array.from({ length: table.length / 9 }, (_, i) => table.slice(i * 9, i * 9 + 9));
      expect(sorted(exteriorGlass()), `${key} canopy`).toEqual(sorted(rows));
    }
    // the Tarantula wears the Kit Fox's shell but is filed under its own head
    expect(keys.has('TR') && keys.has('KF')).toBe(true);
    expect([...keys].sort()).toEqual(Object.keys(DESIGNS).sort());
  }, 900000);
});
