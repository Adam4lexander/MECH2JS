// The AI's building blocks against the disassembly's cases, with no game
// data: the x87 truncation ai_choose_throttle depends on, the steering and
// torso arithmetic, object_test_flags' objective-type codes, the designator
// walk, the rule list rebuild, and objective_evaluate's outcome rules
// (listing/objectives.txt's types) on hand-built tables.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ControlState, MechEntity, MechGroup, MechLoadout, ObjectiveTable } from '../../src/generated/classes.gen.ts';
import { x87MulTrunc } from '../../src/core/int/x87.ts';
import { clock } from '../../src/engine/clock.ts';
import { missionClock } from '../../src/mission/missionClock.ts';
import { objectives } from '../../src/mission/objectives.ts';
import { objectiveEvaluate, objectiveIsActive } from '../../src/mission/results.ts';
import { missionTables } from '../../src/mission/tables/missionTables.ts';
import { objectEngageRange, objectTestFlags, resolveTargetDesignator } from '../../src/sim/ai/handles.ts';
import { aiRuleBlockFromBytes, aiRulesRebuild, mechHasRulesForState } from '../../src/sim/ai/rules.ts';
import { aiBiasClamped, aiChooseThrottle, aiSteerHeading } from '../../src/sim/ai/states.ts';
import { trackedGlobals } from '../../src/sim/ai/tracked.ts';
import { mechs } from '../../src/sim/mech/mechGlobals.ts';
import { things } from '../../src/sim/things/gameThings.ts';

function mech(index: number, group = 0): MechEntity {
  const e = new MechEntity();
  e.index = index;
  e.groupId = group;
  e.control = new ControlState();
  e.loadout = new MechLoadout();
  e.loadout.entity = e;
  e.ruleSet = new Array(6).fill(null);
  return e;
}

/** An AIT payload: states [(aiState, [[condition, operand1], ...])]. */
function ait(states: [number, [number, number][]][]): Uint8Array {
  const n = states.length;
  const rules = states.flatMap(([, r]) => r);
  const b = new Uint8Array(2 + 4 * n + 12 * rules.length);
  const dv = new DataView(b.buffer);
  dv.setInt16(0, n, true);
  states.forEach(([st, r], i) => {
    dv.setInt16(2 + 4 * i, st, true);
    dv.setInt16(4 + 4 * i, r.length, true);
  });
  rules.forEach(([cond, op1], k) => {
    const o = 2 + 4 * n + 12 * k;
    dv.setUint16(o, cond, true);
    dv.setInt16(o + 2, op1, true);
  });
  return b;
}

describe('x87 truncation', () => {
  it('keeps the extended product a double rounds up: |legsPan| 3 * 2/3 truncates to 1', () => {
    // the double 2/3 is a hair under 2/3, so 3 * it lies just below 2
    expect(Math.trunc(3 * (2 / 3))).toBe(2);
    expect(x87MulTrunc(3, 2 / 3)).toBe(1);
    // 0x3333333 is a multiple of 3 too: 35791394 exactly in a double, one less on the x87
    expect(x87MulTrunc(0x3333333, 2 / 3)).toBe(35791393);
    expect(x87MulTrunc(-7, 0.5)).toBe(-3);
    // out of int32: the integer indefinite
    expect(x87MulTrunc(0x7fffffff, 4.0)).toBe(-0x80000000);
  });
});

describe('steering and throttle', () => {
  it('ai_bias_clamped takes value\'s sign when asked and clamps to +/-0x400', () => {
    expect(aiBiasClamped(10, -4, 1)).toBe(14);
    expect(aiBiasClamped(-10, 4, 1)).toBe(-14);
    expect(aiBiasClamped(10, -4, 0)).toBe(6);
    expect(aiBiasClamped(0x3ff, 8, 0)).toBe(0x400);
    expect(aiBiasClamped(-0x3ff, -8, 0)).toBe(-0x400);
  });

  it('ai_steer_heading is proportional within 45 degrees and saturates beyond', () => {
    const e = mech(1);
    e.heading = 0;
    e.desiredHeading = 0x2e0000; // 46 degrees
    expect(aiSteerHeading(e)).toBe(0x2e0000);
    expect(e.control!.legsPan).toBe(0x3333333);
    e.desiredHeading = -0x2e0000;
    aiSteerHeading(e);
    expect(e.control!.legsPan).toBe(-0x3333333);
    e.desiredHeading = 0x2d0000; // 45 degrees: the full command, from the product
    aiSteerHeading(e);
    expect(e.control!.legsPan).toBe(0x3333333);
    // folded across the seam: 350 degrees is -10
    e.desiredHeading = 0x15e0000;
    expect(aiSteerHeading(e)).toBe(-0xa0000);
  });

  it('ai_choose_throttle picks by standoff, eases off in a hard turn, halves when hot', () => {
    const e = mech(1);
    e.targetDistance = 3001;
    expect(aiChooseThrottle(e, 1500)).toBe(0x400);
    e.targetDistance = 2000;
    expect(aiChooseThrottle(e, 1500)).toBe(0x333);
    e.targetDistance = 1000;
    expect(aiChooseThrottle(e, 1500)).toBe(0);
    // legsPan 0x3000000: (0x4000000 - trunc(0x3000000 * 2/3)) >> 16 = 0x200
    e.targetDistance = 3001;
    e.control!.legsPan = -0x3000000;
    expect(aiChooseThrottle(e, 1500)).toBe(0x200);
    e.loadout!.heatLevel = 0x420000;
    expect(aiChooseThrottle(e, 1500)).toBe(0x100);
  });
});

