// The port's stand-in for the shell's mission setup. The star builder writes
// the shell's own layout: for the setup this install's USERSTAR.BWD holds it
// gives that file byte for byte, and with no 'Mechs the install's empty
// opponent stars. The mission list splits by the loose files each mission
// includes; the 'Mech list is every 'Mech the missions field; and a star
// built from a setup puts the chosen pilot, 'Mech and starmates in the game.
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { missionCatalog } from '../../src/app/gameData.ts';
import { mechCatalog, type MechChoice } from '../../src/data/catalog/mechs.ts';
import { buildEmptyStar, buildUserStar, STARMATE_LIMIT } from '../../src/data/config/userStar.ts';
import { ExeImage } from '../../src/data/exe/ExeImage.ts';
import { parseMek } from '../../src/data/formats/mek.ts';
import { ProjectFile } from '../../src/data/prj/ProjectFile.ts';
import { bootMission } from '../../src/mission/load.ts';
import { aiCombatSub0246b0, lanceMechForSlot } from '../../src/sim/groups/orders.ts';
import { mechs } from '../../src/sim/mech/mechGlobals.ts';
import { gameSource, hasGameData, installFiles, MW2_ROOT, TEST_STAR } from '../support/env.ts';

let exe: ExeImage;
let prj: ProjectFile;
let catalog: MechChoice[];

const onDisk = (name: string): Uint8Array | null => {
  const p = path.join(MW2_ROOT, name);
  return fs.existsSync(p) ? new Uint8Array(fs.readFileSync(p)) : null;
};

describe.runIf(hasGameData)('mission setup', () => {
  beforeAll(async () => {
    const src = gameSource();
    exe = ExeImage.fromExe(await src.read('MW2.EXE'));
    prj = new ProjectFile(await src.read('MW2.PRJ'));
    catalog = mechCatalog(prj);
  });

  it("builds the shell's star files: the install's USERSTAR.BWD and empty EN01STAR.BWD byte for byte", () => {
    const user = onDisk('USERSTAR.BWD');
    const en = onDisk('EN01STAR.BWD');
    if (user) expect(Array.from(buildUserStar(TEST_STAR))).toEqual(Array.from(user));
    if (en) expect(Array.from(buildEmptyStar())).toEqual(Array.from(en));
    // the test star's 'Mech is the catalog's own Mad Dog
    expect(catalog.find((m) => m.config === 'mdg00std')).toEqual(TEST_STAR.pilot.mech);
  });

  it('splits the missions by what they include: 20 ready, 24 needing the player star, 15 needing opponents', () => {
    const ms = missionCatalog(prj);
    const by = (n: string) => ms.filter((m) => m.needs === n).map((m) => m.stream);
    expect([by('ready').length, by('star').length, by('opponents').length]).toEqual([20, 24, 15]);
    expect(by('opponents')).toEqual(['BRO2SCN1', 'CHEDSCN1', 'CIN2SCN1', 'COLBSCN1', 'EDAMSCN1', 'FUC2SCN1', 'GOATSCN1', 'GOUDSCN1', 'JACKSCN1', 'MAR2SCN1', 'PROVSCN1', 'RICOSCN1', 'RUS2SCN1', 'SWISSCN1', 'WHIZSCN1']);
    expect(ms.find((m) => m.stream === 'AMY_SCN1')!.needs).toBe('ready');
    expect(ms.find((m) => m.stream === 'BLONSCN1')!.loose).toEqual(['USERSTAR.BWD']);
    expect(ms.find((m) => m.stream === 'CHEDSCN1')!.loose).toContain('INSTMAP1.BWD');
  });

  it("lists every 'Mech the missions field - only 'Mechs, each with a loadable MEK record", () => {
    expect(catalog.length).toBeGreaterThan(20);
    for (const m of catalog) {
      expect(m.stream.name, m.config).not.toMatch(/^(turret|tank|aircrft|drop|door|vehicle)/);
      const mek = parseMek(prj.readResource('MEK', m.mekId)!);
      expect(mek, m.config).not.toBeNull();
      expect(m.tons, m.config).toBeGreaterThan(0);
    }
  });

  it('a built star puts the chosen pilot, Mech and starmates into the mission', () => {
    const pick = (c: string) => catalog.find((m) => m.config === c)!;
    const star = {
      pilot: { name: 'Test Pilot', mech: pick('tbr00std') },
      starmates: [
        { name: 'Wing One', mech: pick('ktf00std') },
        { name: 'Wing Two', mech: pick('stm00std') },
      ],
    };
    bootMission({ exe, prj, looseFiles: installFiles(star), mission: 'BLONSCN1' });
    const p = mechs.mechTable[mechs.playerMechIndex]!;
    expect(p.name).toBe('Test Pilot');
    // the loadout is the chosen chassis': its tonnage is the MEK record's
    expect(p.loadout!.tons).toBe(star.pilot.mech.tons);
    expect(mechs.mechTable[lanceMechForSlot(1)]!.loadout!.tons).toBe(star.starmates[0]!.mech.tons);
    expect(aiCombatSub0246b0()).toBe(3);
    expect([1, 2].map((s) => mechs.mechTable[lanceMechForSlot(s)]!.name)).toEqual(['Wing One', 'Wing Two']);
    expect(STARMATE_LIMIT).toBe(4);
  });
});
