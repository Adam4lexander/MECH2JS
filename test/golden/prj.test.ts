// MW2.PRJ's index as the port reads it, printed the way
// tools/dump_project_index.py prints it, compared with listing/project_index.txt.
import { beforeAll, describe, expect, it } from 'vitest';
import { ProjectFile, readNameTable, resourceIdByName, TABL } from '../../src/data/prj/ProjectFile.ts';
import { gameSource, hasDecompiled, hasGameData, readListing } from '../support/env.ts';
import { expectSameLines, lines, padL, padR } from '../support/listing.ts';

export const comma = (n: number): string => n.toLocaleString('en-US');

describe.runIf(hasGameData && hasDecompiled)('MW2.PRJ container', () => {
  let prj: ProjectFile;
  beforeAll(async () => {
    prj = new ProjectFile(await gameSource().read('MW2.PRJ'));
  });

  it('project_index.txt corresponds line for line', () => {
    const size = prj.bytes.length;
    const L: string[] = [];
    L.push(`MW2 project container - MW2.PRJ, ${comma(size)} bytes`);
    L.push(`header block at 0xc, ${prj.headerLength} bytes, ${prj.types.length} types`);
    L.push('');
    L.push('tag   dir offset   dir bytes   base   resources   payload bytes   bad');
    L.push('-'.repeat(74));
    let totalRes = 0;
    let totalBytes = 0;
    let totalBad = 0;
    for (const t of prj.types) {
      let bad = 0;
      let payload = 0;
      for (const [start, length] of t.entries) {
        if (length === 0 && start === 0) continue;
        const at = start + t.recordPrefix;
        const n = length - t.recordPrefix;
        if (n < 0 || at + n > size) bad++;
        else payload += n;
      }
      totalRes += t.entries.length;
      totalBytes += payload;
      totalBad += bad;
      L.push(`${padR(t.tag, 5)} 0x${t.dirOffset.toString(16).padStart(8, '0')}   ${padL(t.dirSize, 9)}   ${padL(t.recordPrefix, 4)}   ${padL(t.entries.length, 9)}   ${padL(comma(payload), 13)}   ${padL(bad, 3)}`);
    }
    L.push('-'.repeat(74));
    L.push(`${' '.repeat(5)} ${' '.repeat(10)}   ${' '.repeat(9)}   ${' '.repeat(4)}   ${padL(totalRes, 9)}   ${padL(comma(totalBytes), 13)}   ${padL(totalBad, 3)}`);
    L.push('');
    L.push('');
    const named = prj.types.map((t) => {
      const names: Array<[number, string, number]> = [];
      for (let id = 0; id < t.entries.length; id++) {
        const n = prj.resourceName(t.tag, id);
        if (n) names.push([id, n, t.entries[id]![1] - t.recordPrefix]);
      }
      return { t, names };
    });
    L.push(`resource names, from the "DATA" record header each payload sits behind (${named.reduce((a, x) => a + x.names.length, 0)} recovered)`);
    L.push('');
    for (const { t, names } of named) {
      if (!names.length) continue;
      L.push(`[${t.tag}]`);
      for (const [id, n, p] of names) L.push(`  ${padL(id, 5)}  ${padR(n, 18)} ${padL(comma(p), 9)}`);
      L.push('');
    }
    L.push("'bad' counts entries whose seek(start + base) / read(length - base) would fall outside the file - the check that says whether this layout is right.");
    expectSameLines('project_index.txt', lines(readListing('project_index.txt')), L);
  });

  it('resource_id_by_name resolves through the TABL indexes', () => {
    // Every name in BWDTABLE resolves to the id stored beside it, and that id
    // is a BWD resource whose own record header carries the same name.
    const bwd = readNameTable(prj, TABL.BWD);
    expect(bwd.length).toBeGreaterThan(1000);
    for (const { name, id } of bwd) {
      expect(resourceIdByName(prj, TABL.BWD, name)).toBe(id);
      expect(prj.resourceName('BWD', id).toLowerCase()).toBe(name.toLowerCase());
    }
    expect(resourceIdByName(prj, TABL.BWD, 'no-such-name')).toBe(-1);
  });
});
