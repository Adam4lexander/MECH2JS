// Phase S7, the mech lab, headless and driven by the mouse and keyboard the
// way a player would. The shell is relaunched ('sim') into the star screen
// of a Trial of Grievance whose player flies the Mad Dog's stock variant:
// MECH LAB -> CUSTOMIZE -> the Armor row -> ADD armour until the design is
// over weight -> SAVE is refused ('Chassis can not support current mass') ->
// DELETE armour -> SAVE writes mek\mdg00usr.mek -> ACCEPT MECH -> the star
// screen, whose player member now carries the new variant. The disk starts
// empty: the saved file is the port's own.
import { beforeAll, describe, expect, it } from 'vitest';
import { ExeImage } from '../../src/data/exe/ExeImage.ts';
import { ProjectFile } from '../../src/data/prj/ProjectFile.ts';
import { parseMek } from '../../src/data/formats/mek.ts';
import { dosFileLoad, dosFileWrite, dosFindFiles, setCdDrive, setDosFiles, setOverlayFiles, setOwnFiles } from '../../src/engine/dosFiles.ts';
import { SHELL_LABEL as L } from '../../src/generated/shell/labels.gen.ts';
import { startShellProcess } from '../../src/shell/boot.ts';
import { shellMain } from '../../src/shell/main.ts';
import { ShellPump } from '../../src/shell/host/pump.ts';
import { hardware, hwMouseButtons, hwMouseMove } from '../../src/shell/host/hardware.ts';
import { shellScreens } from '../../src/shell/screens/registry.ts';
import { mem } from '../../src/shell/memory.ts';
import { codeInfo, resolveCode } from '../../src/engine/codePtr.ts';
import { WIDGET, WIDGET_ROW } from '../../src/shell/ui/widgets.ts';
import { prmSave } from '../../src/shell/handoff/prm.ts';
import { readStar, starConfigure, starSetMember } from '../../src/shell/handoff/stars.ts';
import { gameSource, hasGameData, hasShellData } from '../support/env.ts';
import '../../src/shell/screens/index.ts';

