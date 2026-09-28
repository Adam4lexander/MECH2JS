// A mission on the port's own controls files: a disk with only the GIDDI
// drivers (no install INPUT.MAP / GAMEKEY.MAP / *.CPC), the first-run seed
// (shell/controls/seed.ts) writing INPUT.MAP and GAMEKEY.MAP, and MW2.EXE's
// input layer binding keys from them.
import { beforeAll, describe, expect, it } from 'vitest';
import { ExeImage } from '../../src/data/exe/ExeImage.ts';
import { ProjectFile } from '../../src/data/prj/ProjectFile.ts';
import { dosFiles, setDosFiles, setOverlayFiles, setOwnFiles } from '../../src/engine/dosFiles.ts';
import { bootMission } from '../../src/mission/load.ts';
import { mechs } from '../../src/sim/mech/mechGlobals.ts';
import { input, inputPollControls, inputSub048ca0 } from '../../src/sim/controls/input.ts';
import { KeyboardDriver, MouseDriver } from '../../src/sim/controls/giddi.ts';
import { inputGlobals } from '../../src/sim/controls/inputGlobals.ts';
import { seedControlFiles } from '../../src/shell/controls/seed.ts';
import { gameSource, hasGameData, hasShellData, installFiles } from '../support/env.ts';

describe.runIf(hasGameData && hasShellData)('a mission on the port-seeded INPUT.MAP and GAMEKEY.MAP', () => {
  let kb: KeyboardDriver;
  let seeded: Map<string, Uint8Array>;
  beforeAll(async () => {
    const src = gameSource();
    const exe = ExeImage.fromExe(await src.read('MW2.EXE'));
    const shellExe = ExeImage.fromExe(await src.read('MW2SHELL.EXE'));
    const prj = new ProjectFile(await src.read('MW2.PRJ'));
    // the disk before the port's first run: the test disk less the controls files, which the seed is to write
    const assets = installFiles();
    for (const k of [...assets.keys()]) if (/\.(MAP|CPC)$/.test(k)) assets.delete(k);
    setDosFiles(assets);
    setOwnFiles(new Map());
    setOverlayFiles(null);
    seedControlFiles(shellExe);
    seeded = new Map(dosFiles.own);
    bootMission({ exe, prj, looseFiles: new Map([...assets, ...seeded]), mission: 'AMY_SCN1' });
    kb = input.devices[input.keyboardDevice]!.driver as KeyboardDriver;
  });

  it('the seed wrote the maps; the sim opened the devices INPUT.MAP names', () => {
    expect([...seeded.keys()].sort()).toEqual(['GAMEKEY.MAP', 'GIDDI/CONFIG00.CPC', 'GIDDI/KEYBOARD.CPC', 'GIDDI/MOUSE.CPC', 'INPUT.MAP']);
    expect(input.devices.map((d) => d.name)).toEqual(['keyboard', 'mouse']);
    expect(input.devices[1]!.driver).toBeInstanceOf(MouseDriver);
  });

  it('Space fires, Enter cycles weapons', () => {
    const pc = mechs.playerControls;
    kb.isr(0x39);
    inputPollControls();
    expect(pc.weapon_fire).toBe(1);
    kb.isr(0xb9);
    inputPollControls();
    expect(pc.weapon_fire).toBe(0);
    kb.isr(0x1c);
    inputPollControls();
    expect(pc.weapon_cycle).toBe(1);
    kb.isr(0x9c);
    inputPollControls();
    expect(pc.weapon_cycle).toBe(0);
  });

  it('grey left turns the legs; with Ctrl (the default profile\'s modifier) it pans the eyepoint instead', () => {
    const pc = mechs.playerControls;
    kb.isr(0xe0);
    kb.isr(0x4b);
    inputPollControls();
    expect(pc.legs_pan_minus).toBe(1);
    expect(pc.pilot_pan_minus).toBe(0);
    kb.isr(0x1d); // left Ctrl down
    inputPollControls();
    expect(pc.legs_pan_minus).toBe(0);
    expect(pc.pilot_pan_minus).toBe(1);
    kb.isr(0x9d);
    kb.isr(0xe0);
    kb.isr(0xcb);
    inputPollControls();
    expect(pc.pilot_pan_minus).toBe(0);
    expect(pc.legs_pan_minus).toBe(0);
  });

  it('GAMEKEY.MAP\'s commands: Ctrl+Q exits, c is the cockpit view', () => {
    kb.isr(0x1d);
    kb.isr(0x10);
    kb.isr(0x90);
    kb.isr(0x9d);
    inputPollControls();
    expect(inputGlobals.controlKey).toBe(0x171);
    expect(inputSub048ca0(0x171)).toBe(0x50);
    kb.isr(0x2e);
    kb.isr(0xae);
    inputPollControls();
    expect(inputSub048ca0(inputGlobals.controlKey)).toBe(0x09);
  });
});
