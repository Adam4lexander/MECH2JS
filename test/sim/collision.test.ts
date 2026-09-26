// World collision against real mission geometry. Each check compares two
// independent paths through the port, so a misbuilt quadtree, a wrong
// polygon test or a mis-signed normal fails even though every number looks
// plausible on its own.
import { beforeAll, describe, expect, it } from 'vitest';
import { Ray, type MechEntity, type QuadtreeNode, type WorldObject } from '../../src/generated/classes.gen.ts';
import { ExeImage } from '../../src/data/exe/ExeImage.ts';
import { ProjectFile } from '../../src/data/prj/ProjectFile.ts';
import { bootMission } from '../../src/mission/load.ts';
import { mechs } from '../../src/sim/mech/mechGlobals.ts';
import { objectLists } from '../../src/engine/scene/objectLists.ts';
import { raySetPoints } from '../../src/engine/collision/ray.ts';
import { collision, mechMoveStep, objectEnsureBounds, worldGroundHeightNear, worldRaycast } from '../../src/sim/world/collision.ts';
import { quadtreeGroundHeight } from '../../src/sim/world/groundQuadtree.ts';
import { polySurfaceHeight, polygonContainsPointXz } from '../../src/sim/world/meshQueries.ts';
import { gameSource, hasGameData, installFiles } from '../support/env.ts';

function worldObjects(): WorldObject[] {
  const out: WorldObject[] = [];
  for (let o = objectLists.worldRoot!.worldNext; o; o = o.worldNext) out.push(o);
  return out;
}

