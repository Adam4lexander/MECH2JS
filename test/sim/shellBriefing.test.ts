// Phase S5a: main resumed by MECH2 ('sim') at the briefing (state 0) and at
// the Clan archive (state 5), headless, driven with the int 33h mouse. The
// briefing types its orders and LAUNCH parks state 3 (the debriefing) in
// mw2prm.cfg and exits 3; the archive opens ARCHWO.MW2's home page, a
// topic word opens its linked page, and EXIT leaves.
import { beforeAll, describe, expect, it } from 'vitest';
import { ExeImage } from '../../src/data/exe/ExeImage.ts';
import { ProjectFile } from '../../src/data/prj/ProjectFile.ts';
import { mpackDbGetItem, mpackDbOpen } from '../../src/data/formats/mpack.ts';
import { dosFileLoad, setCdDrive, setDosFiles, setOverlayFiles, setOwnFiles } from '../../src/engine/dosFiles.ts';
import { startShellProcess } from '../../src/shell/boot.ts';
import { shellMain } from '../../src/shell/main.ts';
import { ShellPump } from '../../src/shell/host/pump.ts';
import { hwMouseButtons, hwMouseMove } from '../../src/shell/host/hardware.ts';
import { shell } from '../../src/shell/state.ts';
import { fieldOffset, mem } from '../../src/shell/memory.ts';
import { prmSave } from '../../src/shell/handoff/prm.ts';
import { careerRegistrySave, pilotRecord } from '../../src/shell/career/registry.ts';
import { PILOT, setCurrentPilot } from '../../src/shell/career/missions.ts';
import { archiveReadOp } from '../../src/shell/archive/viewer.ts';
import { Page, pageInit, textLayoutPage } from '../../src/shell/text/page.ts';
import { FontHolder, fontHolderInit, type TextLabel } from '../../src/shell/ui/labels.ts';
import { VideoDriver } from '../../src/shell/video/driver.ts';
import { gameSource, hasGameData, hasShellData } from '../support/env.ts';

/** Runs the pump a frame at a time (letting file reads settle), calling `script` before each frame. */
async function run(pump: ShellPump, script: (frame: number) => void, maxFrames = 3000): Promise<number> {
  for (let f = 0; f < maxFrames; f++) {
    script(f);
    if (!pump.frame(1000 / 60)) break;
    await new Promise((r) => setTimeout(r, 0));
  }
  if (pump.error) throw pump.error;
  return pump.status ?? -1;
}

/** A click at (x, y) starting at frame f: move, press two frames later, release two after that. */
function click(frame: number, f: number, x: number, y: number): void {
  if (frame === f) hwMouseMove(x, y);
  if (frame === f + 2) hwMouseButtons(1);
  if (frame === f + 4) hwMouseButtons(0);
}

