/**
 * The runtime objective tables: ObjectiveTable[16] at 0xa5750, one per group
 * (star), each holding up to 48 Objective records of 0xf7 bytes.
 * objective_table_install builds one from a mission table (MTBL copy,
 * src/mission/tables/missionTables.ts); objective_table_start runs once per
 * table before play and places the group at its start objective's target.
 *
 * Objective EVALUATION (objective_evaluate, mission_results_update and the
 * target tests) is Phase 6 and not ported here.
 */
import { divergence, quirk } from '../core/provenance.ts';
import { systemError } from '../core/systemError.ts';
import { udiv, u16, u8 } from '../core/int/cint.ts';
import type { Chunk } from '../data/bwd/stream.ts';
import { ObjectiveTable } from '../generated/classes.gen.ts';
import { registerGlobals } from '../engine/globals.ts';
import { idByName } from '../engine/resources/cache.ts';
import { trackedGlobals } from '../sim/ai/tracked.ts';
import { starPlaceFormation } from '../sim/groups/groups.ts';
import { mechs } from '../sim/mech/mechGlobals.ts';
import { missionClock, missionClockUpdate } from './missionClock.ts';
import { MTBL_RECORD, MTBL_RECORDS, missionTables } from './tables/missionTables.ts';

export const OBJECTIVE_TABLE_COUNT = 16;
export const OBJECTIVES_MAX = 48;

export const objectives = registerGlobals(
  'objectives',
  {
    /** 0xa5750: ObjectiveTable[16], one per group */
    objectiveTables: Array.from({ length: OBJECTIVE_TABLE_COUNT }, () => new ObjectiveTable()),
    /**
     * 0xd3ff0: per table (group), the objective the group is working on, or
     * -1. The installer zeroes it; mission_results_update recomputes it every
     * frame (Phase 6).
     */
    groupCurrentObjective: new Int32Array(OBJECTIVE_TABLE_COUNT),
  },
  () => {
    objectives.objectiveTables = Array.from({ length: OBJECTIVE_TABLE_COUNT }, () => new ObjectiveTable());
    objectives.groupCurrentObjective = new Int32Array(OBJECTIVE_TABLE_COUNT);
  },
);

/** The prerequisite letter as the installer maps it: 'C' 1, 'S' 2, 'F' 3, anything else 0. @portOnly */
function prereqCondition(b: number): number {
  // The compiled switch (0x4d400..): < 'F': 'C' -> 1 else 0; 'F' -> 3; above: 'S' -> 2 else 0
  if (b < 0x46) return b === 0x43 ? 1 : 0;
  if (b < 0x47) return 3;
  return b === 0x53 ? 2 : 0;
}

/**
 * strcpy out of a chunk: the bytes up to the NUL, however far that is.
 * The destination arrays are 16 (sound names) and 65 (text) bytes; a longer
 * source would run into the next field in the original.
 *
 * @portOnly
 */
function strcpyFrom(c: Chunk, o: number, destSize: number, what: string): string {
  const s = c.str(o, 4096);
  if (s.length >= destSize) divergence(`${what} longer than its ${destSize}-byte field; the original overruns into the next field`, 'objective_table_install');
  return s;
}

/**
 * Builds objectiveTables[group] from a mission table copy: the table's
 * affiliation (from groupTable), time limit, success and failure
 * announcements (resolved through SNDTABLE, TABL 0xb), and one Objective per
 * 0x97-byte record - (size - 0x26) / 0x97 of them. Record 0 must be type
 * 0x10, the start objective, or it is system_error 0x4a. Each objective
 * starts in state 0 with no targets; the first target slot is written 0x800
 * (index 0, kind 8) and is not live. Zeroes the group's current objective
 * and raises missionTableCount to cover the group.
 *
 * @mw2 objective_table_install 0x0004d0a0
 * @fidelity exact
 * @divergence a record index past the 48 Objective slots is not written (the original writes into the next table); MW2.PRJ has none
 */
export function objectiveTableInstall(chunk: Chunk): void {
  const n = udiv((chunk.i32(4) - MTBL_RECORDS) >>> 0, MTBL_RECORD);
  if ((chunk.u32(MTBL_RECORDS) >>> 0) !== 0x10) systemError(0x4a);
  const group = chunk.i32(8);
  const t = objectives.objectiveTables[group]!;
  t.affiliation = u8(mechs.groupTable[group]!.affiliation);
  t.timeLimit = chunk.i32(0xc);
  t.startTime = -1;
  t.decidedAt = -1;
  t.successSoundName = strcpyFrom(chunk, 0x12, 16, 'table success sound');
  t.successSound = idByName(0xb, t.successSoundName);
  t.failureSoundName = strcpyFrom(chunk, 0x1d, 16, 'table failure sound');
  t.failureSound = idByName(0xb, t.failureSoundName);
  // (int)count <= i ends the loop: a count over INT_MAX installs nothing
  for (let i = 0; i < (n | 0); i++) {
    if (i >= OBJECTIVES_MAX) {
      divergence(`MTBL table ${group} has ${n} records, past the 48 objective slots`, 'objective_table_install');
      break;
    }
    const r = MTBL_RECORDS + i * MTBL_RECORD;
    const o = t.objectives[i]!;
    o.category = chunk.u8(r + 0x2e);
    o.type = chunk.u32(r + 0x00);
    o.timeLimit = chunk.i32(r + 0x2a);
    o.startedAt = -1;
    o.changedAt = -1;
    o.actionTable = chunk.u16(r + 0x53);
    o.actionObjective = chunk.u16(r + 0x55);
    o.listed = chunk.u8(r + 0x04) === 0x56 ? 1 : 0; // 'V'
    o.isPrerequisite = chunk.u8(r + 0x2f) === 0x4d ? 1 : 0; // 'M'
    o.membersPerTarget = chunk.u8(r + 0x30);
    o.restraint = chunk.u8(r + 0x31);
    o.successSoundName = strcpyFrom(chunk, r + 0x34, 16, 'objective success sound');
    o.successSound = idByName(0xb, o.successSoundName);
    o.failureSoundName = strcpyFrom(chunk, r + 0x3f, 16, 'objective failure sound');
    o.failureSound = idByName(0xb, o.failureSoundName);
    o.text = strcpyFrom(chunk, r + 0x57, 65, 'objective text');
    o.prereqAll = chunk.u8(r + 0x06);
    for (let k = 0; k < 8; k++) {
      const p = o.prerequisites[k]!;
      p.condition = prereqCondition(chunk.u8(r + 0x0a + k * 4));
      p.objective = chunk.u8(r + 0x0b + k * 4);
      p.table = chunk.u8(r + 0x0c + k * 4);
    }
    o.state = 0;
    o.targetCount = 0;
    const v = u16(0x800);
    o.targets[0]!.index = v & 0xff;
    o.targets[0]!.kind = v >>> 8;
  }
  objectives.groupCurrentObjective[group] = 0;
  t.count = n | 0;
  const m = missionTables;
  if (m.missionTableCount < group + 1) m.missionTableCount = (group + 1) | 0;
}

