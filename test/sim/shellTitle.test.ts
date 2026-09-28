// Phase S2's exit check: the shell's main, headless, from 'intro' to the
// title screen and out through EXIT -> 'Embrace cowardice?' -> Yes, driven
// by the int 33h mouse the way a player would; and the title's picture.
import { beforeAll, describe, expect, it } from 'vitest';
import { ExeImage } from '../../src/data/exe/ExeImage.ts';
import { ProjectFile } from '../../src/data/prj/ProjectFile.ts';
import { dosFileLoad, setCdDrive, setDosFiles, setOverlayFiles, setOwnFiles } from '../../src/engine/dosFiles.ts';
import { startShellProcess } from '../../src/shell/boot.ts';
import { shellMain } from '../../src/shell/main.ts';
import { ShellPump } from '../../src/shell/host/pump.ts';
import { hardware, hwMouseButtons, hwMouseMove } from '../../src/shell/host/hardware.ts';
import { prmCommandTail } from '../../src/launcher/mech2.ts';
import { gameSource, hasGameData, hasShellData } from '../support/env.ts';

/** Runs the pump a frame at a time (letting file reads settle), calling `script` before each frame. */
async function run(pump: ShellPump, script: (frame: number) => void, maxFrames = 4000): Promise<number> {
  for (let f = 0; f < maxFrames; f++) {
    script(f);
    if (!pump.frame(1000 / 60)) break;
    await new Promise((r) => setTimeout(r, 0));
  }
  if (pump.error) throw pump.error;
  return f0(pump.status);
}
const f0 = (s: number | null) => s ?? -1;

describe.runIf(hasGameData && hasShellData)('shell title screen', () => {
  let shellExe: ExeImage;
  let prj: ProjectFile;
  let db: Uint8Array;
  beforeAll(async () => {
    shellExe = ExeImage.fromExe(await gameSource().read('MW2SHELL.EXE'));
    prj = new ProjectFile(await gameSource().read('MW2.PRJ'));
    db = await gameSource().read('DATABASE.MW2');
  });

  it("EXIT, then Yes to 'Embrace cowardice?', quits with 0xff and parks exittos in mw2prm.cfg", async () => {
    setDosFiles(new Map([['DATABASE.MW2', db]]));
    setOwnFiles(new Map());
    setOverlayFiles(null);
    setCdDrive(null);
    startShellProcess(shellExe, prj);
    const pump = new ShellPump(shellMain(['mw2shell.exe', 'intro']));
    // frames 0..30: the title comes up; then the EXIT strip at the bottom; then the box's Yes (x 290 +- 26, y 276 +- 13)
    const status = await run(pump, (f) => {
      if (f === 30) hwMouseMove(320, 465);
      if (f === 32) hwMouseButtons(1);
      if (f === 34) hwMouseButtons(0);
      if (f === 40) hwMouseMove(290, 276);
      if (f === 42) hwMouseButtons(1);
      if (f === 44) hwMouseButtons(0);
    });
    expect(status).toBe(0xff);
    expect(prmCommandTail(dosFileLoad('mw2prm.cfg')!).startsWith('exittos -b=')).toBe(true);
    // the title's background was up: the screen holds more than one colour, and the DAC is not black
    expect(new Set(hardware.screen).size).toBeGreaterThan(8);
    expect(hardware.dac.some((v) => v !== 0)).toBe(true);
  });

  it('Esc opens the pop-up menu; FLEE TO DOS then Y quits', async () => {
    // the menu selects the item under the pointer on its first pass: keep the pointer off it
    hwMouseMove(0, 0);
    hwMouseButtons(0);
    setDosFiles(new Map([['DATABASE.MW2', db]]));
    setOwnFiles(new Map());
    setCdDrive(null);
    startShellProcess(shellExe, prj);
    const pump = new ShellPump(shellMain(['mw2shell.exe', 'intro']));
    const status = await run(pump, (f) => {
      // mouse_init centres the pointer (320, 240) - inside item 3's box - so move it off first
      if (f === 25) hwMouseMove(0, 0);
      if (f === 30) hardware.keys.push(0x1b);
      // FLEE TO DOS is the sixth item: Up from the first wraps to it; Enter picks it; 'y' answers Yes
      if (f === 40) hardware.keys.push(0, 0x48);
      if (f === 45) hardware.keys.push(0x0d);
      if (f === 55) hardware.keys.push(0x79);
    });
    expect(status).toBe(0xff);
  });
});
