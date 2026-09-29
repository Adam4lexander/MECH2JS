// Phase S1: what the shell hands MW2.EXE for a mission, written by the
// ported shell code: the pilot registry's defaults, the player's star (the
// pilot and starmates the mission loads, the Keshik's weight limit) and the
// opponents' skill by difficulty.
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ExeImage } from '../../src/data/exe/ExeImage.ts';
import { ProjectFile } from '../../src/data/prj/ProjectFile.ts';
import { walkStream } from '../../src/data/bwd/stream.ts';
import { decodeGps } from '../../src/data/bwd/payloads/gps.ts';
import { dosFileLoad, dosFileWrite, setDosFiles, setOverlayFiles, setOwnFiles } from '../../src/engine/dosFiles.ts';
import { SHELL_LABEL } from '../../src/generated/shell/labels.gen.ts';
import { startShellProcess } from '../../src/shell/boot.ts';
import { mem } from '../../src/shell/memory.ts';
import { careerRegistryLoad, careerRegistrySave } from '../../src/shell/career/registry.ts';
import { starFilesWrite } from '../../src/shell/handoff/starFiles.ts';
import { readStar, starConfigure, starMember, starSetMember } from '../../src/shell/handoff/stars.ts';
import { gameSource, hasGameData, hasShellData } from '../support/env.ts';

describe.runIf(hasShellData && hasGameData)('shell handoff files', () => {
  let exe: ExeImage;
  let prj: ProjectFile;
  beforeAll(async () => {
    exe = ExeImage.fromExe(await gameSource().read('MW2SHELL.EXE'));
    prj = new ProjectFile(await gameSource().read('MW2.PRJ'));
  });
  beforeEach(() => {
    startShellProcess(exe, prj);
    setDosFiles(new Map());
    setOwnFiles(new Map());
    setOverlayFiles(null);
  });

  it('a missing MW2REG.CFG resets 20 empty pilots, slots 10.. in career 1', () => {
    careerRegistryLoad();
    careerRegistrySave();
    const f = dosFileLoad('MW2REG.CFG')!;
    expect(f.length).toBe(20 * 0x3c);
    const dv = new DataView(f.buffer);
    expect(Array.from({ length: 20 }, (_, i) => dv.getInt32(i * 0x3c + 8, true))).toEqual([...Array(10).fill(0), ...Array(10).fill(1)]);
  });

  it('USERSTAR / EN0nSTAR: a star of ADAM and Friend 1 in Mad Dogs is the two Mad Dogs the mission places, and no opponents', () => {
    starConfigure(0, 0, 3, 0, 100);
    expect(starSetMember(0, 'mdg00std', 'ADAM')).toBe(-1);
    expect(starSetMember(1, 'mdg', 'Friend 1')).toBe(-1); // a 3-letter name gets 00std
    starConfigure(1, 0, 3, 0, 100);
    const p = readStar(SHELL_LABEL.playerStar);
    expect(p.memberCount).toBe(2);
    expect(p.members[1]!.mekName).toBe('mdg00std');
    starFilesWrite(2, starMember(SHELL_LABEL.playerStar, 0), 0, starMember(SHELL_LABEL.opponentStar, 0));
    const gpsOf = (n: string) => [...walkStream(dosFileLoad(n)!)].filter((c) => c.tag === 'GPS').map(decodeGps);
    expect(gpsOf('USERSTAR.BWD').map((g) => [g.name, g.configName, g.leader])).toEqual([
      ['ADAM', 'mdg00std', 1],
      ['Friend 1', 'mdg00std', 0],
    ]);
    for (let n = 1; n <= 5; n++) expect(gpsOf(`EN0${n}STAR.BWD`), `EN0${n}STAR.BWD`).toEqual([]);
  });

  it('star_set_member refuses a chassis over the Keshik maximum', () => {
    starConfigure(0, 0, 3, 1, 60);
    expect(starSetMember(0, 'drw00std', 'X')).toBe(0); // Dire Wolf, 100 t
    expect(starSetMember(0, 'mdg00std', 'X')).toBe(-1); // Mad Dog, 60 t
  });

  it('EN0nSTAR: opponents get skill rows opponentStarSkill-2 downward, adjusted by MW2DIF difficulty', () => {
    starConfigure(1, 0, 3, 0, 100);
    starSetMember(0, 'tbr00std', 'Enemy 1');
    starSetMember(1, 'drw00std', 'Enemy 2');
    const skill = mem().i32(SHELL_LABEL.opponentStarSkill);
    expect(skill).toBe(8);
    const gpsOf = (n: string) => [...walkStream(dosFileLoad(n)!)].filter((c) => c.tag === 'GPS').map(decodeGps);
    for (const [difficulty, shift] of [
      [1, 0],
      [0, 1],
      [2, -1],
    ] as const) {
      dosFileWrite('MW2DIF.CFG', new Uint8Array([0, 0, 1, 1, 1, difficulty, 0, 0]));
      starFilesWrite(0, starMember(SHELL_LABEL.playerStar, 0), 2, starMember(SHELL_LABEL.opponentStar, 0));
      for (let n = 1; n <= 5; n++) {
        const gps = gpsOf(`EN0${n}STAR.BWD`);
        expect(gps.length).toBe(2);
        const row = Math.min(8, Math.max(1, skill - 2 + shift - (n - 1)));
        const table = Array.from({ length: 5 }, (_, k) => exe.i16(SHELL_LABEL.enemySkillTable + row * 10 + k * 2));
        expect(gps[0]!.gpsParams.slice(0, 5).map((v) => (v << 16) >> 16)).toEqual(table);
        expect(gps.map((g) => [g.group, g.leader, g.side])).toEqual([
          [n, 1, 2],
          [n, 0, 2],
        ]);
      }
    }
  });
});
