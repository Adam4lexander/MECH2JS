// Every OBJ chunk in every BWD stream, walked with the port's
// project_next_chunk and read at project_obj_exec's offsets, printed as
// tools/dump_objects.py prints it and compared with listing/objects.txt.
import { beforeAll, describe, it } from 'vitest';
import { ProjectFile } from '../../src/data/prj/ProjectFile.ts';
import { walkStream } from '../../src/data/bwd/stream.ts';
import { gameSource, hasDecompiled, hasGameData, readListing } from '../support/env.ts';
import { expectSameLines, lines, padL, padR } from '../support/listing.ts';

const FAMILY: Record<number, string> = {
  0x00: '',
  0x10: 'fire/smoke',
  0x30: 'clan-colour',
  0x50: 'destructible',
  0x60: 'jet-flame',
  0x70: 'dummy',
  0x90: 'fam90',
  0xa0: 'mech-head',
  0xb0: 'structure',
  0xc0: 'light/sprs',
};
const DEFAULT_XFORM = [1, 1, 1, 0, 0, 0, 0, 0, 0];
const f1 = (v: number, w: number) => padL((v / 65536).toFixed(1), w);
const h4 = (v: number) => (v & 0xffff).toString(16).padStart(4, '0');

describe.runIf(hasGameData && hasDecompiled)('OBJ placements', () => {
  let prj: ProjectFile;
  beforeAll(async () => {
    prj = new ProjectFile(await gameSource().read('MW2.PRJ'));
  });

  it('objects.txt corresponds line for line', () => {
    const out: string[] = [];
    let total = 0;
    let unresolved = 0;
    let blocks = 0;
    let placed = 0;
    const ctxCount = new Map<string, number>();
    const bwd = prj.type('BWD')!;
    for (let rid = 0; rid < bwd.entries.length; rid++) {
      const sname = prj.resourceName('BWD', rid);
      if (!sname) continue;
      const rows: string[] = [];
      let reprDepth = 0;
      let blkDepth = 0;
      let pending = DEFAULT_XFORM;
      const isDefault = (x: number[]) => x.every((v, i) => v === DEFAULT_XFORM[i]);
      const scaleNote = (x: number[]) => (x[0] === 1 && x[1] === 1 && x[2] === 1 ? '' : `  scale ${x[0]},${x[1]},${x[2]} (ignored)`);
      for (const c of walkStream(prj.readResource('BWD', rid)!, sname)) {
        if (c.tag === 'BLKX' && c.size >= 8 + 36) {
          pending = Array.from({ length: 9 }, (_, i) => c.i32(8 + i * 4));
          continue;
        }
        if (c.tag === 'INCL' && !isDefault(pending)) {
          placed++;
          const r = c.ref(8);
          rows.push(`  PLACE ${padR(r.name, 9)} (BWD ${r.id})  pyr ${(pending[3]! / 65536).toFixed(1)} ${(pending[4]! / 65536).toFixed(1)} ${(pending[5]! / 65536).toFixed(1)}  pos ${pending[6]} ${pending[7]} ${pending[8]}${scaleNote(pending)}`);
          pending = DEFAULT_XFORM;
          continue;
        }
        if (c.tag === 'REPR') {
          reprDepth++;
          continue;
        }
        if (c.tag === 'ENDR') {
          reprDepth = Math.max(0, reprDepth - 1);
          continue;
        }
        if (c.tag === 'BLK' && c.size >= 8 + 24) {
          blkDepth++;
          blocks++;
          const b = Array.from({ length: 6 }, (_, i) => c.i32(8 + i * 4));
          rows.push(
            `  BLOCK depth ${blkDepth}  corner ${b[0]} ${b[1]} ${b[2]}  extent ${b[3]} ${b[4]} ${b[5]}  pyr ${(pending[3]! / 65536).toFixed(1)} ${(pending[4]! / 65536).toFixed(1)} ${(pending[5]! / 65536).toFixed(1)}  pos ${pending[6]} ${pending[7]} ${pending[8]}${scaleNote(pending)}`,
          );
          pending = DEFAULT_XFORM;
          continue;
        }
        if (c.tag === 'ENDB') {
          blkDepth = Math.max(0, blkDepth - 1);
          continue;
        }
        if (c.tag !== 'OBJ' || c.size < 0x3a) continue;
        const oid = c.i16(8);
        const parent = c.i16(10);
        const cls = c.i16(12);
        const v = Array.from({ length: 9 }, (_, i) => c.i32(0x0e + i * 4));
        const lflags = c.i16(0x32);
        const typ = c.u32(0x34);
        const pid = c.i16(0x38);
        let name = prj.resourceName('POLY', pid);
        total++;
        if (!name) {
          unresolved++;
          name = `?POLY ${pid}`;
        }
        const ctx = blkDepth ? 'blk' : reprDepth ? `lod${reprDepth - 1}` : '';
        ctxCount.set(ctx || 'plain', (ctxCount.get(ctx || 'plain') ?? 0) + 1);
        const fam = FAMILY[typ & 0xf0] ?? `fam${(typ & 0xf0).toString(16).padStart(2, '0')}`;
        rows.push(
          `  ${padL(oid, 5)} par ${padL(parent, 5)} cls ${padL(cls, 2)} ${padR(ctx, 5)} scale ${v[0]},${v[1]},${v[2]}  pyr ${f1(v[3]!, 7)} ${f1(v[4]!, 7)} ${f1(v[5]!, 7)}  pos ${padL(v[6]!, 7)} ${padL(v[7]!, 7)} ${padL(v[8]!, 7)}  lf ${h4(lflags)} type ${h4(typ)} ${padR(fam, 12)} ${name}`,
        );
      }
      if (rows.length) {
        out.push(`${sname} (BWD ${rid})  ${rows.filter((r) => !r.startsWith('  BLOCK') && !r.startsWith('  PLACE')).length} objects`);
        out.push(...rows, '');
      }
    }
    const ctxLine = [...ctxCount.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, n]) => `${k} ${n}`).join(', ');
    out.unshift(
      `MW2 object placements (OBJ chunks) - MW2.PRJ, ${total} objects, ${unresolved} unresolved POLY ids, ${blocks} blocks, ${placed} placed includes`,
      `context: ${ctxLine}  (blk = world-record definition, lodN = detail level N, i.e. REPR nesting depth - 1 as projectReprLevel counts, plain = loaded and linked)`,
      'pyr = pitch/yaw/roll in degrees; pos in cm; family names are read from the meshes that carry them - see WorldObject.type',
      '',
    );
    expectSameLines('objects.txt', lines(readListing('objects.txt')), out);
  });
});
