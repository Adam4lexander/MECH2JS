// orders_text_build: the ORDR chunk of a briefing / debriefing stream laid
// out as pages, with the \Q, \H and \R codes filled in.
import { beforeAll, describe, expect, it } from 'vitest';
import { ExeImage } from '../../src/data/exe/ExeImage.ts';
import { ProjectFile, resourceIdByName } from '../../src/data/prj/ProjectFile.ts';
import { mpackDbGetItem, mpackDbOpen } from '../../src/data/formats/mpack.ts';
import { dosFileLoad, setDosFiles, setOverlayFiles, setOwnFiles } from '../../src/engine/dosFiles.ts';
import { startShellProcess } from '../../src/shell/boot.ts';
import { shell } from '../../src/shell/state.ts';
import { VideoDriver, videoDriverInit } from '../../src/shell/video/driver.ts';
import { FontHolder, fontHolderInit } from '../../src/shell/ui/labels.ts';
import { ordersTextBuild, projectOpen } from '../../src/shell/career/orders.ts';
import { PILOT, rankTitle, setCurrentPilot } from '../../src/shell/career/missions.ts';
import { pilotRecord } from '../../src/shell/career/registry.ts';
import { mem } from '../../src/shell/memory.ts';
import type { Page } from '../../src/shell/text/page.ts';
import { gameSource, hasGameData, hasShellData } from '../support/env.ts';

describe.runIf(hasGameData && hasShellData)('orders_text_build', () => {
  let exe: ExeImage;
  let prj: ProjectFile;
  let fontBytes: Uint8Array;
  beforeAll(async () => {
    exe = ExeImage.fromExe(await gameSource().read('MW2SHELL.EXE'));
    prj = new ProjectFile(await gameSource().read('MW2.PRJ'));
    fontBytes = mpackDbGetItem(mpackDbOpen('DATABASE.MW2', await gameSource().read('DATABASE.MW2')), 0x20)!;
  });

  /** A shell process with a video driver, main's page font, the project open and pilot slot 0 current. */
  function start(rank: number, honor: number): FontHolder {
    setDosFiles(new Map());
    setOwnFiles(new Map());
    setOverlayFiles(null);
    startShellProcess(exe, prj);
    shell.videoDriver = videoDriverInit(new VideoDriver());
    projectOpen('MW2.PRJ');
    const pilot = pilotRecord(0);
    mem().setI32(pilot + PILOT.rank, rank);
    mem().setI32(pilot + PILOT.careerHonor, honor);
    setCurrentPilot(pilot);
    return fontHolderInit(new FontHolder(), fontBytes, shell.videoDriver);
  }

  const allText = (pages: Page[]) => pages.flatMap((p) => p.lines.map((l) => l.text)).join('|');

  it("lays out FUCHDBFS's debriefing: the caller's text quoted, split into its pages, no codes left", () => {
    const font = start(0, 1234);
    const pages: Page[] = [];
    ordersTextBuild(pages, 0x58, 0x1e, 0x1c6, 400, 'FUCHDBFS', font, 'QUOTED');
    // \q became the caller's text; \s split the pages (MISSION SUCCESSFUL ... then AFTERMATH)
    expect(allText(pages)).toContain('QUOTED');
    expect(pages.length).toBeGreaterThan(1);
    expect(pages[0]!.lines[0]!.text).toContain('MISSION');
    expect(pages.some((p) => p.lines.some((l) => l.text.includes('AFTERMATH')))).toBe(true);
    for (const p of pages) for (const l of p.lines) expect(l.text).not.toMatch(/\\[qQhH]/);
  });

  it('\\R0 \\R1 \\R2 become rankTitles[rank], [rank + 1], [rank + 2] clamped to 9', () => {
    // AMY_BRF1 carries \r codes; which digits it uses comes from the stream itself
    const s = prj.readResource('BWD', resourceIdByName(prj, 0xe, 'AMY_BRF1'))!;
    const raw = String.fromCharCode(...s);
    const digits = [...raw.matchAll(/\\[rR]([0-2])/g)].map((m) => Number(m[1]));
    expect(digits.length).toBeGreaterThan(0);
    for (const rank of [2, 8]) {
      const font = start(rank, 0);
      const pages: Page[] = [];
      ordersTextBuild(pages, 0x58, 0x1e, 0x1c6, 400, 'AMY_BRF1', font, '');
      const text = allText(pages);
      expect(text).not.toMatch(/\\[rR][0-2]/);
      for (const d of digits) {
        const title = rankTitle(d === 0 ? rank : Math.min(rank + d, 9));
        // a title may wrap across two lines: its first word is on one of them
        expect(text).toContain(title.split(' ')[0]!);
      }
    }
  });

  it('a stream with no ORDR chunk, or no such stream, lays out nothing', () => {
    const font = start(0, 0);
    const pages: Page[] = [];
    ordersTextBuild(pages, 0x58, 0x1e, 0x1c6, 400, 'NOSUCHXX', font, '');
    expect(pages.length).toBe(0);
    expect(dosFileLoad('tmp.out')).toBeNull();
  });
});
