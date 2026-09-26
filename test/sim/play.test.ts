// Phase 2's exit checks, headless: main's loop on real missions, 182 Hz
// ticks fed a frame at a time and keys pressed as set-1 scancodes through
// KEYBOARD.DLL's own interrupt handler. Each check is against a number the
// original's data or code fixes, not against a recording of the port.
import { beforeAll, describe, expect, it } from 'vitest';
import { ExeImage } from '../../src/data/exe/ExeImage.ts';
import { ProjectFile } from '../../src/data/prj/ProjectFile.ts';
import { fixedAtan2 } from '../../src/core/angle/trig.ts';
import { bootMission } from '../../src/mission/load.ts';
import { mainLoopFrame } from '../../src/mission/mainLoop.ts';
import { mechs } from '../../src/sim/mech/mechGlobals.ts';
import { input } from '../../src/sim/controls/input.ts';
import { KeyboardDriver } from '../../src/sim/controls/giddi.ts';
import { ailTimerService } from '../../src/engine/miles/ail.ts';
import { clock } from '../../src/engine/clock.ts';
import { objectsOnList, worldRootNode } from '../../src/engine/scene/objectLists.ts';
import { sceneNodeSetEuler, sceneNodeSetOrigin, sceneNodeWalk } from '../../src/engine/scene/sceneGraph.ts';
import { objectBoxQuery, worldGroundHeightNear } from '../../src/sim/world/collision.ts';
import { gameSource, hasGameData, installFiles } from '../support/env.ts';

let exe: ExeImage;
let prj: ProjectFile;
let files: Map<string, Uint8Array>;
let kb: KeyboardDriver;

function boot(mission: string) {
  bootMission({ exe, prj, looseFiles: files, mission });
  kb = input.devices[input.keyboardDevice]!.driver as KeyboardDriver;
}

/** one pass of main's loop after `ticks` timer interrupts */
function frame(ticks = 7) {
  for (let i = 0; i < ticks; i++) ailTimerService();
  mainLoopFrame();
}

const player = () => mechs.mechTable[mechs.playerMechIndex]!;

/** frames until the player's mech is running (status 2) */
function powerUp(): void {
  for (let f = 0; f < 400 && player().loadout!.status !== 2; f++) frame();
}

