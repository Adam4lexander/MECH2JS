// MW2.EXE's launch screen: the pilot's launch picture and the launch
// animation off the CD, put up by main's start-up before the mission loads,
// and the allegiance tallies main takes once it has.
import { beforeAll, describe, expect, it } from 'vitest';
import { ExeImage } from '../../src/data/exe/ExeImage.ts';
import { ProjectFile } from '../../src/data/prj/ProjectFile.ts';
import { dosFilePrefetch, setCdDrive } from '../../src/engine/dosFiles.ts';
import { bootMissionStart } from '../../src/mission/load.ts';
import { launchNamesFromArgv, splitCommandTail } from '../../src/mission/commandLine.ts';
import { launchAnimPath, launchAnimTick, launchScreen } from '../../src/sim/display/launchScreen.ts';
import { defaultCanvas } from '../../src/sim/display/video.ts';
import { palettes } from '../../src/sim/world/palettes.ts';
import { simTables } from '../../src/sim/effects/simTables.ts';
import { openCd } from '../support/cdImage.ts';
import { gameSource, hasCd, hasGameData, installFiles } from '../support/env.ts';

describe.runIf(hasGameData && hasCd)('launch screen', () => {
  let exe: ExeImage;
  let prj: ProjectFile;
  beforeAll(async () => {
    exe = ExeImage.fromExe(await gameSource().read('MW2.EXE'));
    prj = new ProjectFile(await gameSource().read('MW2.PRJ'));
    setCdDrive(await openCd());
  });

  it('puts up launch\\ljftria.shp with the launch animation, then boots and stops it', async () => {
    const argv = splitCommandTail('mw2.exe', 'blonscn1 -b=ljftria -of=echelonl');
    expect(launchNamesFromArgv(argv)).toEqual(['ljftria', 'launch']);
    for (const n of launchNamesFromArgv(argv)) for (const v of ['', '6']) await dosFilePrefetch(launchAnimPath(n, v));
    const finish = bootMissionStart({ exe, prj, looseFiles: installFiles(), argv });
    expect(finish).not.toBe(false);
    expect(launchScreen.picture).not.toBeNull();
    expect(launchScreen.animationCount).toBeGreaterThan(1);
    // the picture is on the game's window, and its palette is in the DAC
    const drawn = defaultCanvas.buffer.reduce((n, v) => n + (v ? 1 : 0), 0);
    expect(drawn).toBeGreaterThan(10000);
    expect(palettes.dac.some((v, i) => i >= 48 && v !== 0)).toBe(true);
    const before = launchScreen.frame;
    launchAnimTick();
    expect(launchScreen.frame).toBe((before + 1) % launchScreen.animationCount);
    expect((finish as () => boolean)()).toBe(true);
    expect(launchScreen.picture).toBeNull();
    // sim_count_mechs_by_status: someone is counted on each side of BLONSCN1
    const w = (a: number) => simTables.dat000a5630[a - 0xa5630]! | (simTables.dat000a5630[a - 0xa5630 + 1]! << 8);
    expect(w(0xa5668)).toBeGreaterThan(0);
    expect(w(0xa566c)).toBeGreaterThan(0);
  });
});