describe('handles', () => {
  const saved = { table: mechs.mechTable, count: mechs.mechCount, groups: mechs.groupTable, player: mechs.playerMechIndex };
  beforeEach(() => {
    mechs.mechTable = new Array(60).fill(null);
    mechs.groupTable = Array.from({ length: 16 }, () => new MechGroup());
    mechs.playerMechIndex = 0;
  });
  afterEach(() => {
    mechs.mechTable = saved.table;
    mechs.mechCount = saved.count;
    mechs.groupTable = saved.groups;
    mechs.playerMechIndex = saved.player;
  });

  it('object_test_flags reads objective-type codes: destroyed for 1/2/4/0x1000, identified for 8/0x100', () => {
    const m = mech(3);
    m.flags = 4;
    mechs.mechTable[3] = m;
    expect(objectTestFlags(0x203, 2, 0)).toBe(1);
    expect(objectTestFlags(0x203, 8, 0)).toBe(0);
    m.flags = 0x20;
    expect(objectTestFlags(0x203, 0x100, 0)).toBe(1);
    // a nav point is never destroyed
    trackedGlobals.trackedObjects[2]!.flags = 0xffff;
    expect(objectTestFlags(0x102, 1, 0)).toBe(0);
    trackedGlobals.trackedObjects[2]!.flags = 0;
    // other codes test ECX
    things.gameThings[5]!.flags = 0x40;
    expect(objectTestFlags(0x405, 0x2000, 0x40)).toBe(1);
    expect(objectTestFlags(0x405, 0x2000, 0x10)).toBe(0);
    things.gameThings[5]!.flags = 0;
    // unresolvable: a pass
    expect(objectTestFlags(0x305, 2, 0)).toBe(1);
    expect(objectTestFlags(0x1203, 2, 0)).toBe(1);
  });

  it('object_engage_range: a flat 10000 for mechs and gamethings, floored at 100', () => {
    trackedGlobals.trackedObjects[1]!.range = 40;
    expect(objectEngageRange(0x101)).toBe(100);
    expect(objectEngageRange(0x205)).toBe(10000);
    expect(objectEngageRange(0x405)).toBe(10000);
    expect(objectEngageRange(0x2201)).toBe(10000);
    trackedGlobals.trackedObjects[1]!.range = 0;
  });

  it('resolve_target_designator walks agp_enemy over other non-neutral sides and hands a literal back once', () => {
    mechs.mechCount = 4;
    for (let i = 0; i < 4; i++) mechs.mechTable[i] = mech(i, i);
    mechs.groupTable[0]!.allegiance = 0;
    mechs.groupTable[1]!.allegiance = 1;
    mechs.groupTable[2]!.allegiance = 2; // neutral: skipped
    mechs.groupTable[3]!.allegiance = 1;
    const me = mechs.mechTable[0]!;
    const got: number[] = [];
    for (let h = -1; ; ) {
      h = resolveTargetDesignator(me, 0x4201, h & 0xffff);
      if (h === -1) break;
      got.push(h);
    }
    expect(got).toEqual([0x201, 0x203]);
    expect(resolveTargetDesignator(me, 0x105, 0xffff)).toBe(0x105);
    expect(resolveTargetDesignator(me, 0x105, 0x105)).toBe(-1);
    // agp_me, stamped with the designator's type
    expect(resolveTargetDesignator(me, 0x2202, 0xffff)).toBe(0x200);
    expect(resolveTargetDesignator(me, 0x2202, 0x200)).toBe(-1);
  });
});

describe('the rule list', () => {
  it('ai_rules_rebuild takes block 2 then 0, a state\'s rules by the index, skipping repeats of (condition, operand1)', () => {
    const e = mech(1);
    e.aiState = 2;
    // block 0: state 0 has one rule, state 2 has two
    e.stateRules[0] = aiRuleBlockFromBytes(1, ait([[0, [[5, 0]]], [2, [[3, 0x40], [6, 0x40]]]]));
    // block 2: state 2's navpoint rule on @sec repeats block 0's and is dropped in block 0
    e.stateRules[2] = aiRuleBlockFromBytes(5, ait([[2, [[3, 0x40], [7, 0x4201]]]]));
    aiRulesRebuild(e);
    const list = e.ruleSet!.filter(Boolean).map((r) => [r!.condition, r!.operand1]);
    expect(list).toEqual([
      [3, 0x40],
      [7, 0x4201],
      [6, 0x40],
    ]);
    expect(e.ruleSet![3]).toBeNull();
    expect(mechHasRulesForState(e, 0)).toBe(1);
    expect(mechHasRulesForState(e, 4)).toBe(0);
    // a state no block has: an empty list
    e.aiState = 4;
    aiRulesRebuild(e);
    expect(e.ruleSet![0]).toBeNull();
  });
});

