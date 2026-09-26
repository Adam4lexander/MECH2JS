// Loads every mission in MW2.PRJ through the port's main() start-up
// (bootMission: sim_load_by_name -> project_chunk_exec -> world records ->
// objectives -> gamepiece create hooks) and checks what it built.
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { ExeImage } from '../../src/data/exe/ExeImage.ts';
import { IniFile } from '../../src/data/config/ini.ts';
import { ProjectFile, readNameTable, TABL } from '../../src/data/prj/ProjectFile.ts';
import { bootMission } from '../../src/mission/load.ts';
import { onSystemError, type ReportedError } from '../../src/engine/systemErrors.ts';
import { mechs } from '../../src/sim/mech/mechGlobals.ts';
import { world } from '../../src/sim/world/worldRecords.ts';
import { things } from '../../src/sim/things/gameThings.ts';
import { altRootNode, objectsOnList, worldRootNode } from '../../src/engine/scene/objectLists.ts';
import { viewScene } from '../../src/sim/world/viewScene.ts';
import { MW2_ROOT, gameSource, hasGameData } from '../support/env.ts';

function looseFiles(): Map<string, Uint8Array> {
  const m = new Map<string, Uint8Array>();
  for (const f of fs.readdirSync(MW2_ROOT)) if (/\.BWD$/i.test(f)) m.set(f.toUpperCase(), new Uint8Array(fs.readFileSync(path.join(MW2_ROOT, f))));
  const mek = path.join(MW2_ROOT, 'MEK');
  if (fs.existsSync(mek)) for (const f of fs.readdirSync(mek)) m.set(`MEK/${f}`.toUpperCase(), new Uint8Array(fs.readFileSync(path.join(mek, f))));
  return m;
}

