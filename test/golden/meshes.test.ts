// Every WTBO record in MW2.PRJ parsed by the port, printed the way
// tools/dump_meshes.py prints it, and compared with listing/meshes.txt - with
// each record's checksum recomputed by the loader's own algorithm.
import { beforeAll, describe, expect, it } from 'vitest';
import { ProjectFile } from '../../src/data/prj/ProjectFile.ts';
import { parseWtboBlock, WTBO_LOD_MODE, wtboLodKey } from '../../src/data/formats/wtbo.ts';
import { gameSource, hasDecompiled, hasGameData, readListing } from '../support/env.ts';
import { expectSameLines, lines, padR } from '../support/listing.ts';

describe.runIf(hasGameData && hasDecompiled)('WTBO meshes', () => {
  let prj: ProjectFile;
  beforeAll(async () => {
    prj = new ProjectFile(await gameSource().read('MW2.PRJ'));
  });

  it('meshes.txt corresponds, with zero checksum failures', () => {
    const L: string[] = [];
    let nres = 0;
    let nrec = 0;
    let bad = 0;
    const t = prj.type('POLY')!;
    for (let id = 0; id < t.entries.length; id++) {
      const name = prj.resourceName('POLY', id);
      if (!name) continue;
      const payload = prj.readResource('POLY', id) ?? new Uint8Array(0);
      nres++;
      const { records, trailing } = parseWtboBlock(payload);
      L.push(`${name} (POLY ${id})  ${records.length} records${trailing ? `  ${trailing} bytes after the last record` : ''}`);
      for (const r of records) {
        nrec++;
        const ok = r.computedChecksum === r.checksum;
        if (!ok) bad++;
        const maxSides = r.polygons.reduce((m, p) => Math.max(m, p.indices.length), 0);
        const lod = r.flags & WTBO_LOD_MODE && /_\d+$/.test(r.name) ? `  lod>=${wtboLodKey(r.name)}` : '';
        L.push(
          `  ${padR(r.name, 16)} flags=${r.flags.toString(16).padStart(4, '0')}  vertices=${padR(r.vertexCount, 4)} polygons=${padR(r.polygonCount, 4)} max sides=${maxSides}${lod}${ok ? '' : '  CHECKSUM MISMATCH'}`,
        );
      }
      L.push('');
    }
    L.unshift(`MW2 WTBO meshes - MW2.PRJ, ${nres} POLY resources, ${nrec} records, ${bad} checksum failures`, '');
    expect(bad).toBe(0);
    expectSameLines('meshes.txt', lines(readListing('meshes.txt')), L);
  });
});
