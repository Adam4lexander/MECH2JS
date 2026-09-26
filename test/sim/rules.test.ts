// The rule toggles the port supplies in place of mw2dif.cfg, and the
// weapon keys, through main's loop and KEYBOARD.DLL's handler. With the
// default rules the player's weapons heat the mech (mech_weapons_tick adds
// WeaponType.heat per round, mech_heat_update keeps it); with heatTracking
// off mech_heat_update zeroes the player's heat every update, as the
// original does with no mw2dif.cfg. Shift+2 (ADD_WEAPON_TO_GROUP_2) puts
// the selected weapon in fire group 1.
import { beforeAll, describe, expect, it } from 'vitest';
import { ExeImage } from '../../src/data/exe/ExeImage.ts';
import { ProjectFile } from '../../src/data/prj/ProjectFile.ts';
import { ailTimerService } from '../../src/engine/miles/ail.ts';
import { bootMission } from '../../src/mission/load.ts';
import { mainLoopFrame } from '../../src/mission/mainLoop.ts';
import { KeyboardDriver } from '../../src/sim/controls/giddi.ts';
import { input } from '../../src/sim/controls/input.ts';
import { loadoutWeapons } from '../../src/sim/mech/loadout.ts';
import { mechs } from '../../src/sim/mech/mechGlobals.ts';
import { DEFAULT_RULES, type SimRules } from '../../src/sim/mech/simOptions.ts';
import { gameSource, hasGameData, installFiles } from '../support/env.ts';

let exe: ExeImage;
let prj: ProjectFile;
let files: Map<string, Uint8Array>;

function frame(ticks = 7) {
  for (let i = 0; i < ticks; i++) ailTimerService();
  mainLoopFrame();
}

/** AMY_SCN1 with these rules, run until the player's mech is up (status 2) */
function boot(rules: SimRules) {
  bootMission({ exe, prj, looseFiles: files, mission: 'AMY_SCN1', rules });
  const p = mechs.mechTable[mechs.playerMechIndex]!;
  for (let f = 0; f < 400 && p.loadout!.status !== 2; f++) frame();
  expect(p.loadout!.status).toBe(2);
  return { p, kb: input.devices[input.keyboardDevice]!.driver as KeyboardDriver };
}

/** group fire on, then pull and release the trigger for `frames` frames; the highest heat seen */
function fire(kb: KeyboardDriver, frames: number): number {
  const l = mechs.mechTable[mechs.playerMechIndex]!.loadout!;
  kb.isr(0x2b); // '\' toggle_group_fire
  frame();
  kb.isr(0xab);
  let peak = 0;
  for (let f = 0; f < frames; f++) {
    if (f % 8 === 0) kb.isr(0x39);
    if (f % 8 === 4) kb.isr(0xb9);
    frame();
    peak = Math.max(peak, l.heatLevel);
  }
  return peak;
}

describe.runIf(hasGameData)('rules', () => {
  beforeAll(async () => {
    const src = gameSource();
    exe = ExeImage.fromExe(await src.read('MW2.EXE'));
    prj = new ProjectFile(await src.read('MW2.PRJ'));
    files = installFiles();
  });

  it('with the default rules, firing heats the player; with heat tracking off it does not', () => {
    expect(DEFAULT_RULES.heatTracking).toBe(true);
    const on = boot(DEFAULT_RULES);
    expect(mechs.simOptions.heatTracking).toBe(1);
    expect(fire(on.kb, 80) >> 16).toBeGreaterThan(5);

    const off = boot({ ...DEFAULT_RULES, heatTracking: false });
    expect(mechs.simOptions.heatTracking).toBe(0);
    expect(fire(off.kb, 80)).toBe(0);
  });

  it('Shift+2 puts the selected weapon in fire group 1', () => {
    const { p, kb } = boot(DEFAULT_RULES);
    const l = p.loadout!;
    const w = loadoutWeapons(l)[l.selectedWeapon]!;
    expect(w.fireGroup).not.toBe(1);
    kb.isr(0x2a); // left shift down
    kb.isr(0x03); // 2
    frame();
    kb.isr(0x83);
    kb.isr(0xaa);
    frame();
    expect(w.fireGroup).toBe(1);
  });
});
