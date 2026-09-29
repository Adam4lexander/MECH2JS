// The BRF2 briefing streams: mission_brf2_load's effect on the star records.
import { beforeAll, describe, expect, it } from 'vitest';
import { ExeImage } from '../../src/data/exe/ExeImage.ts';
import { ProjectFile } from '../../src/data/prj/ProjectFile.ts';
import { SHELL_LABEL } from '../../src/generated/shell/labels.gen.ts';
import { startShellProcess } from '../../src/shell/boot.ts';
import { missionBrf2Load } from '../../src/shell/career/brf2.ts';
import { readStar } from '../../src/shell/handoff/stars.ts';
import { mem } from '../../src/shell/memory.ts';
import { gameSource, hasGameData, hasShellData } from '../support/env.ts';

describe.runIf(hasGameData && hasShellData)('BRF2 streams', () => {
  let exe: ExeImage;
  let prj: ProjectFile;
  beforeAll(async () => {
    exe = ExeImage.fromExe(await gameSource().read('MW2SHELL.EXE'));
    prj = new ProjectFile(await gameSource().read('MW2.PRJ'));
    startShellProcess(exe, prj);
  });

  it('mission_brf2_load sets the launch animation and both stars', () => {
    startShellProcess(exe, prj);
    const planet = missionBrf2Load('chedscn1', true, true);
    expect(mem().cstr(SHELL_LABEL.launchAnimName)).toBe('liadevi');
    const p = readStar(SHELL_LABEL.playerStar);
    const o = readStar(SHELL_LABEL.opponentStar);
    expect([p.memberCount, p.maxMechs, p.maxTonnage, p.members.map((m) => m.mekName)]).toEqual([3, 3, 100, ['tbr00std', 'stm00std', 'hlb00std']]);
    expect(o.members.map((m) => m.mekName)).toEqual(['drw00std', 'tbr00std', 'jnr00std']);
    expect(mem().i32(SHELL_LABEL.opponentStarSkill)).toBe(7);
    expect(mem().u32(SHELL_LABEL.currentStar)).toBe(SHELL_LABEL.playerStar);
    expect(planet).toEqual({ planet: 3, lines: ['Trial of Grievance', 'Planet: Devin', 'Environment: Sparse Urban'] });
  });

  it("GOUDBRF2's opponent 'hlp01std' matches no chassis: the star keeps the member slot's old 'Mech", () => {
    startShellProcess(exe, prj);
    missionBrf2Load('goudscn1', true, false);
    const o = readStar(SHELL_LABEL.opponentStar);
    expect(o.members.slice(0, 2).map((m) => m.mekName)).toEqual(['drw00std', 'mrd01std']);
    expect(o.members[2]!.mekName).not.toBe('hlp01std');
  });
});
