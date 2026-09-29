// The player's mech whole round the cockpit view (render/enhance/ownChassis.ts):
// a level-0 copy of every part on the game's own nodes, the torso casting
// only - and the game's objects, lists, records and loader globals left as
// the game had them.
import { beforeAll, describe, expect, it } from 'vitest';
import { ExeImage } from '../../src/data/exe/ExeImage.ts';
import { ProjectFile } from '../../src/data/prj/ProjectFile.ts';
import { mechCatalog } from '../../src/data/catalog/mechs.ts';
import { ailTimerService } from '../../src/engine/miles/ail.ts';
import { objectsOnList, worldRootNode } from '../../src/engine/scene/objectLists.ts';
import { wtboGlobals } from '../../src/engine/scene/wtboLoader.ts';
import { bootMission } from '../../src/mission/load.ts';
import { mainLoopFrame } from '../../src/mission/mainLoop.ts';
import { cameraGlobals } from '../../src/sim/camera/viewer.ts';
import { mechs } from '../../src/sim/mech/mechGlobals.ts';
import { detail } from '../../src/sim/world/detailRecords.ts';
import { OwnChassis } from '../../src/render/enhance/ownChassis.ts';
import { gameSource, hasGameData, installFiles } from '../support/env.ts';

describe.runIf(hasGameData)('the whole mech round the cockpit', () => {
  let prj: ProjectFile;

  beforeAll(async () => {
    const src = gameSource();
    const exe = ExeImage.fromExe(await src.read('MW2.EXE'));
    prj = new ProjectFile(await src.read('MW2.PRJ'));
    const tw = mechCatalog(prj).find((m) => m.stream.name === 'timbrwlf')!;
    bootMission({ exe, prj, looseFiles: installFiles({ pilot: { name: 'T', mech: tw }, starmates: [] }), mission: 'BLONSCN1' });
    for (let f = 0; f < 3; f++) {
      for (let i = 0; i < 9; i++) ailTimerService();
      mainLoopFrame();
    }
  });

  it("copies every drawn part at level 0 on its record's node, the torso and what hangs from it casting only", () => {
    expect(cameraGlobals.cockpitViewActive).not.toBe(0);
    const p = mechs.playerMechIndex;
    const records = detail.detailRecords.slice(0, detail.detailRecordCount);
    const listBefore = [...objectsOnList(worldRootNode)];
    const objectsBefore = records.map((r) => r.object);
    const loader = { ...wtboGlobals };
    const own = new OwnChassis().update(true, true, (id) => prj.readResource('POLY', id))!;
    expect(own.owner).toBe(p);
    const name = (i: number) => prj.resourceName('POLY', records[i]!.polyIds[0]!);
    const byName = new Map(own.parts.map((x) => [name(x.record), x]));
    // the legs show; the torso (the head record, TW1_HEAD) and the arms under it only cast
    for (const leg of ['TW1LULEG', 'TW1LLLEG', 'TW1RULEG', 'TW1RLLEG', 'TW1_HIPS']) expect(byName.get(leg)?.view, leg).toBe(true);
    for (const top of ['TW1_HEAD', 'TW1_RARM', 'TW1_LARM']) expect(byName.get(top)?.view, top).toBe(false);
    // no dummies; every part at its record's level-0 POLY, on its node, as the mech's own
    for (const x of own.parts) {
      const r = records[x.record]!;
      expect(name(x.record)).not.toBe('DUMMY');
      expect(x.obj.node).toBe(r.node);
      expect(x.obj.type & 0x100).toBe(0x100);
      expect(x.obj.index).toBe(p);
      expect(x.obj.meshList).not.toBeNull();
    }
    // the game's own state as it was
    expect([...objectsOnList(worldRootNode)]).toEqual(listBefore);
    expect(records.map((r) => r.object)).toEqual(objectsBefore);
    expect({ ...wtboGlobals }).toEqual(loader);
    for (const r of records) if (r.owner === p) expect(r.builtLevel).toBe(4);
  });

  it('draws nothing when off, or outside the cockpit view', () => {
    const read = (id: number) => prj.readResource('POLY', id);
    expect(new OwnChassis().update(false, true, read)).toBeNull();
    expect(new OwnChassis().update(true, false, read)).toBeNull();
  });

  it('shows the torso too to a camera outside the mech', () => {
    const own = new OwnChassis().update(true, true, (id) => prj.readResource('POLY', id), true)!;
    expect(own.parts.every((x) => x.view)).toBe(true);
  });
});
