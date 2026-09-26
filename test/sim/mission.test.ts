// Phase 6's exit check, "three campaign missions are playable to WIN/LOSE",
// through main's loop: objective evaluation decides the player's table,
// mission_results_update posts the exit prompt after 3 s and asks to quit
// after 20, the loop ends, and main's shutdown hands back the mw2msn.cfg
// record (never written) that the debriefing reads. AMY_SCN1 and BLONSCN1
// are won by destroying their enemy mechs (mech_on_destroyed, the kill the
// weapons end in - Phase 3's kill test covers the weapons themselves);
// IRENSCN1 is lost to its enemy star, left to play itself. Also the
// scheduled tasks mission scripts attach to objects, on the shipped data.
import { beforeAll, describe, expect, it } from 'vitest';
import { ExeImage } from '../../src/data/exe/ExeImage.ts';
import { ProjectFile } from '../../src/data/prj/ProjectFile.ts';
import { codeInfo } from '../../src/engine/codePtr.ts';
import { timerInterrupt } from '../../src/engine/timer.ts';
import { taskGlobals, type TaskList, type TaskNode } from '../../src/engine/tasks/taskList.ts';
import { missionEnd } from '../../src/mission/end.ts';
import { bootMission } from '../../src/mission/load.ts';
import { mainLoopFrame, mainLoopRunning } from '../../src/mission/mainLoop.ts';
import { objectives } from '../../src/mission/objectives.ts';
import { mechAllegiance } from '../../src/sim/groups/groups.ts';
import { mechOnDestroyed } from '../../src/sim/mech/damage.ts';
import { mechs } from '../../src/sim/mech/mechGlobals.ts';
import { ui } from '../../src/sim/ui/uiContext.ts';
import { recordTaskList, world } from '../../src/sim/world/worldRecords.ts';
import { gameSource, hasGameData, installFiles } from '../support/env.ts';

let exe: ExeImage;
let prj: ProjectFile;
let files: Map<string, Uint8Array>;

function frame(ticks = 7) {
  for (let i = 0; i < ticks; i++) timerInterrupt();
  mainLoopFrame();
}

/** Runs main's loop until it ends (or `max` frames), `each` called per frame. */
function play(max: number, each?: (f: number) => void): number {
  let f = 0;
  for (; f < max && mainLoopRunning(); f++) {
    frame();
    each?.(f);
  }
  return f;
}

function allTasks(): TaskNode[] {
  const out: TaskNode[] = [];
  const walk = (l: TaskList) => {
    for (let t = l.head; t; t = t.next) out.push(t);
  };
  walk(taskGlobals.missionTaskList);
  for (let r = 0; r < world.worldObjectCount; r++) walk(recordTaskList(world.worldRecords[r]!));
  return out;
}

describe.runIf(hasGameData)('mission runtime', () => {
  beforeAll(async () => {
    const src = gameSource();
    exe = ExeImage.fromExe(await src.read('MW2.EXE'));
    prj = new ProjectFile(await src.read('MW2.PRJ'));
    files = installFiles();
  });

  it('runs every kind of object task: spin, colour cycle, track and drive move their objects', () => {
    const effect = new Map<string, boolean>();
    for (const m of ['TNJ1SCN1', 'BRONSCN1']) {
      bootMission({ exe, prj, looseFiles: files, mission: m });
      frame();
      const tasks = allTasks();
      const before = tasks.map((t) => {
        const d = t.data as { slot?: { get(): unknown }; objectSlot?: { get(): unknown }; node?: unknown } | null;
        const obj = (d?.slot ?? d?.objectSlot)?.get() as { node: { localBlock: Int32Array } | null; currentMesh: { polygons: { code: number }[] } | null } | undefined;
        return {
          name: codeInfo(t.callback)?.name ?? '',
          obj,
          block: obj?.node ? Int32Array.from(obj.node.localBlock) : null,
          codes: obj?.currentMesh ? obj.currentMesh.polygons.map((p) => p.code) : [],
        };
      });
      for (let f = 0; f < 200; f++) frame();
      for (const b of before) {
        if (!b.obj) continue;
        let changed = false;
        if (b.name === 'task_object_colour_cycle') changed = b.obj.currentMesh!.polygons.some((p, i) => p.code !== b.codes[i]);
        else if (b.block && b.obj.node) changed = b.obj.node.localBlock.some((v, i) => v !== b.block![i]);
        if (changed) effect.set(b.name, true);
      }
    }
    for (const k of ['task_object_rotate', 'task_object_colour_cycle', 'task_object_track', 'task_object_drive']) expect(effect.get(k), k).toBe(true);
  });

  it('AMY_SCN1: destroying both enemy stars wins; the loop ends and the record says so', () => {
    bootMission({ exe, prj, looseFiles: files, mission: 'AMY_SCN1' });
    const frames = play(3000, (f) => {
      if (f !== 200) return;
      for (let i = 0; i < mechs.mechCount; i++) if (mechAllegiance(i) === 1) mechOnDestroyed(mechs.mechTable[i]!.loadout!);
    });
    expect(mainLoopRunning()).toBe(false);
    expect(ui.exitPromptShown).toBe(1);
    expect(frames).toBeLessThan(3000);
    const T = objectives.objectiveTables[mechs.playerGroupIndex]!;
    // the exit timing: the quit request comes 20 s after the decision
    expect(Math.floor(((T.decidedAt + 20) * 0xb6) / 7)).toBeLessThanOrEqual(frames + 2);
    const r = missionEnd();
    expect(r.result).toBe(2);
    expect(String.fromCharCode(...r.record.slice(0, 4))).toBe('MW2M');
    const dv = new DataView(r.record.buffer);
    expect(dv.getInt32(4, true)).toBe(r.objectives.length);
    expect(dv.getUint32(0x10, true)).toBe(2);
    expect(r.objectives.map((o) => o.text)).toEqual(['Destroy First Mech Star', 'Destroy Second Mech Star']);
    expect(r.objectives.every((o) => o.succeeded === 1)).toBe(true);
  });

  it('BLONSCN1: destroying the enemy wins', () => {
    bootMission({ exe, prj, looseFiles: files, mission: 'BLONSCN1' });
    play(3000, (f) => {
      if (f !== 200) return;
      for (let i = 0; i < mechs.mechCount; i++) if (mechAllegiance(i) === 1) mechOnDestroyed(mechs.mechTable[i]!.loadout!);
    });
    expect(mainLoopRunning()).toBe(false);
    expect(missionEnd().result).toBe(2);
  });

  it('IRENSCN1: left to itself, the player is killed by the enemy star and the mission is lost', () => {
    bootMission({ exe, prj, looseFiles: files, mission: 'IRENSCN1' });
    play(6000);
    expect(mainLoopRunning()).toBe(false);
    const player = mechs.mechTable[mechs.playerMechIndex]!;
    expect(player.flags & 4).toBe(4);
    const r = missionEnd();
    expect(r.result).toBe(3);
    expect(r.objectives.some((o) => o.succeeded === 0)).toBe(true);
  });
});
