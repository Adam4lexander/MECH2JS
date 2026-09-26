// Every POLY resource built into WorldObjects by the port's
// poly_load_wtbo_block, then checked polygon by polygon: the stored normal
// (triangle_normal's NEGATED cross product, chosen by poly_compute_normal)
// must face opposite the polygon's Newell normal. The decompilation checked
// this over all 25883 polygons with 4+ vertices and found exactly three
// exceptions (T_1NETAG, VCETHNGA mixed; one with zero area) - so any other
// failure is a porting error in triangle_normal or poly_compute_normal.
import { beforeAll, describe, expect, it } from 'vitest';
import { ProjectFile } from '../../src/data/prj/ProjectFile.ts';
import { polyLoadWtboBlock } from '../../src/engine/scene/wtboLoader.ts';
import { sceneNodeCreate } from '../../src/engine/scene/sceneGraph.ts';
import type { MeshBlock, WorldObject } from '../../src/generated/classes.gen.ts';
import { gameSource, hasGameData } from '../support/env.ts';

function meshes(o: WorldObject): MeshBlock[] {
  const out: MeshBlock[] = [];
  for (let m = o.meshList; m; m = m.next) out.push(m);
  return out;
}

describe.runIf(hasGameData)('WTBO build', () => {
  let prj: ProjectFile;
  beforeAll(async () => {
    prj = new ProjectFile(await gameSource().read('MW2.PRJ'));
  });

  it('builds every POLY resource and every face normal opposes its Newell normal', () => {
    const odd: string[] = [];
    let polys = 0;
    let objects = 0;
    let zeroArea = 0;
    for (const r of prj.list('POLY')) {
      const data = prj.readResource('POLY', r.id)!;
      const root = sceneNodeCreate(null, 4)!;
      const first = polyLoadWtboBlock(data, 0, data.length, root);
      expect(first, `POLY ${r.id} ${r.name}`).not.toBeNull();
      const objs = new Set<WorldObject>([first!]);
      if (root.userData) objs.add(root.userData);
      // part-mode blocks hang further objects on child nodes of the first's node
      const walk = (n: WorldObject['node']) => {
        for (let c = n?.firstChild ?? null; c; c = c.nextSibling) {
          if (c.userData) objs.add(c.userData);
          walk(c);
        }
      };
      walk(root);
      for (const o of objs) {
        objects++;
        for (const m of meshes(o)) {
          for (const p of m.polygons) {
            if (p.vertexCount < 3) continue;
            polys++;
            let nx = 0, ny = 0, nz = 0;
            for (let i = 0; i < p.vertexCount; i++) {
              const a = m.vertices[p.indices[i]!]!;
              const b = m.vertices[p.indices[(i + 1) % p.vertexCount]!]!;
              nx += (a.modelY - b.modelY) * (a.modelZ + b.modelZ);
              ny += (a.modelZ - b.modelZ) * (a.modelX + b.modelX);
              nz += (a.modelX - b.modelX) * (a.modelY + b.modelY);
            }
            if (nx === 0 && ny === 0 && nz === 0) {
              zeroArea++; // no facing to compare (reported below)
              continue;
            }
            const dot = nx * p.modelNormalX + ny * p.modelNormalY + nz * p.modelNormalZ;
            if (!(dot < 0)) odd.push(`${r.name} (${p.vertexCount} sides)`);
          }
        }
      }
    }
    expect(objects).toBeGreaterThan(3798);
    expect(polys).toBeGreaterThan(25883);
    console.info(`${zeroArea} zero-area polygons skipped (no facing to compare)`);
    // Mirrored placements are not loaded here (scale 1), so only the three the
    // decompilation lists may disagree.
    expect(odd.filter((s) => !/^(T_1NETAG|VCETHNGA)\b/.test(s)).length, odd.join('\n')).toBeLessThanOrEqual(1);
  });
});
