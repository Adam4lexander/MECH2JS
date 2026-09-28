// A held key and a command key: main's loop takes one keystroke a pass out
// of KEYBOARD.DLL's ring, and the driver sets the slowest typematic rate
// (250 ms, then 2 a second) so a held steering key barely feeds that ring.
// Fed the browser's ~30 repeats a second instead - as the host used to - a
// held arrow backs the ring up at the default 20 passes a second, and a
// tapped ';' (FIRE_WEAPON_GROUP in GAMEKEY.MAP) arrives late or not at all.
import { beforeAll, describe, expect, it } from 'vitest';
import { ExeImage } from '../../src/data/exe/ExeImage.ts';
import { ProjectFile } from '../../src/data/prj/ProjectFile.ts';
import { dosFiles, setDosFiles, setOverlayFiles, setOwnFiles } from '../../src/engine/dosFiles.ts';
import { bootMission } from '../../src/mission/load.ts';
import { input, inputPollControls, inputSub048ca0 } from '../../src/sim/controls/input.ts';
import { KeyboardDriver, typematic } from '../../src/sim/controls/giddi.ts';
import { inputGlobals } from '../../src/sim/controls/inputGlobals.ts';
import { seedControlFiles } from '../../src/shell/controls/seed.ts';
import { gameSource, hasGameData, hasShellData, installFiles } from '../support/env.ts';

const LEFT = 0x4b;
const SEMICOLON = 0x27;
const PASS_MS = 50; // the default loop rate, 20 passes a second

describe.runIf(hasGameData && hasShellData)('keyboard typematic and the command ring', () => {
  let kb: KeyboardDriver;
  let fireGroup = 0;
  beforeAll(async () => {
    const src = gameSource();
    const exe = ExeImage.fromExe(await src.read('MW2.EXE'));
    const shellExe = ExeImage.fromExe(await src.read('MW2SHELL.EXE'));
    const prj = new ProjectFile(await src.read('MW2.PRJ'));
    const assets = installFiles();
    for (const k of [...assets.keys()]) if (/\.MAP$/.test(k)) assets.delete(k);
    setDosFiles(assets);
    setOwnFiles(new Map());
    setOverlayFiles(null);
    seedControlFiles(shellExe);
    bootMission({ exe, prj, looseFiles: new Map([...assets, ...dosFiles.own]), mission: 'AMY_SCN1' });
    kb = input.devices[input.keyboardDevice]!.driver as KeyboardDriver;
    // ';' alone: the command GAMEKEY.MAP gives it
    kb.isr(SEMICOLON);
    kb.isr(SEMICOLON | 0x80);
    inputPollControls();
    fireGroup = inputSub048ca0(inputGlobals.controlKey);
  });

  /** Holds Left from t 0 (repeating every `period` ms after `delay`), taps ';' at 3 s; the passes until ';' arrives, or -1. */
  function tapWhileHeld(delay: number, period: number): number {
    while (kb.readKey() !== 0) {
      /* an empty ring */
    }
    const events: [number, number][] = [[0, LEFT]];
    for (let t = delay; t < 6000; t += period) events.push([t, LEFT]);
    events.push([3000, SEMICOLON], [3080, SEMICOLON | 0x80], [6000, LEFT | 0x80]);
    events.sort((a, b) => a[0] - b[0]);
    let e = 0;
    let arrived = -1;
    for (let pass = 0, t = 0; t < 6000; pass++, t += PASS_MS) {
      while (e < events.length && events[e]![0] <= t) kb.isr(events[e++]![1]);
      inputPollControls();
      if (t >= 3000 && arrived < 0 && inputGlobals.controlKey !== 0 && inputSub048ca0(inputGlobals.controlKey) === fireGroup) arrived = pass - 3000 / PASS_MS;
    }
    return arrived;
  }

  it('KEYBOARD.DLL sets 250 ms, then 2 a second', () => {
    expect(fireGroup).not.toBe(0);
    expect(typematic.delayMs).toBe(250);
    expect(Math.round(1000 / typematic.periodMs)).toBe(2);
  });

  it('at the driver typematic rate a tapped ; arrives on the next pass; at the browser repeat rate it waits behind the held key', () => {
    const atTypematic = tapWhileHeld(typematic.delayMs, typematic.periodMs);
    expect(atTypematic).toBeGreaterThanOrEqual(0);
    expect(atTypematic).toBeLessThanOrEqual(1);
    const atBrowser = tapWhileHeld(500, 33);
    // 30 repeats a second against 20 passes: the ring is seconds behind (or the ; is lost)
    expect(atBrowser === -1 || atBrowser > 10).toBe(true);
  });
});