describe.runIf(hasGameData)('play', () => {
  beforeAll(async () => {
    const src = gameSource();
    exe = ExeImage.fromExe(await src.read('MW2.EXE'));
    prj = new ProjectFile(await src.read('MW2.PRJ'));
    files = installFiles();
  });

  it('the power-up takes 6 to 8 seconds (0x444 + random_range(0x16c) ticks)', () => {
    boot('AMY_SCN1');
    const l = player().loadout!;
    frame(); // status 0 -> 1 arms stateTimer
    expect(l.status).toBe(1);
    const due = l.stateTimer;
    expect(due - clock.simTick).toBeGreaterThanOrEqual(0x444 - 7);
    expect(due - clock.simTick).toBeLessThanOrEqual(0x444 + 0x16c);
    while (l.status === 1) frame();
    // it goes to 2 on the first frame whose simTick is past stateTimer
    expect(clock.simTick).toBeGreaterThan(due);
    expect(clock.simTick - 7).toBeLessThanOrEqual(due);
  });

  it('full throttle reaches the chassis top speed: 1024 * speed, i.e. move * 10.8 km/h', () => {
    boot('AMY_SCN1');
    powerUp();
    const e = player();
    const l = e.loadout!;
    kb.isr(0x0d); // hold '=' (throttle_plus) until the throttle axis is at its top
    for (let f = 0; f < 200; f++) frame();
    kb.isr(0x8d);
    for (let f = 0; f < 150; f++) frame();
    expect(mechs.playerControls.throttle).toBe(1024);
    // ramp_step closes gap * elapsed / duration, truncated, so it settles short
    // of its target once that rounds to 0: within duration / elapsed of it
    const stall = (r: { duration: number }) => Math.ceil(r.duration / 7);
    const r4 = l.ramps[4]!;
    expect(r4.target).toBe(0x400 + ((Math.imul(1024, l.throttleScale) + 0x8000) >> 16));
    expect(r4.target - r4.current).toBeGreaterThanOrEqual(0);
    expect(r4.target - r4.current).toBeLessThan(stall(r4));
    expect(l.ramps[2]!.target).toBe((r4.current - 0x400) * l.speed);
    // speed is move * 0x697e98 >> 16 (mech_load_config); 10002 units are 1 km/h
    const kmh = l.ramps[2]!.current / 10002;
    const move = Math.round(l.speed / (0x697e98 / 65536));
    expect(Math.abs(kmh - move * 10.8)).toBeLessThan(0.5);
    expect(e.animState).toBe(1); // the walk
  });

  it('torso twist stops at torsoPanLimit and the control is clamped to it', () => {
    boot('AMY_SCN1');
    powerUp();
    const l = player().loadout!;
    kb.isr(0x34); // hold '.' (torso_pan_plus)
    for (let f = 0; f < 300; f++) frame();
    kb.isr(0xb4);
    frame();
    expect(l.torsoPanLimit).toBeGreaterThan(0);
    expect(l.ramps[0]!.target).toBe(l.torsoPanLimit);
    expect(mechs.playerControls.torso_pan).toBe(l.torsoPanLimit);
    for (let f = 0; f < 100; f++) frame();
    const r0 = l.ramps[0]!;
    expect(l.torsoPanLimit - r0.current).toBeGreaterThanOrEqual(0);
    expect(l.torsoPanLimit - r0.current).toBeLessThan(Math.ceil(r0.duration / 7));
  });

  it('a building stops the mech', () => {
    boot('AMY_SCN1');
    powerUp();
    const e = player();
    const l = e.loadout!;
    // a box (class 0) on the world chain that fills the height a mech walks at
    let target = null as null | { box: ReturnType<typeof objectsOnList> extends Iterable<infer T> ? T : never; x: number; y: number; z: number };
    for (const o of objectsOnList(worldRootNode)) {
      if (o.objectClass !== 0 || (o.flags & 0x800) !== 0) continue;
      const x = o.posX + 4000;
      const z = o.posZ;
      const g = worldGroundHeightNear(x, 0x7fff0000, z);
      const y = g + l.rideHeight;
      if (objectBoxQuery(o, o.posX, y, o.posZ).inside === 0) continue;
      if (objectBoxQuery(o, x, y, z).over !== 0) continue;
      target = { box: o, x, y, z };
      break;
    }
    expect(target).not.toBeNull();
    const t = target!;
    e.posX = t.x;
    e.posY = t.y;
    e.posZ = t.z;
    e.heading = fixedAtan2(t.box.posX - t.x, t.box.posZ - t.z);
    sceneNodeSetOrigin(e.node!, e.posX, e.posY, e.posZ);
    sceneNodeSetEuler(e.node!, e.pitch, e.heading, e.roll, 0);
    sceneNodeWalk(e.node!);
    kb.isr(0x0b); // THROTTLE_FULL
    kb.isr(0x8b);
    let blocked = 0;
    for (let f = 0; f < 400; f++) {
      frame();
      if (l.blockedSteps > 0) blocked++;
      expect(objectBoxQuery(t.box, e.posX, e.posY, e.posZ).inside).toBe(0);
    }
    expect(blocked).toBeGreaterThan(0);
  });

  it('the same input and ticks replay to the same state', () => {
    const run = () => {
      boot('AMY_SCN1');
      const script: Record<number, number[]> = { 230: [0x0b, 0x8b], 260: [0xe0, 0x4b], 330: [0xe0, 0xcb], 400: [0x34], 450: [0xb4] };
      for (let f = 0; f < 600; f++) {
        for (const b of script[f] ?? []) kb.isr(b);
        frame(5 + (f % 4));
      }
      const e = player();
      const l = e.loadout!;
      return JSON.stringify([clock.simTick, e.posX, e.posY, e.posZ, e.heading, l.velocityX, l.velocityZ, l.ramps.map((r) => [r.current, r.target]), e.animState, l.heatLevel, mechs.mechTable.slice(0, mechs.mechCount).map((m) => [m!.posX, m!.posZ, m!.loadout?.status])]);
    };
    const a = run();
    const b = run();
    expect(b).toBe(a);
    // and it moved
    expect(JSON.parse(a)[4]).not.toBe(-2949120);
  });
});
