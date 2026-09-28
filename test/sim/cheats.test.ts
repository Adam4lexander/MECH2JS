// MW2.EXE's cheat codes, typed into cheat_handle_command's key ring the way
// key_command_update hands keys over (0x07xx), on a loaded mission.
import { beforeAll, describe, expect, it } from 'vitest';
import { ExeImage } from '../../src/data/exe/ExeImage.ts';
import { ProjectFile } from '../../src/data/prj/ProjectFile.ts';
import { readCheatCodes } from '../../src/data/exe/tables/cheats.ts';
import { bootMission } from '../../src/mission/load.ts';
import { results } from '../../src/mission/results.ts';
import { cheatHandleCommand } from '../../src/sim/ui/cheats.ts';
import { mechs } from '../../src/sim/mech/mechGlobals.ts';
import { clock } from '../../src/engine/clock.ts';
import { gameSource, hasGameData, installFiles } from '../support/env.ts';

describe.runIf(hasGameData)('cheat codes', () => {
  let exe: ExeImage;
  let prj: ProjectFile;
  beforeAll(async () => {
    exe = ExeImage.fromExe(await gameSource().read('MW2.EXE'));
    prj = new ProjectFile(await gameSource().read('MW2.PRJ'));
  });

  const type = (s: string) => {
    for (let i = 0; i < s.length; i++) cheatHandleCommand(0x700 | s.charCodeAt(i));
  };

  it('toggle invulnerability, unlimited ammo, time expansion; win the mission', () => {
    bootMission({ exe, prj, looseFiles: installFiles(), mission: 'AMY_SCN1' });
    const codes = readCheatCodes(exe).map((c) => c.typed);
    const o = mechs.simOptions;
    expect(o.invulnerability).toBe(0);
    type(codes[0]!);
    expect(o.invulnerability).toBe(1);
    type(codes[0]!);
    expect(o.invulnerability).toBe(0);
    type(codes[1]!);
    expect(o.unlimitedAmmo).toBe(1);
    const t = clock.timeExpansion;
    type(codes[20]!);
    expect(clock.timeExpansion).toBe(t === 0 ? 1 : 0);
    expect(results.cheatWinMission).toBe(0);
    type(codes[11]!);
    expect(results.cheatWinMission).toBe(1);
    // any other key: nothing
    expect(cheatHandleCommand(0x800 | 0x41)).toBe(0);
  });
});
