// Mode 0x3000 polygons are sprites (render_asm_sub_03b990): the renderer
// reads P (u = 0, v = 0) and Q (u = 0, v != 0) out of each one's first three
// vertices and draws nothing when either is missing. Checked against every
// such polygon in MW2.PRJ, so a misreading of which vertex is which fails
// here rather than as sprites silently missing in the viewport. It also pins
// what the data says about orientation: P is above Q, so texture row 0 (v = 0
// at P) is the top of the sprite.
import { describe, expect, it } from 'vitest';
import { ProjectFile } from '../../src/data/prj/ProjectFile.ts';
import { parseWtboBlock } from '../../src/data/formats/wtbo.ts';
import { spriteVertices } from '../../src/render/pipeline/drawPipeline.ts';
import type { MeshPolygon, MeshVertex } from '../../src/generated/classes.gen.ts';
import { gameSource, hasGameData } from '../support/env.ts';

describe.runIf(hasGameData)('mode 0x3000 sprites', () => {
  it('every sprite polygon but one repeated-vertex typo has P and Q, with P above Q', async () => {
    const prj = new ProjectFile(await gameSource().read('MW2.PRJ'));
    let sprites = 0;
    let mirrored = 0;
    const missing: string[] = [];
    const inverted: string[] = [];
    for (const r of prj.list('POLY')) {
      for (const rec of parseWtboBlock(prj.readResource('POLY', r.id)!).records) {
        const vertices = Array.from({ length: rec.vertexCount }, (_, i) => ({
          modelX: rec.positions[i * 3]!,
          modelY: rec.positions[i * 3 + 1]!,
          modelZ: rec.positions[i * 3 + 2]!,
          texU: rec.texcoords[i * 2]!,
          texV: rec.texcoords[i * 2 + 1]!,
        })) as unknown as MeshVertex[];
        for (const p of rec.polygons) {
          if ((p.code & 0x7000) !== 0x3000) continue;
          sprites++;
          const s = spriteVertices({ vertexCount: p.indices.length, indices: p.indices } as unknown as MeshPolygon, vertices);
          if (!s.p || !s.q) missing.push(`${r.name}/${rec.name} code ${p.code.toString(16)}`);
          else if (!(s.p.modelY > s.q.modelY)) inverted.push(rec.name);
          if (s.mirror) mirrored++;
        }
      }
    }
    console.info(`${sprites} sprite polygons, ${mirrored} mirrored`);
    expect(sprites).toBeGreaterThan(1000);
    // the same typo in both copies of the patch: the second polygon of a pair
    // repeats its u != 0 vertex and has no u = 0, v = 0 one; the original
    // draws nothing for it, and so does the port
    expect(missing).toEqual(['FRODE/crud_ code 3110', 'SCROUNGE/crud_ code 3240']);
    expect(inverted.slice(0, 10), inverted.slice(0, 10).join('\n')).toEqual([]);
  });
});