describe('objective evaluation', () => {
  const saved = { tables: objectives.objectiveTables, cur: objectives.groupCurrentObjective, count: missionTables.missionTableCount };
  beforeEach(() => {
    objectives.objectiveTables = Array.from({ length: 16 }, () => new ObjectiveTable());
    objectives.groupCurrentObjective = new Int32Array(16);
    missionTables.missionTableCount = 2;
    mechs.mechTable = new Array(60).fill(null);
    mechs.playerGroupIndex = 0;
    missionClock.missionSeconds = 0;
    clock.simTick = 0;
  });
  afterEach(() => {
    objectives.objectiveTables = saved.tables;
    objectives.groupCurrentObjective = saved.cur;
    missionTables.missionTableCount = saved.count;
  });

  /** An objective, live through prereqAll with no prerequisites ('all of none') unless given one. */
  function objective(table: number, i: number, type: number, targets: [number, number][] = [], timeLimit = -1) {
    const T = objectives.objectiveTables[table]!;
    T.count = Math.max(T.count, i + 1);
    const o = T.objectives[i]!;
    o.type = type;
    o.state = 3;
    o.startedAt = -1;
    o.timeLimit = timeLimit;
    o.prereqAll = 1;
    o.targetCount = targets.length;
    targets.forEach(([kind, index], k) => {
      o.targets[k]!.kind = kind;
      o.targets[k]!.index = index;
    });
    return o;
  }

  it('start (0x10) succeeds at once and opens what waits on it; a destroy succeeds when its mech is destroyed', () => {
    const start = objective(1, 0, 0x10);
    start.prereqAll = 0;
    const d = objective(1, 1, 2, [[2, 4]]);
    d.prereqAll = 0;
    d.prerequisites[0]!.condition = 1; // C(0, 1): objective 0 of table 1 complete
    d.prerequisites[0]!.table = 1;
    const m = mech(4, 1);
    mechs.mechTable[4] = m;
    expect(objectiveIsActive(1, 0)).toBe(1);
    expect(objectiveIsActive(1, 1)).toBe(0);
    objectiveEvaluate(1, 0);
    expect(start.state).toBe(5);
    expect(objectiveIsActive(1, 1)).toBe(1);
    objectiveEvaluate(1, 1);
    expect(d.state).toBe(3);
    m.flags = 4;
    objectiveEvaluate(1, 1);
    expect(d.state).toBe(5);
    // no targets at all: met on the first live evaluation
    const empty = objective(1, 2, 2);
    objectiveEvaluate(1, 2);
    expect(empty.state).toBe(5);
  });

  it("protect: another group's partial loss is 8 (not final), the player's 6; all gone is 6; surviving the limit is 5", () => {
    const a = mech(4, 1);
    const b = mech(5, 1);
    mechs.mechTable[4] = a;
    mechs.mechTable[5] = b;
    const theirs = objective(1, 0, 4, [[2, 4], [2, 5]]);
    const mine = objective(0, 0, 4, [[2, 4], [2, 5]]);
    const timed = objective(0, 1, 4, [[2, 5]], 10);
    objectiveEvaluate(1, 0);
    objectiveEvaluate(0, 1);
    expect(theirs.state).toBe(3);
    missionClock.missionSeconds = 11;
    objectiveEvaluate(0, 1);
    expect(timed.state).toBe(5);
    a.flags = 4;
    objectiveEvaluate(1, 0);
    objectiveEvaluate(0, 0);
    expect(theirs.state).toBe(8);
    expect(mine.state).toBe(6);
    b.flags = 4;
    objectiveEvaluate(1, 0);
    expect(theirs.state).toBe(6);
  });

  it('a timer (0x200) succeeds only when its limit runs out; force succeed acts on another objective', () => {
    const t = objective(0, 0, 0x200, [], 5);
    objectiveEvaluate(0, 0);
    expect(t.state).toBe(3);
    missionClock.missionSeconds = 6;
    objectiveEvaluate(0, 0);
    expect(t.state).toBe(5);
    const target = objective(1, 0, 2, [[2, 9]]);
    mechs.mechTable[9] = mech(9, 1);
    const force = objective(0, 2, 0x100000);
    force.actionTable = 1;
    force.actionObjective = 0;
    objectiveEvaluate(0, 2);
    expect(target.state).toBe(5);
    expect(force.state).toBe(5);
  });
});