describe.runIf(hasGameData && hasShellData)('shell mech lab', () => {
  let shellExe: ExeImage;
  let prj: ProjectFile;
  let db: Uint8Array;
  beforeAll(async () => {
    shellExe = ExeImage.fromExe(await gameSource().read('MW2SHELL.EXE'));
    prj = new ProjectFile(await gameSource().read('MW2.PRJ'));
    db = await gameSource().read('DATABASE.MW2');
  });

  it('every row of the lab panels has its draw and click functions ported', () => {
    startShellProcess(shellExe, prj);
    for (const table of [
      L.mechlabDesignPanel,
      L.mechlabCustomizingPanel,
      L.mechlabEnginePanel,
      L.mechlabHeatSinkPanel,
      L.mechlabJumpJetPanel,
      L.mechlabStructurePanel,
      L.mechlabArmorPanel,
      L.mechlabEquipmentPanel,
      L.mechlabWeaponsPanel,
      L.mechlabCriticalsPanel,
    ]) {
      let rows = 0;
      for (let row = table; mem().i32(row + WIDGET.x) !== -1; row += WIDGET_ROW, rows++) {
        for (const f of ['drawFn', 'clickFn'] as const) {
          const addr = mem().u32(row + WIDGET[f]);
          if (addr !== 0) expect(codeInfo(resolveCode(addr, 'mw2shell'))?.address, `row 0x${row.toString(16)} ${f}`).toBe(addr);
        }
      }
      expect(rows).toBeGreaterThan(5);
    }
  });

  it('star screen -> MECH LAB -> CUSTOMIZE: over weight is refused, then SAVE writes mek\\mdg00usr.mek and ACCEPT MECH gives it to the player', async () => {
    // a relaunch into state 0xd, career 2, the player's star holding the Mad Dog's stock variant
    hwMouseMove(320, 240);
    hwMouseButtons(0);
    hardware.keys.length = 0;
    setDosFiles(new Map([['DATABASE.MW2', db]]));
    setOwnFiles(new Map());
    setOverlayFiles(null);
    setCdDrive(null);
    startShellProcess(shellExe, prj);
    starConfigure(1, 0, 0, 0, 100);
    starConfigure(0, 0, 3, 1, 100);
    expect(starSetMember(0, 'mdg00std', 'TEST')).toBe(-1);
    prmSave(0xd, 2, 1, 'grievance');
    startShellProcess(shellExe, prj);

    const seen: number[] = [];
    const star = shellScreens.get(0xd)!;
    const lab = shellScreens.get(9)!;
    let starVisits = 0;
    let atStar: ReturnType<typeof readStar> | null = null;
    shellScreens.register(0xd, function* (l) {
      seen.push(0xd);
      if (++starVisits === 2) {
        atStar = readStar(L.playerStar);
        return -3;
      }
      return yield* star(l);
    });
    shellScreens.register(9, function* (l) {
      seen.push(9);
      return yield* lab(l);
    });
    try {
      const pump = new ShellPump(shellMain(['mw2shell.exe', 'sim']));
      const frames = async (n: number) => {
        for (let i = 0; i < n && pump.status === null; i++) {
          pump.frame(1000 / 60);
          await new Promise((r) => setTimeout(r, 0));
        }
        if (pump.error) throw pump.error;
      };
      const until = async (cond: () => boolean, max = 3000) => {
        for (let i = 0; i < max && !cond(); i++) await frames(1);
        expect(cond()).toBe(true);
      };
      const click = async (x: number, y: number) => {
        hwMouseMove(x, y);
        await frames(20);
        hwMouseButtons(1);
        await frames(2);
        hwMouseButtons(0);
        await frames(15);
      };
      /** the centre-left of a laid-out widget row */
      const clickRow = async (table: number, i: number) => {
        const row = table + i * WIDGET_ROW;
        await click(mem().i32(row + WIDGET.x) + 3, mem().i32(row + WIDGET.y) + 3);
      };
      const g = (a: number) => mem().i32(a);

      await until(() => seen.includes(0xd));
      await frames(30);
      // STAR CONFIG's MECH LAB (404..474 x 414..474)
      await click(440, 440);
      await until(() => seen.includes(9));
      await until(() => g(L.mechlabSummaryPanel) === L.mechlabDesignPanel);
      await frames(20);
      expect(mem().cstr(L.mechlabVariants, 13)).toBe('mdg00std');
      expect(g(L.mechlabVariant)).toBe(0);
      const stockArmour = g(L.designArmourMass);
      // CUSTOMIZE (50..149 x 420..444)
      await click(100, 432);
      await until(() => g(L.mechlabSummaryPanel) === L.mechlabCustomizingPanel);
      expect(mem().cstr(L.designTitle)).toBe('User Variant #1');
      // the summary's Armor row (23) opens the ARMOR panel
      await clickRow(L.mechlabCustomizingPanel, 23);
      await until(() => g(L.mechlabPanel) === L.mechlabArmorPanel);
      // ADD (row 10) until the design is over weight
      for (let i = 0; i < 40 && g(L.designMass) <= g(L.designMaxMass); i++) await clickRow(L.mechlabArmorPanel, 10);
      expect(g(L.designMass)).toBeGreaterThan(g(L.designMaxMass));
      // SAVE (50..149 x 420..444): refused, a message box; Enter takes its Ok
      await click(100, 432);
      await frames(30);
      hardware.keys.push(0x0d);
      await frames(30);
      expect(dosFindFiles('mek\\*.mek')).toEqual([]);
      expect(g(L.mechlabSummaryPanel)).toBe(L.mechlabCustomizingPanel);
      // DELETE (row 11) back under the chassis weight, a half ton below the stock armour
      for (let i = 0; i < 40 && g(L.designArmourMass) >= stockArmour; i++) await clickRow(L.mechlabArmorPanel, 11);
      expect(g(L.designArmourMass)).toBe(stockArmour - 50);
      expect(g(L.designMass)).toBeLessThanOrEqual(g(L.designMaxMass));
      // SAVE
      await click(100, 432);
      await until(() => g(L.mechlabSummaryPanel) === L.mechlabDesignPanel);
      expect(dosFindFiles('mek\\*.mek')).toEqual(['MDG00USR.MEK']);
      // the lab reloaded the list and selected the new slot, read back from the disk
      expect(g(L.mechlabVariant)).toBe(100);
      expect(mem().cstr(L.mechlabVariants + 100 * 13, 13)).toBe('MDG00USR');
      expect(g(L.designArmourMass)).toBe(stockArmour - 50);
      expect(mem().cstr(L.designTitle)).toBe('User Variant #1');
      const file = parseMek(dosFileLoad('mek\\mdg00usr.mek')!)!;
      expect(file.trailerText).toBe('User Variant #1');
      expect(file.chassis.tons).toBe(60);
      // ACCEPT MECH (50..149 x 395..419): the variant to the player, back to the star screen
      await click(100, 407);
      await until(() => pump.status !== null);
      expect(seen).toEqual([0xd, 9, 0xd]);
      expect(pump.status).toBe(0xff);
      expect(atStar!.members[0]).toMatchObject({ mekName: 'MDG00USR', pilotName: 'TEST' });
    } finally {
      shellScreens.register(0xd, star);
      shellScreens.register(9, lab);
    }
  });

  it('the other refusals: unassigned criticals on SAVE, the Keshik maximum on ACCEPT MECH, a full set of user slots on CUSTOMIZE', async () => {
    hwMouseMove(320, 240);
    hwMouseButtons(0);
    hardware.keys.length = 0;
    setDosFiles(new Map([['DATABASE.MW2', db]]));
    setOwnFiles(new Map());
    setOverlayFiles(null);
    setCdDrive(null);
    startShellProcess(shellExe, prj);
    starConfigure(1, 0, 0, 0, 100);
    starConfigure(0, 0, 3, 1, 100);
    expect(starSetMember(0, 'mdg00std', 'TEST')).toBe(-1);
    // a Keshik maximum under the Mad Dog's 60 t
    starConfigure(0, -1, -1, -1, 50);
    prmSave(0xd, 2, 1, 'grievance');
    startShellProcess(shellExe, prj);
    const grievance = shellScreens.get(7);
    let left = false;
    // EXIT LAB returns 0xb, which main turns into 7 in career 2: a probe quits there
    // eslint-disable-next-line require-yield -- a screen that returns at once
    shellScreens.register(7, function* () {
      left = true;
      return -3;
    });
    try {
      const pump = new ShellPump(shellMain(['mw2shell.exe', 'sim']));
      const frames = async (n: number) => {
        for (let i = 0; i < n && pump.status === null; i++) {
          pump.frame(1000 / 60);
          await new Promise((r) => setTimeout(r, 0));
        }
        if (pump.error) throw pump.error;
      };
      const g = (a: number) => mem().i32(a);
      const until = async (cond: () => boolean, max = 3000) => {
        for (let i = 0; i < max && !cond(); i++) await frames(1);
        expect(cond()).toBe(true);
      };
      const click = async (x: number, y: number) => {
        hwMouseMove(x, y);
        await frames(20);
        hwMouseButtons(1);
        await frames(2);
        hwMouseButtons(0);
        await frames(15);
      };
      const clickRow = async (table: number, i: number) => {
        const row = table + i * WIDGET_ROW;
        await click(mem().i32(row + WIDGET.x) + 3, mem().i32(row + WIDGET.y) + 3);
      };
      const ok = async () => {
        await frames(30);
        hardware.keys.push(0x0d);
        await frames(30);
      };
      await frames(60);
      await click(440, 440); // MECH LAB
      await until(() => g(L.mechlabSummaryPanel) === L.mechlabDesignPanel);
      await frames(20);
      // CUSTOMIZE, the Weapons row (26), a WEAPONS TABLE row (31, the ER Large Laser) and ADD WEAPON (11)
      await click(100, 432);
      await until(() => g(L.mechlabSummaryPanel) === L.mechlabCustomizingPanel);
      await clickRow(L.mechlabCustomizingPanel, 26);
      await until(() => g(L.mechlabPanel) === L.mechlabWeaponsPanel);
      await clickRow(L.mechlabWeaponsPanel, 31);
      expect(g(L.mechlabSelectedItem)).toBe(0x16 * 100);
      await clickRow(L.mechlabWeaponsPanel, 11);
      expect(((g(L.mechlabUnplaced) / 100) | 0)).toBe(0x16);
      // SAVE: 'Unassigned criticals detected', still customizing, nothing written
      await click(100, 432);
      await ok();
      expect(g(L.mechlabSummaryPanel)).toBe(L.mechlabCustomizingPanel);
      expect(dosFindFiles('mek\\*.mek')).toEqual([]);
      // ABORT (50..149 x 445..469): back to browsing the stock variant, the weapon gone
      await click(100, 457);
      await until(() => g(L.mechlabSummaryPanel) === L.mechlabDesignPanel);
      expect(g(L.mechlabUnplaced)).toBe(-1);
      // ACCEPT MECH: the Mad Dog is over the star's 50 t - refused, the member unchanged
      await click(100, 407);
      await ok();
      expect(readStar(L.playerStar).members[0]!.mekName).toBe('mdg00std');
      // all 100 user slots taken: NEXT then PREV CHASSIS rebuild the list, and CUSTOMIZE refuses
      for (let i = 0; i < 100; i++) dosFileWrite(`mek\\mdg${String(i).padStart(2, '0')}usr.mek`, new Uint8Array(0));
      await click(316, 447); // NEXT CHASSIS (303..330 x 425..469)
      await click(218, 447); // PREV CHASSIS (200..236 x 425..469)
      await frames(20);
      expect(mem().cstr(L.mechlabVariants + 199 * 13, 13)).toBe('MDG99USR');
      await click(100, 432);
      await ok();
      expect(g(L.mechlabSummaryPanel)).toBe(L.mechlabDesignPanel);
      // EXIT LAB
      await click(100, 457);
      await until(() => pump.status !== null);
      expect(left).toBe(true);
    } finally {
      if (grievance) shellScreens.register(7, grievance);
    }
  });
});
