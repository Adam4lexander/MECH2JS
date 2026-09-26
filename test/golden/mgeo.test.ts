// MGEO has no decompilation listing, so this is structural: every MGEO
// resource in MW2.PRJ parses, is exactly the 28 bytes res_load_mgeo reads
// (so no byte of any record goes unaccounted for), resolves by name through
// TABL 5 (the table resource_load_ref is given for MGEO) to its own id, and
// holds the invariants res_load_mgeo's note records for all 55 records.
import { beforeAll, describe, expect, it } from 'vitest';
import { ProjectFile, resourceIdByName } from '../../src/data/prj/ProjectFile.ts';
import { MGEO_RECORD_SIZE, parseMgeo } from '../../src/data/formats/mgeo.ts';
import { gameSource, hasDecompiled, hasGameData } from '../support/env.ts';

describe.runIf(hasGameData && hasDecompiled)('MGEO resources', () => {
  let prj: ProjectFile;
  beforeAll(async () => {
    prj = new ProjectFile(await gameSource().read('MW2.PRJ'));
  });

  it('every MGEO resource is one 28-byte record with the recorded invariants', () => {
    const list = prj.list('MGEO');
    expect(list.length).toBe(55);
    const seen = new Set<string>();
    for (const r of list) {
      const c = prj.readResource('MGEO', r.id)!;
      const tag = `${r.name} (MGEO ${r.id})`;
      // sizes tile: the loader's seven dwords are the whole payload
      expect(c.length, tag).toBe(MGEO_RECORD_SIZE);
      const m = parseMgeo(c)!;
      expect(m, tag).not.toBeNull();
      // correspondence: the record's name resolves through TABL 5 to this id
      expect(r.name, tag).not.toBe('');
      expect(resourceIdByName(prj, 5, r.name), tag).toBe(r.id);
      seen.add(r.name.toLowerCase());
      // invariants recorded on res_load_mgeo / MechLoadout
      expect(m.eyeOffsetY, tag).toBe(0);
      expect(m.mgeoWord2, tag).toBe(-m.rideHeight | 0);
      expect(m.mgeoWord3, tag).toBe(0);
      expect(m.mgeoWord4, tag).toBe(0);
      expect(m.rideHeight, tag).toBeGreaterThanOrEqual(0); // 0 for the doors and most turrets
      expect(m.rideHeight, tag).toBeLessThanOrEqual(10000);
      expect(m.radius, tag).toBeGreaterThanOrEqual(170);
      expect(m.radius, tag).toBeLessThanOrEqual(3200);
      expect(m.torsoPanLimit % 0x10000, tag).toBe(0); // whole degrees in 16.16
      // 90 for most mechs, 15 Kitfox / Nova, 0 torso-less vehicles, 361 / 720 / 270
      // turrets, 50 doors (the last two are not in res_load_mgeo's note)
      expect([0, 15, 50, 90, 270, 361, 720], tag).toContain(m.torsoPanLimit / 0x10000);
    }
    expect(seen.size).toBe(55);
  });

  it('spot values the res_load_mgeo note quotes', () => {
    const by = new Map(prj.list('MGEO').map((r) => [r.name, parseMgeo(prj.readResource('MGEO', r.id)!)!]));
    const get = (n: string) => by.get(n)!;
    // "Jenner 575, Marauder 730, the elementals 175, aircraft up to 10000"
    expect(get('JENNER').rideHeight).toBe(575);
    expect(get('MARAUDER').rideHeight).toBe(730);
    expect(get('ELEMENTL').rideHeight).toBe(175);
    expect(Math.max(...[...by.values()].map((m) => m.rideHeight))).toBe(10000);
    // "15 for Kitfox and Nova"
    expect(get('KITFOX').torsoPanLimit).toBe(15 << 16);
    expect(get('NOVA').torsoPanLimit).toBe(15 << 16);
    // radius "170 to 3200, elementals to the dropship"
    expect(get('ELEMENTL').radius).toBe(170);
    expect(get('DROPA').radius).toBe(3200);
  });
});