describe.runIf(hasGameData)('mission load', () => {
  let exe: ExeImage;
  let prj: ProjectFile;
  let ini: IniFile;
  let loose: Map<string, Uint8Array>;
  let missions: string[];
  beforeAll(async () => {
    const src = gameSource();
    exe = ExeImage.fromExe(await src.read('MW2.EXE'));
    prj = new ProjectFile(await src.read('MW2.PRJ'));
    ini = new IniFile(await src.read('MW2.INI'));
    loose = looseFiles();
    missions = readNameTable(prj, TABL.BWD)
      .map((e) => e.name.toUpperCase())
      .filter((n) => /SCN1$/.test(n))
      .sort();
  });

  it('every SCN1 mission loads without a fatal system error', () => {
    const report: string[] = [];
    const failures: string[] = [];
    for (const m of missions) {
      const errors: ReportedError[] = [];
      const off = onSystemError((e) => errors.push(e));
      let ok = false;
      try {
        ok = bootMission({ exe, prj, ini, looseFiles: loose, mission: m });
      } catch (e) {
        failures.push(`${m}: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        off();
      }
      const drawn = [...objectsOnList(worldRootNode)].length;
      report.push(
        `${m.padEnd(10)} ok=${ok ? 1 : 0} mechs=${mechs.mechCount} records=${world.worldObjectCount} gamethings=${things.gameThingCount} drawn=${drawn} warnings=${errors.map((e) => '0x' + e.code.toString(16) + (e.detail ? '[' + e.detail + ']' : '')).join(',')}`,
      );
    }
    fs.writeFileSync(path.join(__dirname, '..', '..', 'test-results-missions.txt'), report.join('\n') + '\n');
    expect(missions.length).toBeGreaterThan(50);
    expect(failures, failures.join('\n')).toEqual([]);
  });

  // vfx_video_sub_0103c0: what main takes out of the world list before play.
  it('the draw list holds no backdrop or family 0x70 objects, and objectClass 4 is off the world chain', () => {
    const bad: string[] = [];
    let backdrops = 0;
    for (const m of missions) {
      bootMission({ exe, prj, ini, looseFiles: loose, mission: m });
      const world = new Set(objectsOnList(worldRootNode));
      for (const o of world) {
        if ((o.type & 0xf0) === 0x70) bad.push(`${m}: family 0x70 object still in the world`);
        // object_remove_from_world takes it off the world chain (flags bit 0x800), not the draw list
        if (o.objectClass === 4 && (o.flags & 0x800) === 0) bad.push(`${m}: objectClass 4 object still on the world chain`);
      }
      // the first family 0x90 object decides: its node becomes the backdrop, or, with no node, there is none
      // and it stays an ordinary world object (the walk stops at it either way)
      const first90 = [...world].find((o) => (o.type & 0xf0) === 0x90);
      if (!viewScene.backdropNode && first90 && first90.node) bad.push(`${m}: first family 0x90 object has a node but is not the backdrop`);
      const b = viewScene.backdropNode;
      if (b) {
        backdrops++;
        if ((b.userData!.type & 0xf0) !== 0x90) bad.push(`${m}: backdropNode is not a family 0x90 object`);
        const walk = (n: typeof b) => {
          if (n.userData && world.has(n.userData)) bad.push(`${m}: a backdrop object is still in the world list`);
          for (let c = n.firstChild; c; c = c.nextSibling) walk(c);
        };
        walk(b);
      }
      for (const o of objectsOnList(altRootNode)) if ((o.type & 0xf0) === 0x70 && world.has(o)) bad.push(`${m}: on both lists`);
    }
    expect(bad.slice(0, 10), bad.slice(0, 10).join('\n')).toEqual([]);
    expect(backdrops).toBeGreaterThan(0);
  });

  // star_place_formation: each member placed after its leader must stand at
  // its own formation slot seen through the leader's final world transform
  // (float maths here, fixed-point in the port), and its node must agree with
  // its entity. A mech given another's slot fails; totals would not. The
  // create hooks run after placement and read heading back from the node
  // (matrix_to_euler), so it is compared modulo a turn, within rounding.
  it('stars stand in formation around their leaders', () => {
    let checked = 0;
    const bad: string[] = [];
    for (const m of missions) {
      bootMission({ exe, prj, ini, looseFiles: loose, mission: m });
      for (let g = 0; g < 16; g++) {
        const li = mechs.groupTable[g]!.leaderMechIndex;
        if (li >>> 0 >= mechs.mechCount >>> 0) continue;
        const leader = mechs.mechTable[li]!;
        const w = leader.node!.worldBlock;
        const f = mechs.formationTable[g]!;
        for (let i = li + 1; i < mechs.mechCount; i++) {
          const e = mechs.mechTable[i]!;
          if (e.groupId !== g || e.starSlot >= 5) continue;
          const sx = f.slotX[e.starSlot]!;
          const sz = f.slotZ[e.starSlot]!;
          const ex = (w[0]! * sx + w[2]! * sz) / 2 ** 29 + w[9]!;
          const ez = (w[6]! * sx + w[8]! * sz) / 2 ** 29 + w[11]!;
          const n = e.node!.localBlock;
          const dh = (((e.heading - f.slotHeading[e.starSlot]!) % 0x1680000) + 0x1680000 + 0xb40000) % 0x1680000 - 0xb40000;
          if (Math.abs(e.posX - ex) > 2 || Math.abs(e.posZ - ez) > 2 || Math.abs(dh) > 8 || n[9] !== e.posX || n[11] !== e.posZ)
            bad.push(`${m} group ${g} mech ${i} slot ${e.starSlot}: at (${e.posX}, ${e.posZ}) h ${e.heading}, expected (${ex.toFixed(0)}, ${ez.toFixed(0)}) h ${f.slotHeading[e.starSlot]}`);
          checked++;
        }
      }
    }
    expect(bad.slice(0, 10), bad.slice(0, 10).join('\n')).toEqual([]);
    expect(checked).toBeGreaterThan(100);
  });
});