/**
 * The star_place_formation objective_table_start calls, held in an object
 * so a test can observe the placement arguments. Defaults to the port.
 *
 * @portOnly
 */
export const objectiveStartLinks = {
  starPlaceFormation: (group: number, x: number, y: number, z: number, heading: number): number => starPlaceFormation(group, x, y, z, heading),
};

/**
 * Starts table i (group i): sets missionSeconds from simTick; places the
 * group with star_place_formation at the first target of objective 0 (the
 * start objective) when that target is a tracked object (kind 1) below
 * trackedObjectCount - its x, y, z and heading - else at the origin with
 * heading 0; then stamps missionSeconds as the table's start time and
 * objective 0's startedAt. Returns 1 when the start target was used.
 *
 * @mw2 objective_table_start 0x00015f60
 * @fidelity partial
 * @divergence takes the table index alone (main passes objectiveTables + i * 0x2e8a and i)
 */
export function objectiveTableStart(i: number): number {
  const t = objectives.objectiveTables[i]!;
  let x = 0;
  let y = 0;
  let z = 0;
  let heading = 0;
  let found = 0;
  missionClockUpdate(); // the same missionSeconds = simTick / 0xb6, inlined in the original
  const o0 = t.objectives[0]!;
  const target = o0.targets[0]!;
  if (o0.targetCount !== 0 && target.kind === 1 && target.index < trackedGlobals.trackedObjectCount) {
    const tr = trackedGlobals.trackedObjects[target.index]!;
    x = tr.x;
    y = tr.y;
    z = tr.z;
    heading = tr.heading;
    found = 1;
  }
  objectiveStartLinks.starPlaceFormation(i, x, y, z, heading);
  t.startTime = missionClock.missionSeconds;
  o0.startedAt = missionClock.missionSeconds;
  return found;
}

/** An objective target as the ushort handle the C reads at record +0xd7: kind << 8 | index. @portOnly */
export function objectiveTargetHandle(group: number, objective: number, target: number): number {
  const t = objectives.objectiveTables[group]!.objectives[objective]!.targets[target]!;
  return ((t.kind & 0xff) << 8) | (t.index & 0xff);
}

/** The original address of objectiveTables[group].objectives[objective] (0xa5750 + 0x3a + ...). @portOnly */
export function objectiveRecordAddress(group: number, objective: number): number {
  return (0xa5750 + Math.imul(group, 0x2e8a) + 0x3a + Math.imul(objective, 0xf7)) | 0;
}

/**
 * objectives[objective].restraint (+0x65) - including objective -1, which
 * group_apply_objective reads when a group has no current objective. That
 * dword lies 0x58 bytes before the table: in the previous group's table it is
 * text[10..13] of objective 47; before table 0 it is 0xa56f8, unlabelled and
 * zero in the image, and whether anything writes it at run time is not
 * established (read here as 0).
 *
 * @portOnly the flat-memory read behind objectives[-1]
 */
export function objectiveRestraint(group: number, objective: number): number {
  if (objective >= 0) return objectives.objectiveTables[group]!.objectives[objective]!.restraint;
  quirk('group_apply_objective reads objectives[-1].restraint when the group has no current objective', 'group_apply_objective');
  if (group === 0) return 0;
  const text = objectives.objectiveTables[group - 1]!.objectives[OBJECTIVES_MAX - 1]!.text;
  let v = 0;
  for (let k = 0; k < 4; k++) v |= (k + 10 < text.length ? text.charCodeAt(k + 10) & 0xff : 0) << (8 * k);
  return v | 0;
}

/**
 * Designator agp_home: the first target of the group's first objective of
 * type 0x20 (identify, required), else objective 0's first target - its
 * start nav point.
 *
 * @mw2 group_identify_target 0x000172a0
 * @fidelity exact
 */
export function groupIdentifyTarget(group: number): number {
  const t = objectives.objectiveTables[group]!;
  for (let i = 0; i < t.count; i++) if (t.objectives[i]!.type >>> 0 === 0x20) return objectiveTargetHandle(group, i, 0);
  return objectiveTargetHandle(group, 0, 0);
}
