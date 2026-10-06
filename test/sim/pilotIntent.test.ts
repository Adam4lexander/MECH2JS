// The VR controls' way into the sim (sim/controls/pilotIntent.ts), run on a
// real mission (AMY_SCN1) through main's loop: the throttle opens at its
// rate, holds, stops at zero on the way into reverse, and the keyboard's
// sink carries on from it; the legs turn the mech, the torso twists and
// holds; a queued command or channel runs once; a press ends a pause.
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ExeImage } from '../../src/data/exe/ExeImage.ts';
import { ProjectFile } from '../../src/data/prj/ProjectFile.ts';
import { ailTimerService } from '../../src/engine/miles/ail.ts';
import type { MechEntity } from '../../src/generated/classes.gen.ts';
import { bootMission } from '../../src/mission/load.ts';
import { mainLoopFrame, mainLoopStep } from '../../src/mission/mainLoop.ts';
import { hud } from '../../src/sim/cockpit/hud.ts';
import { IDLE_INTENT, pilot, pilotCommand, pilotPulse, pilotRelease, pilotThrottle, type PilotIntent } from '../../src/sim/controls/pilotIntent.ts';
import { mechs } from '../../src/sim/mech/mechGlobals.ts';
import { commandGlobals } from '../../src/sim/ui/commands.ts';
import { weaponGlobals } from '../../src/sim/weapons/weapons.ts';
import { CMD } from '../../src/render/cockpit/controls.ts';
import { gameSource, hasGameData, installFiles } from '../support/env.ts';

let exe: ExeImage;
let prj: ProjectFile;
let files: Map<string, Uint8Array>;

const DT = 7;
const player = (): MechEntity => mechs.mechTable[mechs.playerMechIndex]!;

function frame(n = 1): void {
  for (let f = 0; f < n; f++) {
    for (let i = 0; i < DT; i++) ailTimerService();
    mainLoopFrame();
  }
}

function boot(): void {
  bootMission({ exe, prj, looseFiles: files, mission: 'AMY_SCN1' });
  const l = player().loadout!;
  for (let f = 0; f < 400 && l.status !== 2; f++) frame();
  expect(l.status).toBe(2);
}

function want(i: Partial<PilotIntent>): void {
  pilot.active = true;
  pilot.intent = { ...IDLE_INTENT, ...i };
}