/** a deterministic LCG, so a failure names a reproducible point */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe.runIf(hasGameData)('world collision', () => {
  let exe: ExeImage;
  let prj: ProjectFile;
  let files: Map<string, Uint8Array>;
  beforeAll(async () => {
    const src = gameSource();
    exe = ExeImage.fromExe(await src.read('MW2.EXE'));
    prj = new ProjectFile(await src.read('MW2.PRJ'));
    files = installFiles();
  });

  // quadtree_point_below's note: the tree and the brute-force scan pick the
  // same polygon for any point some upward polygon covers - the first in
  // mesh order. So the tree's height must equal the scan's everywhere.
  it('the ground quadtree answers exactly as a scan of the mesh in order', () => {
    let checked = 0;
    const bad: string[] = [];
    for (const m of ['AMY_SCN1', 'BRO2SCN1', 'BROWSCN1', 'CIN2SCN1']) {
      bootMission({ exe, prj, looseFiles: files, mission: m });
      const rnd = lcg(0x5eed);
      for (const o of worldObjects()) {
        if (o.objectClass !== 5 || !o.bounds || !o.meshList) continue;
        const root = o.bounds as QuadtreeNode;
        const mesh = o.meshList;
        for (let i = 0; i < 40; i++) {
          const x = Math.floor(root.minX + rnd() * (root.maxX - root.minX));
          const z = Math.floor(root.minZ + rnd() * (root.maxZ - root.minZ));
          let want: number | null = null;
          for (const p of mesh.polygons) {
            if (0 < p.normalY && polygonContainsPointXz(p, mesh.vertices, x, z)) {
              const h = { v: 0 };
              polySurfaceHeight(p, mesh.vertices, x, 0, z, h);
              want = h.v;
              break;
            }
          }
          if (want === null) continue;
          const got = { v: 0x7fffffff };
          const r = quadtreeGroundHeight(root, mesh, x, 0, z, got);
          if (r !== 1 || got.v !== want) bad.push(`${m} (${x}, ${z}): tree ${r}/${got.v}, scan ${want}`);
          checked++;
        }
      }
    }
    expect(bad.slice(0, 10), bad.slice(0, 10).join('\n')).toEqual([]);
    expect(checked).toBeGreaterThan(200);
  });

  // Two independent paths to the same surface: world_ground_height_near
  // (quadtree descent, plane_solve) and a vertical world_raycast (slab tests,
  // ray_hit_polygon, the 16.16 ray step). They must agree to rounding, and
  // the ray's hit normal must face up.
  it('a ray dropped onto the ground lands where the ground height says', () => {
    bootMission({ exe, prj, looseFiles: files, mission: 'AMY_SCN1' });
    const rnd = lcg(7);
    let checked = 0;
    const bad: string[] = [];
    for (const o of worldObjects().filter((w) => w.objectClass === 5 && w.bounds)) {
      const root = o.bounds as QuadtreeNode;
      for (let i = 0; i < 10; i++) {
        const x = Math.floor(root.minX + rnd() * (root.maxX - root.minX));
        const z = Math.floor(root.minZ + rnd() * (root.maxZ - root.minZ));
        const g = worldGroundHeightNear(x, 100000, z);
        if (g === 0 || collision.groundNormalY === 0) continue;
        const ray = new Ray();
        raySetPoints(ray, x, 100000, z, x, -100000, z);
        const hit = { v: null as WorldObject | null };
        if (!worldRaycast(ray, hit, -1)) {
          bad.push(`(${x}, ${z}): no hit, ground ${g}`);
          continue;
        }
        // something may stand on the ground there; only compare walkmesh hits
        if (hit.v?.objectClass !== 5) continue;
        // the paths round differently (the ray's plane distance sums three >> 29 products per side and steps a 16.16
        // unit vector; ground height is one 64-bit plane solve), so a steep face can differ by a few cm
        if (Math.abs(ray.endY - g) > 4 || collision.rayHitNormalY <= 0) bad.push(`(${x}, ${z}): ray ${ray.endY} n ${collision.rayHitNormalY}, ground ${g}`);
        checked++;
      }
    }
    expect(bad.slice(0, 10), bad.slice(0, 10).join('\n')).toEqual([]);
    expect(checked).toBeGreaterThan(20);
  });

  it('mech_move_step: a clear step goes through, a box holds the mech off its face, an obstacle stops it touching', () => {
    bootMission({ exe, prj, looseFiles: files, mission: 'AMY_SCN1' });
    const l = mechs.mechTable[mechs.playerMechIndex]!.loadout!;
    const e = l.entity!;
    l.status = 2;
    const hitObject = { v: null as WorldObject | null };
    const hitMech = { v: null as MechEntity | null };
    const out = { x: 0, y: 0, z: 0 };

    let tested = 0;
    for (const box of worldObjects().filter((o) => o.objectClass === 0)) {
      objectEnsureBounds(box);
      const b = box.bounds as Int32Array;
      e.posX = b[0]! - l.radius - 3000;
      e.posY = (b[2]! + b[3]!) >> 1;
      e.posZ = (b[4]! + b[5]!) >> 1;
      l.blockedSteps = 0;
      l.stepVelocityX = 0x40000;
      l.stepVelocityY = l.stepVelocityZ = 0;
      if (mechMoveStep(l, hitObject, hitMech, 1000, 0, 0, out) !== 0) continue; // something else near; try another box
      expect([out.x, out.y, out.z]).toEqual([e.posX + 1000, e.posY, e.posZ]);
      expect(hitObject.v).toBe(null);
      const r = mechMoveStep(l, hitObject, hitMech, 6000, 0, 0, out);
      if (hitObject.v !== box) continue; // a nearer object took the ray
      expect(r).toBe(1);
      // the box face's normal faces back along the ray
      expect([collision.rayHitNormalX, collision.rayHitNormalY, collision.rayHitNormalZ]).toEqual([-0x10000, 0, 0]);
      // held the look-ahead (the radius, for level motion) short of the face, then pushed back a quarter of the leftover
      const stop = b[0]! - l.radius;
      const leftover = 6000 - (stop - e.posX);
      expect(out.x).toBe(stop - (leftover >> 2));
      // head-on the velocity presses into the wall at a quarter of the step speed
      expect([l.velocityX, l.velocityY, l.velocityZ]).toEqual([0x10000, 0, 0]);
      tested++;
      break;
    }
    expect(tested).toBe(1);

    // a solid obstacle (class 6, not a mech, not family 0x50 - the training missions' gamethings, type 0x200):
    // the mech ends with the spheres exactly touching
    bootMission({ exe, prj, looseFiles: files, mission: 'TNJ1SCN1' });
    const l2 = mechs.mechTable[mechs.playerMechIndex]!.loadout!;
    const e2 = l2.entity!;
    l2.status = 2;
    const obst = worldObjects().find((o) => o.objectClass === 6 && ((o.type >> 8) & 1) === 0 && (o.type & 0xf0) !== 0x50 && o.radius > 0)!;
    expect(obst).toBeTruthy();
    e2.posX = obst.posX - obst.radius - l2.radius - 500;
    e2.posY = obst.posY;
    e2.posZ = obst.posZ;
    l2.blockedSteps = 0;
    l2.stepVelocityX = 0x40000;
    expect(mechMoveStep(l2, hitObject, hitMech, 1000, 0, 0, out)).toBe(1);
    expect([out.x, out.y, out.z]).toEqual([obst.posX - obst.radius - l2.radius, obst.posY, obst.posZ]);
    // the frozen k of -4: velocity = n * -4, 4/65536 cm a tick back toward the obstacle - effectively a dead stop
    expect([l2.velocityX, l2.velocityY, l2.velocityZ]).toEqual([4, 0, 0]);
  });
});
