// HALL OF HONOR and THE KESHIK, opened from the Esc menu over the title
// screen, headless: each draws, runs until a key, and hands back to the
// menu; the Hall ranks a registry of two pilots made here.
import { beforeAll, describe, expect, it } from 'vitest';
import { ExeImage } from '../../src/data/exe/ExeImage.ts';
import { ProjectFile } from '../../src/data/prj/ProjectFile.ts';
import { dosFileLoad, setCdDrive, setDosFiles, setOverlayFiles, setOwnFiles } from '../../src/engine/dosFiles.ts';
import { SHELL_LABEL } from '../../src/generated/shell/labels.gen.ts';
import { startShellProcess } from '../../src/shell/boot.ts';
import { shellMain } from '../../src/shell/main.ts';
import { ShellPump } from '../../src/shell/host/pump.ts';
import { hardware, hwMouseButtons, hwMouseMove } from '../../src/shell/host/hardware.ts';
import { mem } from '../../src/shell/memory.ts';
import { careerRegistryLoad, careerRegistrySave, pilotRecord } from '../../src/shell/career/registry.ts';
import { PILOT } from '../../src/shell/career/missions.ts';
import '../../src/shell/screens/credits.ts';
import '../../src/shell/screens/hallOfHonor.ts';
import { gameSource, hasGameData, hasShellData } from '../support/env.ts';

describe.runIf(hasGameData && hasShellData)('shell menu screens', () => {
  let shellExe: ExeImage;
  let prj: ProjectFile;
  let db: Uint8Array;
  let reg: Uint8Array;
  beforeAll(async () => {
    shellExe = ExeImage.fromExe(await gameSource().read('MW2SHELL.EXE'));
    prj = new ProjectFile(await gameSource().read('MW2.PRJ'));
    db = await gameSource().read('DATABASE.MW2');
    // MW2REG.CFG with two pilots in it, as the shell's registry code writes it
    setDosFiles(new Map());
    setOwnFiles(new Map());
    setOverlayFiles(null);
    startShellProcess(shellExe, prj);
    careerRegistryLoad();
    const m = mem();
    for (const [slot, name, honor] of [
      [0, 'ADAM', 12000],
      [1, 'FRIEND', 3000],
    ] as const) {
      const p = pilotRecord(slot);
      m.setI32(p + PILOT.inUse, 1);
      m.setI32(p + PILOT.careerHonor, honor);
      m.strcpy(p + PILOT.pilotName, name);
    }
    careerRegistrySave();
    reg = dosFileLoad('MW2REG.CFG')!;
  });

  it('Hall of Honor, then the Keshik, then Flee to DOS', async () => {
    hwMouseMove(0, 0);
    hwMouseButtons(0);
    setDosFiles(new Map([['DATABASE.MW2', db]]));
    setOwnFiles(new Map([['MW2REG.CFG', reg]]));
    setOverlayFiles(null);
    setCdDrive(null);
    startShellProcess(shellExe, prj);
    const pump = new ShellPump(shellMain(['mw2shell.exe', 'intro']));
    const snaps: Record<string, Uint8Array> = {};
    const lit = (s: Uint8Array, y0: number, y1: number) => {
      const seen = new Set<number>();
      for (let y = y0; y < y1; y++) for (let x = 0; x < 640; x++) seen.add(s[y * 640 + x]!);
      return seen.size;
    };
    const script: Record<number, () => void> = {
      25: () => hwMouseMove(0, 0),
      30: () => hardware.keys.push(0x1b),
      // HALL OF HONOR is the fourth item
      40: () => hardware.keys.push(0, 0x50),
      42: () => hardware.keys.push(0, 0x50),
      44: () => hardware.keys.push(0, 0x50),
      46: () => hardware.keys.push(0x0d),
      60: () => (snaps.hall = hardware.screen.slice()),
      62: () => hardware.keys.push(0x20),
      // back in the menu, which starts again on its first item: THE KESHIK is the fifth
      70: () => hardware.keys.push(0, 0x50),
      71: () => hardware.keys.push(0, 0x50),
      72: () => hardware.keys.push(0, 0x50),
      73: () => hardware.keys.push(0, 0x50),
      75: () => hardware.keys.push(0x0d),
      100: () => (snaps.credits1 = hardware.screen.slice()),
      160: () => (snaps.credits2 = hardware.screen.slice()),
      162: () => hardware.keys.push(0x20),
      // FLEE TO DOS: Up from the first item wraps to it
      170: () => hardware.keys.push(0, 0x48),
      172: () => hardware.keys.push(0x0d),
      180: () => hardware.keys.push(0x79),
    };
    for (let f = 0; f < 400; f++) {
      script[f]?.();
      if (!pump.frame(1000 / 60)) break;
      await new Promise((r) => setTimeout(r, 0));
    }
    if (pump.error) throw pump.error;
    expect(pump.status).toBe(0xff);
    // the Hall: a header row at 150 and pilot rows from 182
    expect(lit(snaps.hall!, 150, 166)).toBeGreaterThan(1);
    expect(lit(snaps.hall!, 182, 198)).toBeGreaterThan(1);
    // the Keshik scrolls: the text area changes between the two looks
    const a = snaps.credits1!;
    const b = snaps.credits2!;
    let changed = 0;
    for (let i = 105 * 640; i < 460 * 640; i++) if (a[i] !== b[i]) changed++;
    expect(changed).toBeGreaterThan(1000);
    // any date after October 1995 swaps the shell programmers' credit into the table
    const m = mem();
    let swapped = 0;
    for (let i = 0; i < 0x184; i++) if (m.u32(SHELL_LABEL.creditsLines + i * 4) === 0x7ca5c) swapped++;
    expect(swapped).toBe(1);
  });
});
