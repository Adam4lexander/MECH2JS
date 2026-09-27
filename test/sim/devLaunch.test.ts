// The dev route's launch through the shell's handoff code: the 15 missions
// that take opponent stars now load with their opponents (with empty EN
// files they had only the player's star).
import { beforeAll, describe, expect, it } from 'vitest';
import { ExeImage } from '../../src/data/exe/ExeImage.ts';
import { ProjectFile } from '../../src/data/prj/ProjectFile.ts';
import { setDosFiles, setOverlayFiles, setOwnFiles } from '../../src/engine/dosFiles.ts';
import { missionCatalog } from '../../src/app/gameData.ts';
import { bootMission } from '../../src/mission/load.ts';
import { mechAllegiance } from '../../src/sim/groups/groups.ts';
import { mechs } from '../../src/sim/mech/mechGlobals.ts';
import { prepareDevMission } from '../../src/shell/devLaunch.ts';
import { gameSource, hasGameData, hasShellData, installFiles } from '../support/env.ts';

describe.runIf(hasGameData && hasShellData)('dev launch through the shell handoff', () => {
  let exe: ExeImage;
  let shellExe: ExeImage;
  let prj: ProjectFile;
  beforeAll(async () => {
    exe = ExeImage.fromExe(await gameSource().read('MW2.EXE'));
    shellExe = ExeImage.fromExe(await gameSource().read('MW2SHELL.EXE'));
    prj = new ProjectFile(await gameSource().read('MW2.PRJ'));
  });

  it('every opponents mission loads with an enemy star', () => {
    const assets = installFiles();
    for (const k of [...assets.keys()]) if (/STAR\.BWD$|INSTMAP1/.test(k)) assets.delete(k);
    setDosFiles(assets);
    setOwnFiles(new Map());
    const opp = missionCatalog(prj).filter((m) => m.needs === 'opponents');
    expect(opp.length).toBe(15);
    const report: string[] = [];
    for (const m of opp) {
      const argv = prepareDevMission({ shellExe, prj, stream: m.stream, insignia: m.loose.includes('INSTMAP1.BWD'), userStar: null });
      expect(argv[1]).toBe(m.stream.toLowerCase());
      expect(bootMission({ exe, prj, argv })).toBe(true);
      let enemies = 0;
      for (let i = 0; i < mechs.mechCount; i++) if (mechAllegiance(i) !== mechAllegiance(mechs.playerMechIndex)) enemies++;
      report.push(`${m.stream} mechs=${mechs.mechCount} enemies=${enemies}`);
      expect(enemies, m.stream).toBeGreaterThan(0);
    }
    setOverlayFiles(null);
    console.log(report.join('\n'));
  });
});
