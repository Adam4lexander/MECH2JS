// Phase S1: the files the shell hands MW2.EXE, written by the ported shell
// code and compared byte for byte with what MW2SHELL.EXE left in the install.
// The install's files are read here only as expected output.
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ExeImage } from '../../src/data/exe/ExeImage.ts';
import { ProjectFile } from '../../src/data/prj/ProjectFile.ts';
import { walkStream } from '../../src/data/bwd/stream.ts';
import { decodeGps } from '../../src/data/bwd/payloads/gps.ts';
import { dosFileLoad, dosFileWrite, setDosFiles, setOverlayFiles, setOwnFiles } from '../../src/engine/dosFiles.ts';
import { SHELL_LABEL } from '../../src/generated/shell/labels.gen.ts';
import { startShellProcess } from '../../src/shell/boot.ts';
import { mem } from '../../src/shell/memory.ts';
import { prmCommandLine, prmLoad, prmSave } from '../../src/shell/handoff/prm.ts';
import { careerRegistryLoad, careerRegistrySave } from '../../src/shell/career/registry.ts';
import { instmapWrite, starFilesWrite } from '../../src/shell/handoff/starFiles.ts';
import { readStar, starConfigure, starMember, starSetMember } from '../../src/shell/handoff/stars.ts';
import { gameSource, hasGameData, hasShellData, installShellFixtures } from '../support/env.ts';

const hex = (b: Uint8Array | null) => (b ? Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(' ') : 'null');

describe.runIf(hasShellData && hasGameData)('shell handoff files', () => {
  let exe: ExeImage;
  let prj: ProjectFile;
  let want: Map<string, Uint8Array>;
  beforeAll(async () => {
    exe = ExeImage.fromExe(await gameSource().read('MW2SHELL.EXE'));
    prj = new ProjectFile(await gameSource().read('MW2.PRJ'));
    want = installShellFixtures(['MW2PRM.CFG', 'MW2REG.CFG', 'USERSTAR.BWD', 'EN0?STAR.BWD', 'INSTMAP1.BWD']);
  });
  beforeEach(() => {
    startShellProcess(exe, prj);
    setDosFiles(new Map());
    setOwnFiles(new Map());
    setOverlayFiles(null);
  });

  it('MW2PRM.CFG: prm_load then prm_save(-3, ..., "exittos") reproduces all 0x218 bytes', () => {
    // the install's file is what the shell wrote on quitting after a mission whose SUPS was ljftria
    dosFileWrite('MW2PRM.CFG', want.get('MW2PRM.CFG')!);
    const loaded = prmLoad()!;
    expect(loaded).toMatchObject({ state: -3, career: 1, pilotAccepted: 1, commandLine: 'exittos' });
    mem().strcpy(SHELL_LABEL.launchAnimName, 'ljftria');
    prmSave(-3, loaded.career, loaded.pilotAccepted, 'exittos');
    expect(hex(dosFileLoad('MW2PRM.CFG'))).toBe(hex(want.get('MW2PRM.CFG')!));
    expect(prmCommandLine(dosFileLoad('MW2PRM.CFG')!)).toBe('exittos -b=ljftria');
  });

  it('MW2REG.CFG: career_registry_load then career_registry_save is the identity', () => {
    dosFileWrite('MW2REG.CFG', want.get('MW2REG.CFG')!);
    careerRegistryLoad();
    careerRegistrySave();
    expect(hex(dosFileLoad('MW2REG.CFG'))).toBe(hex(want.get('MW2REG.CFG')!));
  });

  it('a missing MW2REG.CFG resets 20 empty pilots, slots 10.. in career 1', () => {
    careerRegistryLoad();
    careerRegistrySave();
    const f = dosFileLoad('MW2REG.CFG')!;
    expect(f.length).toBe(20 * 0x3c);
    const dv = new DataView(f.buffer);
    expect(Array.from({ length: 20 }, (_, i) => dv.getInt32(i * 0x3c + 8, true))).toEqual([...Array(10).fill(0), ...Array(10).fill(1)]);
  });

  it('USERSTAR / EN0nSTAR: the install star (ADAM + Friend 1 in Mad Dogs, no opponents) comes out byte for byte', () => {
    starConfigure(0, 0, 3, 0, 100);
    expect(starSetMember(0, 'mdg00std', 'ADAM')).toBe(-1);
    expect(starSetMember(1, 'mdg', 'Friend 1')).toBe(-1); // a 3-letter name gets 00std
    starConfigure(1, 0, 3, 0, 100);
    const p = readStar(SHELL_LABEL.playerStar);
    expect(p.memberCount).toBe(2);
    expect(p.members[1]!.mekName).toBe('mdg00std');
    starFilesWrite(2, starMember(SHELL_LABEL.playerStar, 0), 0, starMember(SHELL_LABEL.opponentStar, 0));
    for (const n of ['USERSTAR.BWD', 'EN01STAR.BWD', 'EN02STAR.BWD', 'EN03STAR.BWD', 'EN04STAR.BWD', 'EN05STAR.BWD']) {
      expect(`${n} ${hex(dosFileLoad(n))}`).toBe(`${n} ${hex(want.get(n)!)}`);
    }
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

  it('INSTMAP1.BWD: instmap_write(Wolf, Jade Falcon) comes out byte for byte', () => {
    instmapWrite(0, 1);
    expect(hex(dosFileLoad('INSTMAP1.BWD'))).toBe(hex(want.get('INSTMAP1.BWD')!));
  });
});
