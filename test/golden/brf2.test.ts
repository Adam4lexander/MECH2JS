// The BRF2 briefing streams as the port's shell code finds their chunks,
// printed in dump_brf2.py's format and compared with listing/brf2.txt; and
// mission_brf2_load's effect on the star records.
import { beforeAll, describe, expect, it } from 'vitest';
import { ExeImage } from '../../src/data/exe/ExeImage.ts';
import { ProjectFile, readNameTable } from '../../src/data/prj/ProjectFile.ts';
import { SHELL_LABEL } from '../../src/generated/shell/labels.gen.ts';
import { startShellProcess } from '../../src/shell/boot.ts';
import { brf2FindChunk, brf2Sdsc, missionBrf2Load, projectStreamLoad } from '../../src/shell/career/brf2.ts';
import { readStar } from '../../src/shell/handoff/stars.ts';
import { mem } from '../../src/shell/memory.ts';
import { expectSameLines, lines } from '../support/listing.ts';
import { gameSource, hasGameData, hasShellData, hasShellDecompiled, readShellListing } from '../support/env.ts';

describe.runIf(hasGameData && hasShellData && hasShellDecompiled)('BRF2 streams', () => {
  let exe: ExeImage;
  let prj: ProjectFile;
  beforeAll(async () => {
    exe = ExeImage.fromExe(await gameSource().read('MW2SHELL.EXE'));
    prj = new ProjectFile(await gameSource().read('MW2.PRJ'));
    startShellProcess(exe, prj);
  });

  it('every BRF2 stream matches listing/brf2.txt', () => {
    const out: string[] = [];
    for (const { name } of readNameTable(prj, 0xe)) {
      if (!/brf2$/i.test(name)) continue;
      const s = projectStreamLoad(name, 0xe, 'BWD')!;
      const dv = new DataView(s.buffer, s.byteOffset, s.byteLength);
      const items: Array<[number, string]> = [];
      const sups = brf2FindChunk(s, 'G');
      if (sups >= 0) {
        let t = '';
        for (let i = sups + 8; s[i] !== 0; i++) t += String.fromCharCode(s[i]!);
        items.push([sups, `launch ${t}`]);
      }
      let at = -1;
      for (const who of ['player', 'opponent']) {
        at = brf2FindChunk(s, 'F', at);
        if (at < 0) break;
        const d = brf2Sdsc(s, at);
        items.push([at, `${who} star: skill ${d.skill}, ${d.maxTonnage} t, ${d.memberCount} of ${d.maxMechs}: ${d.names.join(' ')}`]);
      }
      const p = brf2FindChunk(s, 'E');
      if (p >= 0) {
        let t = '';
        for (let i = p + 0xc; i < p + dv.getInt32(p + 4, true) && s[i] !== 0; i++) t += String.fromCharCode(s[i]!);
        items.push([p, `planet ${dv.getInt32(p + 8, true)}: ${t.trim().replace(/\n/g, ' / ')}`]);
      }
      items.sort((a, b) => a[0] - b[0]);
      out.push(`${name.padEnd(9)} ${items.map((x) => x[1]).join('; ')}`);
    }
    expectSameLines('brf2.txt', lines(readShellListing('brf2.txt')), out);
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
