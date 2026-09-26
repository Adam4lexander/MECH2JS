// anim_player_step on the shipped data: the player's mech in AMY_SCN1 is
// asked to walk (mech_anim_select_gait from a throttle ramp above 0x420) and
// its anim tasks are ticked one 182 Hz tick at a time through the mission
// task list, as main's loop runs them. A misread frame flag, channel or
// track binding shows up as a wrong cycle length, a translation that does
// not come back, or legs that never stop.
import { beforeAll, describe, expect, it } from 'vitest';
import { ExeImage } from '../../src/data/exe/ExeImage.ts';
import { ProjectFile, readNameTable, TABL } from '../../src/data/prj/ProjectFile.ts';
import { bootMission } from '../../src/mission/load.ts';
import { mechs } from '../../src/sim/mech/mechGlobals.ts';
import { recordTaskList, world, worldRecordsRunTasks } from '../../src/sim/world/worldRecords.ts';
import { animPlayer, animPlayerStep, animScaleByGait, mechAnimSelectGait } from '../../src/sim/mech/animTask.ts';
import type { AnimTrackLive } from '../../src/sim/mech/anim.ts';
import { clock } from '../../src/engine/clock.ts';
import { taskGlobals, taskListRun, type TaskNode } from '../../src/engine/tasks/taskList.ts';
import type { AnimTask } from '../../src/generated/classes.gen.ts';
import { gameSource, hasGameData, installFiles } from '../support/env.ts';

function animTasks(): AnimTask[] {
  const out: AnimTask[] = [];
  const scan = (h: TaskNode | null) => {
    for (let t = h; t; t = t.next) if (t.callback === animPlayerStep && t.data) out.push(t.data as AnimTask);
  };
  for (let i = 0; i < world.worldObjectCount; i++) scan(recordTaskList(world.worldRecords[i]!).head);
  scan(taskGlobals.missionTaskList.head);
  return out;
}

function tick(): void {
  clock.simTick++;
  mechAnimSelectGait(mechs.mechTable[mechs.playerMechIndex]!);
  worldRecordsRunTasks();
  taskListRun(taskGlobals.missionTaskList);
}

describe.runIf(hasGameData)('anim_player_step', () => {
  let exe: ExeImage;
  let prj: ProjectFile;
  let files: Map<string, Uint8Array>;
  beforeAll(async () => {
    const src = gameSource();
    exe = ExeImage.fromExe(await src.read('MW2.EXE'));
    prj = new ProjectFile(await src.read('MW2.PRJ'));
    files = installFiles();
  });

  it('anim_scale_by_gait: x1.5 in band 1, x0.75 in band 3', () => {
    expect([0, 1, 2, 3, 4].map((b) => animScaleByGait(b, 70))).toEqual([70, 105, 70, 53, 70]);
  });

  it('every anim task in every SCN1 mission binds a node and a track, one controlling task per gamepiece', () => {
    const bad: string[] = [];
    let total = 0;
    const missions = readNameTable(prj, TABL.BWD)
      .map((e) => e.name.toUpperCase())
      .filter((n) => /SCN1$/.test(n));
    for (const m of missions) {
      bootMission({ exe, prj, looseFiles: files, mission: m });
      if (animPlayer.animPlayerError !== 0) bad.push(`${m}: animPlayerError ${animPlayer.animPlayerError}`);
      const byEntity = new Map<unknown, number>();
      for (const t of animTasks()) {
        total++;
        if (!t.node || !t.track || !t.entity) bad.push(`${m}: task without node/track/entity`);
        byEntity.set(t.entity, (byEntity.get(t.entity) ?? 0) + (t.flags & 1));
      }
      for (const n of byEntity.values()) if (n !== 1) bad.push(`${m}: a gamepiece with ${n} controlling tasks`);
    }
    expect(bad.slice(0, 10)).toEqual([]);
    expect(total).toBeGreaterThan(100);
  });

  it('the player\'s mech walks a 6-frame cycle, its legs coming back each lap, and stops when the throttle drops', () => {
    bootMission({ exe, prj, looseFiles: files, mission: 'AMY_SCN1' });
    const pl = mechs.mechTable[mechs.playerMechIndex]!;
    const mine = animTasks().filter((t) => t.entity === pl);
    const ctl = mine.find((t) => t.flags & 1)!;
    expect(mine.length).toBe(10);
    const frames = (ctl.track as AnimTrackLive).frameTable;

    pl.loadout!.ramps[4]!.current = 0x480; // walk: gaitBand 1, frame time 1.5 x the task's
    const laps: { at: number; pose: Int32Array[] }[] = [];
    let prev = -9;
    let eventFrames = 0;
    for (let k = 0; k < 3000; k++) {
      tick();
      if (pl.motionFlags & 2) eventFrames++;
      if (ctl.frame === 4 && prev !== 4) laps.push({ at: clock.simTick, pose: mine.map((t) => Int32Array.from(t.node!.localBlock)) });
      prev = ctl.frame;
    }
    expect(pl.animState).toBe(0);
    expect(pl.animTarget).toBe(0);
    expect(pl.motionFlags & 1).toBe(1);
    expect(pl.animFrameTicks).toBe(animScaleByGait(1, ctl.baseFrameTicks));
    // the loop: back from the conditional-loop frame to the loop-start frame, every lap the same length
    const loopStart = frames.findIndex((f) => f.flags & 2);
    const loopEnd = frames.findIndex((f, i) => i > loopStart && f.flags & 0xc);
    const lap = (loopEnd - loopStart + 1) * pl.animFrameTicks;
    expect(laps.length).toBeGreaterThan(3);
    for (let i = 1; i < laps.length; i++) expect(laps[i]!.at - laps[i - 1]!.at).toBe(lap);
    // every track's values over a lap sum to zero, so the pose repeats: translations
    // exactly, rotations (composed into the 2.29 matrix a step at a time) to rounding
    for (const t of mine) {
      const v = (t.track as AnimTrackLive).values as Int32Array;
      let sum = 0;
      for (let f = loopStart; f <= loopEnd; f++) sum += v[f]!;
      expect(sum).toBe(0);
    }
    for (let i = 1; i < laps.length; i++) {
      for (let n = 0; n < mine.length; n++) {
        const a = laps[i - 1]!.pose[n]!;
        const b = laps[i]!.pose[n]!;
        expect([b[9], b[10], b[11]]).toEqual([a[9], a[10], a[11]]);
        for (let j = 0; j < 9; j++) expect(Math.abs(b[j]! - a[j]!)).toBeLessThan(1 << 20); // < 0.002 of unity
      }
    }
    // the rotating legs really move within a lap
    const moved = mine.some((t) => {
      const before = Int32Array.from(t.node!.localBlock);
      for (let k = 0; k < lap / 2; k++) tick();
      return before.some((v, j) => v !== t.node!.localBlock[j]);
    });
    expect(moved).toBe(true);
    expect(eventFrames).toBeGreaterThan(0);

    pl.loadout!.ramps[4]!.current = 0x400; // stop: no target
    for (let k = 0; k < 3000 && pl.motionFlags & 1; k++) tick();
    expect(pl.animTarget).toBe(-1);
    expect(pl.motionFlags & 1).toBe(0);
    expect(pl.animState).toBe(-1);
  });
});