describe.runIf(hasGameData && hasShellData)('shell briefing and archive screens', () => {
  let exe: ExeImage;
  let prj: ProjectFile;
  let db: Uint8Array;
  let archwo: Uint8Array;
  beforeAll(async () => {
    exe = ExeImage.fromExe(await gameSource().read('MW2SHELL.EXE'));
    prj = new ProjectFile(await gameSource().read('MW2.PRJ'));
    db = await gameSource().read('DATABASE.MW2');
    archwo = await gameSource().read('ARCHWO.MW2');
  });

  /** The own disk as a previous shell run leaves it: pilot ADAM in slot 0 (Wolf, mission 0), and mw2prm.cfg resuming `state`. */
  function parkAt(state: number, commandLine: string): void {
    hwMouseMove(0, 0);
    hwMouseButtons(0);
    setDosFiles(
      new Map([
        ['DATABASE.MW2', db],
        ['ARCHWO.MW2', archwo],
      ]),
    );
    setOwnFiles(new Map());
    setOverlayFiles(null);
    setCdDrive(null);
    startShellProcess(exe, prj);
    const m = mem();
    const pilot = pilotRecord(0);
    m.setI32(pilot + PILOT.inUse, 1);
    m.strcpy(pilot + PILOT.pilotName, 'ADAM');
    setCurrentPilot(pilot);
    careerRegistrySave();
    prmSave(state, 0, 1, commandLine);
    // a fresh process reads them back
    startShellProcess(exe, prj);
  }

  /** Labels on the driver's lists whose text contains `s`. */
  const labelsWith = (list: 'labelsOver' | 'labelsUnder', s: string) => (shell.videoDriver![list] as TextLabel[]).filter((l) => l.text.includes(s));

  it('the briefing types YELLBRF1\'s orders; LAUNCH parks the debriefing and runs the mission', async () => {
    parkAt(0, 'yellSCN1');
    const pump = new ShellPump(shellMain(['mw2shell.exe', 'sim']));
    let typed: TextLabel[] = [];
    let situation: TextLabel[] = [];
    let back: TextLabel[] = [];
    const typing = () => (shell.videoDriver!.labelsOver as TextLabel[]).filter((l) => l.typewriter === 1 && l.charIndex > 0);
    const status = await run(pump, (f) => {
      if (f === 200) typed = typing();
      // SITUATION (110..209, 450..474): YELLBRF1's second page (after its \s) in the viewer
      click(f, 210, 160, 462);
      if (f === 300) situation = typing();
      // the viewer's EXIT (110..209, 450..474) comes back to the briefing, which types its page again
      click(f, 310, 160, 462);
      if (f === 400) back = typing();
      // LAUNCH: (270..369, 450..474)
      click(f, 410, 320, 462);
    });
    // the page was typing: a line in typewriter mode partly typed, on the list drawn over the animations
    expect(typed.length).toBeGreaterThan(0);
    // the second page's lines replaced the first's (page_hide hid them), and came back after EXIT
    expect(situation.length).toBeGreaterThan(0);
    expect(situation.some((l) => typed.includes(l))).toBe(false);
    expect(back.some((l) => typed.includes(l))).toBe(true);
    expect(status).toBe(3);
    const prm = dosFileLoad('mw2prm.cfg')!;
    const dv = new DataView(prm.buffer, prm.byteOffset, prm.byteLength);
    expect(dv.getInt32(fieldOffset('PrmBlock', 'resumeState'), true)).toBe(3);
    // orders_text_build wrote the raw orders to tmp.out
    expect(dosFileLoad('tmp.out')!.length).toBeGreaterThan(100);
  });

  it('the archive opens its home page; a topic word opens the linked page; EXIT goes back', async () => {
    parkAt(5, 'yellSCN1');
    // where the home page's region for link 2 ('3. Clan Wolf', page item 18) lies, laid out as the viewer lays it
    const arch = mpackDbOpen('ARCHWO.MW2', archwo);
    const font = fontHolderInit(new FontHolder(), mpackDbGetItem(mpackDbOpen('DATABASE.MW2', db), 0x20)!, new VideoDriver());
    let off = 2 + 'Clan History'.length + 1;
    let text = '';
    for (;;) {
      const r = archiveReadOp(arch, 1, off);
      off = r.next;
      if ('lines' in r) text = r.lines.join('') + ' ';
      if (r.op === 0xff00) break;
    }
    const page = pageInit(new Page(), font, font.driver!, null, 0x58, 0x46, 0x1d2, 0xde);
    textLayoutPage(page, text);
    const region = page.regions.find((r) => r.id === 2)!;
    expect(region).toBeDefined();
    const rx = ((region.x0 + region.x1) / 2) | 0;
    const ry = ((region.y0 + region.y1) / 2) | 0;
    let home: TextLabel[] = [];
    let wolf: TextLabel[] = [];
    const pump = new ShellPump(shellMain(['mw2shell.exe', 'sim']));
    const status = await run(pump, (f) => {
      if (f === 100) home = labelsWith('labelsUnder', 'Clan History');
      click(f, 110, rx, ry);
      if (f === 200) wolf = labelsWith('labelsUnder', 'Clan Wolf');
      // EXIT: the strip at the bottom (0..639, 440..479)
      click(f, 210, 320, 465);
    });
    expect(home.length).toBe(1);
    expect(wolf.length).toBe(1);
    // -5 from the nested viewer leaves the archive: -2, back to the state before (10 on a 'sim' start), which parks state 5 and exits 3
    expect(status).toBe(3);
  });
});
