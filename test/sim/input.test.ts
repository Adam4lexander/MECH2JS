// The input layer against the shipped INPUT.MAP, GAMEKEY.MAP and GIDDI
// drivers: keys pressed as scancodes through the keyboard driver's own
// interrupt handler, read back as playerControls.
import { beforeAll, describe, expect, it } from 'vitest';
import { ExeImage } from '../../src/data/exe/ExeImage.ts';
import { ProjectFile } from '../../src/data/prj/ProjectFile.ts';
import { bootMission } from '../../src/mission/load.ts';
import { mechs } from '../../src/sim/mech/mechGlobals.ts';
import { input, inputPollControls, inputSub048ca0 } from '../../src/sim/controls/input.ts';
import { KeyboardDriver } from '../../src/sim/controls/giddi.ts';
import { inputGlobals } from '../../src/sim/controls/inputGlobals.ts';
import { clock } from '../../src/engine/clock.ts';
import { gameSource, hasGameData, installFiles } from '../support/env.ts';

describe.runIf(hasGameData)('input', () => {
  let kb: KeyboardDriver;
  beforeAll(async () => {
    const src = gameSource();
    const exe = ExeImage.fromExe(await src.read('MW2.EXE'));
    const prj = new ProjectFile(await src.read('MW2.PRJ'));
    bootMission({ exe, prj, looseFiles: installFiles(), mission: 'AMY_SCN1' });
    kb = input.devices[input.keyboardDevice]!.driver as KeyboardDriver;
  });

  it('opens the devices INPUT.MAP names, keyboard first', () => {
    expect(input.devices.map((d) => d.name)).toEqual(['keyboard', 'mouse']);
    const rec = input.devices[0]!.record;
    expect(rec.buttonCount).toBe(0x79);
    expect(rec.buttonNames![0x0c]).toBe('Equal');
    expect(rec.buttonNames![0x60]).toBe('GreyLeftArrow');
    expect(rec.buttonNames![0x76]).toBe('Shift');
    expect(input.devices[1]!.record.analogNames).toEqual(['Up/Down', 'Left/Right']);
    expect(input.devices[1]!.record.buttonNames).toEqual(['LeftBtn', 'MiddleBtn', 'RightBtn']);
  });

  it('a held key sets its button channel for as long as it is down', () => {
    const pc = mechs.playerControls;
    kb.isr(0x39); // Space: weapon_fire
    inputPollControls();
    expect(pc.weapon_fire).toBe(1);
    inputPollControls();
    expect(pc.weapon_fire).toBe(1);
    kb.isr(0xb9);
    inputPollControls();
    expect(pc.weapon_fire).toBe(0);
  });

  it('grey arrows arrive through the E0 table and respect the Alt chord', () => {
    const pc = mechs.playerControls;
    kb.isr(0xe0);
    kb.isr(0x4b); // grey left: legs_pan_minus without Alt
    inputPollControls();
    expect(pc.legs_pan_minus).toBe(1);
    expect(pc.pilot_pan_minus).toBe(0);
    kb.isr(0x38); // left Alt down: now pilot_pan_minus, not legs
    inputPollControls();
    expect(pc.legs_pan_minus).toBe(0);
    expect(pc.pilot_pan_minus).toBe(1);
    kb.isr(0xb8);
    kb.isr(0xe0);
    kb.isr(0xcb);
    inputPollControls();
    expect(pc.pilot_pan_minus).toBe(0);
  });

  it('throttle_plus ramps the throttle axis by 3 * tickDelta per frame, accelerating', () => {
    const pc = mechs.playerControls;
    const sink = input.sinks.find((s) => s.slot?.field === 'throttle')!;
    const start = pc.throttle;
    clock.tickDelta = 4;
    kb.isr(0x0d); // Equal: throttle_plus
    const seen: number[] = [];
    for (let i = 0; i < 4; i++) {
      inputPollControls();
      seen.push(sink.value);
    }
    kb.isr(0x8d);
    // the velocity grows by (3 * tickDelta) << accelShift a frame and the value by the velocity
    const step = 12 << sink.accelShift;
    // frame n adds n steps (the velocity after n frames)
    expect(seen.slice(1).map((v, i) => v - seen[i]!)).toEqual([2 * step, 3 * step, 4 * step]);
    expect(pc.throttle).toBeGreaterThan(start);
  });

  it('keystrokes queue as shift state << 8 | key code, and GAMEKEY.MAP maps them', () => {
    kb.isr(0x1d); // Ctrl down
    kb.isr(0x10); // q
    kb.isr(0x90);
    kb.isr(0x9d);
    inputPollControls();
    expect(inputGlobals.controlKey).toBe(0x171);
    expect(inputSub048ca0(0x171)).toBe(0x50); // EXIT_SIM
    inputPollControls();
    expect(inputGlobals.controlKey).toBe(0);
    kb.isr(0x2e); // c
    kb.isr(0xae);
    inputPollControls();
    expect(inputGlobals.controlKey).toBe(0x63);
    expect(inputSub048ca0(0x63)).toBe(0x09); // COCKPIT_VIEW
  });
});