describe.runIf(hasGameData)('the pilot intent', () => {
  beforeAll(async () => {
    const src = gameSource();
    exe = ExeImage.fromExe(await src.read('MW2.EXE'));
    prj = new ProjectFile(await src.read('MW2.PRJ'));
    files = installFiles();
  });

  afterEach(() => pilotRelease());

  it('opens the throttle at its rate, and the mech speeds up and holds it when let go', () => {
    boot();
    const l = player().loadout!;
    want({ throttleRate: 0.5 });
    // 40 passes of 7 ticks: a second and a half, three quarters of the travel
    frame(40);
    const t = mechs.playerControls.throttle;
    expect(t).toBeGreaterThan(600);
    expect(t).toBeLessThan(900);
    want({});
    frame(30);
    expect(mechs.playerControls.throttle).toBe(t);
    expect(l.ramps[2]!.current).toBeGreaterThan(0);
  });

  it('keeps the throttle where it was left once the controllers let go: the keyboard sink took it', () => {
    boot();
    want({ throttleSet: 0.5 });
    frame(2);
    expect(mechs.playerControls.throttle).toBe(512);
    pilotRelease();
    frame(10);
    expect(mechs.playerControls.throttle).toBe(512);
  });

  it('stops at zero on the way back, and goes into reverse only from a fresh pull', () => {
    boot();
    want({ throttleSet: 0.1 });
    frame(2);
    want({ throttleRate: -1 });
    frame(20);
    expect(pilotThrottle()).toBe(0);
    expect(mechs.playerControls.reverseDirection).toBe(0);
    want({});
    frame();
    want({ throttleRate: -1 });
    frame(10);
    expect(mechs.playerControls.reverseDirection).toBe(1);
    expect(pilotThrottle()).toBeLessThan(0);
  });

  it('turns the legs in proportion', () => {
    boot();
    /** the turn over 10 passes once the turn rate's ramp has settled */
    const turn = (legs: number) => {
      want({ legs });
      frame(20);
      expect(mechs.playerControls.legs_pan_delta).toBe(Math.round(legs * 1024 * 0x10000));
      const h = player().heading;
      frame(10);
      return player().heading - h;
    };
    const full = turn(1);
    const half = turn(0.5);
    expect(Math.abs(full)).toBeGreaterThan(0);
    expect(Math.sign(half)).toBe(Math.sign(full));
    expect(Math.abs(half / full)).toBeCloseTo(0.5, 1);
  });

  it('twists the torso at its rate and holds it there', () => {
    boot();
    want({ torsoPanRate: 30 });
    frame(20);
    const pan = mechs.playerControls.torso_pan;
    expect(pan).toBeGreaterThan(5 * 0x10000);
    want({});
    frame(20);
    // held, to the sink's rounding (a few 65536ths of a degree)
    expect(Math.abs(mechs.playerControls.torso_pan - pan)).toBeLessThan(0x100);
  });

  it('holds the guns and the jets while asked', () => {
    boot();
    want({ fire: true, jets: true });
    frame();
    // read in the pass, cleared by the next poll: what the pass saw is what the mech's weapons latched
    expect(player().loadout!.flags & 1).toBe(1);
  });

  it('runs a queued command once', () => {
    boot();
    want({});
    const chain = weaponGlobals.chainFireMode;
    const shown = hud.hudEnabled;
    pilotCommand(CMD.TOGGLE_GROUP_FIRE);
    pilotCommand(CMD.TOGGLE_HUD);
    frame();
    expect(weaponGlobals.chainFireMode).toBe(chain === 0 ? 1 : 0);
    expect(hud.hudEnabled).toBe(shown === 0 ? 1 : 0);
    frame(3);
    expect(weaponGlobals.chainFireMode).toBe(chain === 0 ? 1 : 0);
    expect(hud.hudEnabled).toBe(shown === 0 ? 1 : 0);
  });

  it('holds a channel for one pass: cycle weapon', () => {
    boot();
    want({});
    const l = player().loadout!;
    const before = l.selectedWeapon;
    pilotPulse('weapon_cycle');
    frame();
    const after = l.selectedWeapon;
    expect(after).not.toBe(before);
    frame(3);
    expect(l.selectedWeapon).toBe(after);
  });

  it('takes reverse off with the lever at the stop', () => {
    boot();
    want({ throttleSet: -0.5 });
    frame(2);
    expect(mechs.playerControls.reverseDirection).toBe(1);
    want({ throttleSet: 0 });
    frame(2);
    expect(mechs.playerControls.reverseDirection).toBe(0);
    expect(mechs.playerControls.throttle).toBe(0);
  });

  it('pauses from the cockpit, and any press of the controls ends the pause, spent on it', () => {
    boot();
    want({});
    pilotCommand(CMD.PAUSE_GAME);
    mainLoopStep();
    expect(commandGlobals.keyPauseActive).toBe(1);
    mainLoopStep();
    expect(commandGlobals.keyPauseActive).toBe(1);
    const shown = hud.hudEnabled;
    pilotCommand(CMD.TOGGLE_HUD);
    mainLoopStep();
    expect(commandGlobals.keyPauseActive).toBe(0);
    mainLoopStep();
    expect(hud.hudEnabled).toBe(shown);
  });

  it('drops presses still waiting when the controllers let go', () => {
    boot();
    want({});
    const shown = hud.hudEnabled;
    pilotCommand(CMD.TOGGLE_HUD);
    pilotRelease();
    frame();
    expect(hud.hudEnabled).toBe(shown);
  });

  it('does nothing while inactive', () => {
    boot();
    pilot.intent = { ...IDLE_INTENT, throttleRate: 1 };
    pilot.active = false;
    frame(10);
    expect(mechs.playerControls.throttle).toBe(0);
  });
});
