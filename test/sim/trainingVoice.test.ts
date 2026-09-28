// The training instructor: tnw1SCN1's objectives name their announcements
// trn1_01S, trn1_02S ... - not SNDS resources in MW2.PRJ but files in the
// CD's KEATING directory, which main scans at start-up
// (project_scan_dev_dir) and the announcement loads (dev_dir_load_sfl).
// With the CD's directory read ahead, the first objective to succeed plays
// TRN1_01S.SFL as the voice line.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ExeImage } from '../../src/data/exe/ExeImage.ts';
import { ProjectFile } from '../../src/data/prj/ProjectFile.ts';
import { dosFilePrefetchDir, setCdDrive } from '../../src/engine/dosFiles.ts';
import { ailTimerService } from '../../src/engine/miles/ail.ts';
import { bootMission } from '../../src/mission/load.ts';
import { mainLoopFrame } from '../../src/mission/mainLoop.ts';
import { devDir, devDirLoadSfl } from '../../src/mission/devDir.ts';
import { sound } from '../../src/sim/sound/mixer.ts';
import { voice } from '../../src/sim/sound/voice.ts';
import { openCdImage } from '../support/cdImage.ts';
import { gameSource, hasCdImage, hasGameData, installFiles } from '../support/env.ts';

describe.runIf(hasGameData && hasCdImage)('the training instructor (the CD\'s KEATING directory)', () => {
  let exe: ExeImage;
  let prj: ProjectFile;
  let first: Uint8Array;
  beforeAll(async () => {
    exe = ExeImage.fromExe(await gameSource().read('MW2.EXE'));
    prj = new ProjectFile(await gameSource().read('MW2.PRJ'));
    const iso = await openCdImage();
    setCdDrive({
      letter: 'D',
      read: async (p) => ((await iso.exists(p)) ? iso.read(p) : null),
      list: async (dir) => {
        const e = await iso.lookup(dir);
        return e && e.directory ? (await iso.readDir(e)).filter((c) => !c.directory && c.name !== '.' && c.name !== '..').map((c) => c.name) : null;
      },
    });
    expect(await dosFilePrefetchDir('D:keating')).toBe(51);
    first = await iso.read('KEATING/TRN1_01S.SFL');
  });
  afterAll(() => setCdDrive(null));

  it('main scans D:keating; trn1_01S loads from it; the instructor starts talking', () => {
    bootMission({ exe, prj, looseFiles: installFiles(), mission: 'tnw1SCN1' });
    expect(devDir.devDirPath).toBe('D:keating');
    expect(devDir.entries.size).toBe(51);
    expect(devDirLoadSfl('trn1_01S')).toEqual(first);
    expect(devDirLoadSfl('no_such')).toBeNull();
    let spoke: Uint8Array | null = null;
    for (let f = 0; f < 30 * 20 && !spoke; f++) {
      for (let i = 0; i < 9; i++) ailTimerService();
      mainLoopFrame();
      const head = voice.voiceQueueHead;
      if (head?.buffer && sound.voiceSample !== 0) spoke = head.buffer;
    }
    expect(spoke).toEqual(first);
  });
});
