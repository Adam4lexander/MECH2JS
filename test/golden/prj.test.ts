// MW2.PRJ's name index: resource_id_by_name resolves through the TABL
// indexes.
import { beforeAll, describe, expect, it } from 'vitest';
import { ProjectFile, readNameTable, resourceIdByName, TABL } from '../../src/data/prj/ProjectFile.ts';
import { gameSource, hasGameData } from '../support/env.ts';

describe.runIf(hasGameData)('MW2.PRJ container', () => {
  let prj: ProjectFile;
  beforeAll(async () => {
    prj = new ProjectFile(await gameSource().read('MW2.PRJ'));
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
