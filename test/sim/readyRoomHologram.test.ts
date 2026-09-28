// MECH LAB in the ready room plays the chassis's table hologram first. The
// shell asks for awo<two-letter code>stbl, which the CD does not have; the
// port then tries the CD's one-letter names: the Dire Wolf's (da) for the
// Dire Wolf, the Timber Wolf's (mc) for every other chassis. Each plays
// (14 frames of 264x240) before the lab.
import { describe, expect, it } from 'vitest';
import { ExeImage } from '../../src/data/exe/ExeImage.ts';
import { ProjectFile } from '../../src/data/prj/ProjectFile.ts';
import { setCdDrive, setDosFiles, setOverlayFiles, setOwnFiles } from '../../src/engine/dosFiles.ts';
import { startShellProcess } from '../../src/shell/boot.ts';
import { shellMain } from '../../src/shell/main.ts';
import { ShellPump } from '../../src/shell/host/pump.ts';
import { hardware, hwMouseButtons, hwMouseMove } from '../../src/shell/host/hardware.ts';
import { shellScreens, type Screen } from '../../src/shell/screens/registry.ts';
import { anims } from '../../src/shell/anim/anims.ts';
import { currentStar, starMember } from '../../src/shell/handoff/stars.ts';
import { mem } from '../../src/shell/memory.ts';
import { openCdImage } from '../support/cdImage.ts';
import { gameSource, hasCdImage, hasGameData, hasShellData } from '../support/env.ts';

describe.runIf(hasGameData && hasShellData && hasCdImage)('the MECH LAB table hologram', () => {
  it.each([
    [9, 'Timber Wolf', 'AWODSTBL'],
    [5, 'Mad Dog', 'AWODSTBL'],
    [14, 'Dire Wolf', 'AWOMSTBL'],
  ])('chassis %i (%s): %s plays before the lab opens', async (chassis, _name, file) => {
    const shellExe = ExeImage.fromExe(await gameSource().read('MW2SHELL.EXE'));
    const prj = new ProjectFile(await gameSource().read('MW2.PRJ'));
    const db = await gameSource().read('DATABASE.MW2');
    const iso = await openCdImage();
    hwMouseMove(320, 240);
    hwMouseButtons(0);
    hardware.keys.length = 0;
    setDosFiles(new Map([['DATABASE.MW2', db]]));
    // a registry whose slot 0 is a selected Wolf pilot
    const reg = new Uint8Array(0x3c * 20);
    const dv = new DataView(reg.buffer);
    for (let i = 10; i < 20; i++) dv.setInt32(i * 0x3c + 8, 1, true);
    dv.setInt32(0, 1, true);
    dv.setInt32(4, 1, true);
    reg.set(Array.from('PILOT', (c) => c.charCodeAt(0)), 0x28);
    setOwnFiles(new Map([['MW2REG.CFG', reg]]));
    setOverlayFiles(null);
    const stbl: string[] = [];
    setCdDrive({
      letter: 'D',
      read: async (p) => {
        const ok = await iso.exists(p);
        if (/stbl/i.test(p) && ok) stbl.push(p.toUpperCase());
        return ok ? iso.read(p) : null;
      },
    });
    const seen: number[] = [];
    const saved = new Map<number, Screen>();
    for (const state of [1, 9, 0xb, 0xc]) {
      const s = shellScreens.get(state)!;
      saved.set(state, s);
      shellScreens.register(state, function* (l) {
        seen.push(state);
        // the lab itself: record that it was reached, and quit
        if (state === 9) return -3;
        return yield* s(l);
      });
    }
    try {
      startShellProcess(shellExe, prj);
      const pump = new ShellPump(shellMain(['mw2shell.exe', 'intro']));
      let f = 0;
      const steps: { until: () => boolean; act: () => void }[] = [];
      const click = (x: number, y: number, until: () => boolean) => {
        let t = 0;
        steps.push({ until, act: () => { hwMouseMove(x, y); t = 0; } });
        steps.push({ until: () => ++t > 3, act: () => hwMouseButtons(1) });
        steps.push({ until: () => ++t > 18, act: () => hwMouseButtons(0) });
      };
      // skip the intro; WOLF CLAN HALL; ACCEPT the pilot; READY ROOM
      steps.push({ until: () => f > 5, act: () => hardware.keys.push(0x1b) });
      click(530, 300, () => f > 60);
      click(344, 462, () => seen.includes(0xc) && f > 200);
      click(55, 330, () => seen.filter((s) => s === 1).length >= 2);
      // in the ready room: the star's selected member becomes the chassis; MECH LAB
      let patched = false;
      steps.push({
        until: () => seen.includes(0xb) && f > 0,
        act: () => {
          const s = currentStar();
          const selected = mem().i32(s + 4);
          mem().setI32(starMember(s, selected < 0 ? 0 : selected), chassis);
          patched = true;
        },
      });
      click(430, 370, () => patched);
      let hologram: { frames: number; w: number; h: number } | null = null;
      let i = 0;
      for (; f < 4000; f++) {
        const s = steps[i];
        if (s && s.until()) {
          s.act();
          i++;
        }
        if (!pump.frame(1000 / 60)) break;
        await new Promise((r) => setTimeout(r, 0));
        const a = anims.animSlots[0]!;
        if (a.smk && a.frameCount === 14) hologram = { frames: a.frameCount, w: a.width, h: a.height };
      }
      if (pump.error) throw pump.error;
      expect(hologram).toEqual({ frames: 14, w: 264, h: 240 });
      expect(stbl.map((p) => p.split(/[\\/]/).pop())).toEqual([`${file}.SMK`]);
      expect(seen).toContain(9);
    } finally {
      for (const [state, s] of saved) shellScreens.register(state, s);
    }
  });
});
