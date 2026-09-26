// Phase 5's exit check, "enemy stars engage on a sample mission", end to end
// through main's loop on AMY_SCN1: every AI mech is born shut down on its
// group's start objective; mission_results_update completes the start and
// moves group 1 on to 'destroy' (C(0,1) in listing/objectives.txt), whose
// rule block and follow order wake it; its rules (AIT DEFLT) take it from
// target (2) to attack (3) at 350 m, the behaviour scheduler drives it, and
// ai_pilot_update's fire decision takes the player's armour. Group 2's
// destroy waits on the player failing table 0's protect (F(3,0)), so it
// only follows its leader (its timer:follow objective). Also: the nine AIT tables, the start-of-mission state, a
// determinism check on the whole run, and every SCN1 mission's AI running
// without a fault.
import { beforeAll, describe, expect, it } from 'vitest';
import { ExeImage } from '../../src/data/exe/ExeImage.ts';
import { ProjectFile, readNameTable, TABL } from '../../src/data/prj/ProjectFile.ts';
import { ailTimerService } from '../../src/engine/miles/ail.ts';
import { bootMission } from '../../src/mission/load.ts';
import { mainLoopFrame } from '../../src/mission/mainLoop.ts';
import { objectives } from '../../src/mission/objectives.ts';
import { ai } from '../../src/sim/ai/aiGlobals.ts';
import { loadoutSections } from '../../src/sim/mech/loadout.ts';
import { mechs } from '../../src/sim/mech/mechGlobals.ts';
import { gameSource, hasGameData, installFiles } from '../support/env.ts';

let exe: ExeImage;
let prj: ProjectFile;
let files: Map<string, Uint8Array>;

function frame(ticks = 7) {
  for (let i = 0; i < ticks; i++) ailTimerService();
  mainLoopFrame();
}

function armour(i: number): number {
  return loadoutSections(mechs.mechTable[i]!.loadout!).reduce((s, x) => s + x.armorFront + x.armorRear + x.internal, 0);
}

/** positions, headings, AI state and targets of every mech, and the player's armour */
function snapshot(): string {
  const out: number[] = [];
  for (let i = 0; i < mechs.mechCount; i++) {
    const m = mechs.mechTable[i]!;
    out.push(m.posX, m.posY, m.posZ, m.heading, m.aiState, m.aiBehaviour, m.targetPrimary, m.targetSecondary, m.loadout!.heatLevel, m.control!.throttle);
  }
  out.push(armour(mechs.playerMechIndex));
  return out.join(',');
}

describe.runIf(hasGameData)('AI', () => {
  beforeAll(async () => {
    const src = gameSource();
    exe = ExeImage.fromExe(await src.read('MW2.EXE'));
    prj = new ProjectFile(await src.read('MW2.PRJ'));
    files = installFiles();
  });

  it('loads the nine AIT rule tables and starts every AI mech shut down on its start objective', () => {
    bootMission({ exe, prj, looseFiles: files, mission: 'AMY_SCN1' });
    expect(ai.aiRuleTables[0]).toBeNull();
    for (let id = 1; id <= 9; id++) expect(ai.aiRuleTables[id]!.resourceId).toBe(id);
    // DEFLT: nine states, as listing/ai_rules.txt prints them
    expect(ai.aiRuleTables[1]!.index.map((e) => e.aiState)).toEqual([4, 5, 8, 0, 2, 3, 7, 10, 11]);
    for (let i = 0; i < mechs.mechCount; i++) {
      const m = mechs.mechTable[i]!;
      if (m.controlSource !== 2) continue;
      expect(m.aiState).toBe(11);
      expect(m.flags & 0x10).toBe(0x10);
      // shutdown's one rule: ai_rule_cond_never
      expect(m.ruleSet!.filter(Boolean).map((r) => r!.condition)).toEqual([5]);
    }
  });

  it('an enemy star wakes, closes on the player, attacks and hits', () => {
    bootMission({ exe, prj, looseFiles: files, mission: 'AMY_SCN1' });
    const player = mechs.playerMechIndex;
    const star1 = [1, 2];
    const star2 = [3, 4];
    const start = armour(player);
    const startDist = star1.map((i) => Math.hypot(mechs.mechTable[i]!.posX - mechs.mechTable[player]!.posX, mechs.mechTable[i]!.posZ - mechs.mechTable[player]!.posZ));
    const seen = new Set<string>();
    const objectivesSeen = [new Set<number>(), new Set<number>()];
    let fired = 0;
    const closest = [...startDist];
    const dist = (i: number) => Math.hypot(mechs.mechTable[i]!.posX - mechs.mechTable[player]!.posX, mechs.mechTable[i]!.posZ - mechs.mechTable[player]!.posZ);
    for (let f = 0; f < 2500; f++) {
      frame();
      star1.forEach((i, k) => (closest[k] = Math.min(closest[k]!, dist(i))));
      objectivesSeen[0]!.add(objectives.groupCurrentObjective[1]!);
      objectivesSeen[1]!.add(objectives.groupCurrentObjective[2]!);
      for (const i of star1) {
        const m = mechs.mechTable[i]!;
        seen.add(`${m.aiState}`);
        if (m.aiBehaviour !== 0xff) seen.add(`b${m.aiBehaviour}`);
        if (m.control!.weapon_fire !== 0) fired++;
      }
    }
    // group 1 went on to 'destroy'; group 2 to its timer:follow (2), its destroy (1) waiting on table 0's protect
    expect(objectivesSeen[0]!.has(1)).toBe(true);
    expect(objectivesSeen[1]!.has(2)).toBe(true);
    expect(objectivesSeen[1]!.has(1)).toBe(false);
    for (const i of star1) expect(mechs.mechTable[i]!.loadout!.status).toBe(2);
    expect(seen.has('2')).toBe(true);
    expect(seen.has('3')).toBe(true);
    expect([...seen].some((s) => s.startsWith('b'))).toBe(true);
    expect(fired).toBeGreaterThan(0);
    // each closes to within a quarter of where it started
    for (let k = 0; k < star1.length; k++) expect(closest[k]!).toBeLessThan(startDist[k]! / 4);
    expect(armour(player)).toBeLessThan(start);
    // and the star's 'destroy' of the player's lance is decided once the player is down
    if ((mechs.mechTable[player]!.flags & 4) !== 0) expect(objectives.objectiveTables[1]!.objectives[1]!.state).toBe(5);
    for (const i of star2) expect([0, 5]).toContain(mechs.mechTable[i]!.aiState);
  });

  it('two runs of the same mission are identical, frame for frame', () => {
    const run = () => {
      bootMission({ exe, prj, looseFiles: files, mission: 'AMY_SCN1' });
      const trace: string[] = [];
      for (let f = 0; f < 900; f++) {
        frame();
        if (f % 50 === 49) trace.push(snapshot());
      }
      return trace;
    };
    const a = run();
    const b = run();
    expect(b).toEqual(a);
  });

  it("every SCN1 mission's AI runs without a fault", () => {
    const missions = readNameTable(prj, TABL.BWD)
      .map((e) => e.name.toUpperCase())
      .filter((n) => /SCN1$/.test(n));
    expect(missions.length).toBe(59);
    for (const m of missions) {
      bootMission({ exe, prj, looseFiles: files, mission: m });
      for (let f = 0; f < 150; f++) frame();
    }
  });
});
