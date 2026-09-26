/**
 * MTBL (keyword mission_table, tag 12): one group's objective table.
 * mission_table_load copies the whole chunk into missionTables[group] (the
 * static table, header and all - MissionTableChunk in mw2_types.h) and
 * objective_table_install converts its records into the runtime objectives.
 * Field names are MissionTableChunk's and MissionObjectiveRecord's; each note
 * there cites the consumer that fixes the meaning.
 *
 *   +0x08  int      group: the missionTables slot and the group (star) index
 *   +0x0c  int      timeLimit: the MISSION time limit in seconds
 *                   (ObjectiveTable.timeLimit; 0 or less means none)
 *   +0x10  2 bytes  not read
 *   +0x12  char[11] successSound  \ SNDTABLE names, resolved with
 *   +0x1d  char[9]  failureSound  / resource_id_by_name(0xb) and copied
 *   +0x26  records of 0x97 bytes, (size - 0x26) / 0x97 of them
 *
 * RECORD COUNTS DISAGREE in the original: objective_table_install takes
 * (size - 0x26) / 0x97 records and stores that as ObjectiveTable.count;
 * mission_table_load stores (size - 8) / 0x97 in configTableCounts. The
 * decoder returns the installer's records.
 *
 * Every string is copied by the installer with an unbounded strcpy-style
 * loop, and targetStreamName is compared with stricmp in place. The decoder
 * bounds each at its field size; the golden test checks that every string in
 * MW2.PRJ ends inside its field, where the two readings agree.
 */
import type { Chunk } from '../stream.ts';

export const MTBL_RECORDS_AT = 0x26;
export const MTBL_RECORD_SIZE = 0x97;

/** One prerequisite, MissionObjectiveRecord.prereqs[k * 4 .. k * 4 + 2]; the fourth byte is not read. */
export interface ObjectivePrerequisite {
  /** 'C' completed (-> 1), 'S' succeeded (-> 2), 'F' failed (-> 3), anything else -> 0 */
  condition: number;
  /** the objective's record index */
  record: number;
  /** the objective's table index */
  table: number;
}

export interface MissionObjectiveRecord {
  /** +0x00 the objective type bit; record 0 must be 0x10 (start) or the installer raises system_error 0x4a */
  type: number;
  /** +0x04 'V' (0x56): shown on the objectives screen */
  listed: number;
  /** +0x06 non-zero: every prerequisite must hold; zero: any */
  prereqAll: number;
  /** +0x0a eight prerequisites, 4 bytes each */
  prereqs: ObjectivePrerequisite[];
  /** +0x2a seconds of missionSeconds, -1 for none */
  timeLimit: number;
  /** +0x2e the category byte the objectives screen filters on */
  category: number;
  /** +0x2f 'M' (0x4d): a type-0x20 objective waits for this one (Objective.isPrerequisite) */
  isPrerequisite: number;
  /** +0x30 Objective.membersPerTarget: members group_assign_objective_task sends per target, 0 = all */
  membersPerTarget: number;
  /** +0x31 Objective.restraint: 1 hold task (aiFlags 0x42), 2 do not engage (0x41) */
  restraint: number;
  /** +0x34 SNDTABLE name of the success announcement */
  successSound: string;
  /** +0x3f SNDTABLE name of the failure announcement */
  failureSound: string;
  /** +0x4a the stream whose placements become this objective's targets (mission_mark_by_name) */
  targetStreamName: string;
  /** +0x53 for action types, the table the action applies to */
  actionTable: number;
  /** +0x55 for action types, the objective in actionTable */
  actionObjective: number;
  /** +0x57 the objective's text */
  text: string;
}

export interface MtblChunk {
  /** +0x08 the missionTables slot, which is also the group index */
  group: number;
  /** +0x0c the mission time limit in seconds; 0 or less means none */
  timeLimit: number;
  /** +0x12 SNDTABLE name of the table's success announcement */
  successSound: string;
  /** +0x1d SNDTABLE name of the table's failure announcement */
  failureSound: string;
  /** (size - 0x26) / 0x97 records, as objective_table_install counts them */
  records: MissionObjectiveRecord[];
}

/**
 * Reads one MissionObjectiveRecord at chunk offset o.
 *
 * @portOnly the read half of objective_table_install's record loop
 */
export function decodeObjectiveRecord(c: Chunk, o: number): MissionObjectiveRecord {
  return {
    type: c.u32(o + 0x00),
    listed: c.u8(o + 0x04),
    prereqAll: c.u8(o + 0x06),
    prereqs: Array.from({ length: 8 }, (_, k) => ({
      condition: c.u8(o + 0x0a + k * 4),
      record: c.u8(o + 0x0b + k * 4),
      table: c.u8(o + 0x0c + k * 4),
    })),
    timeLimit: c.i32(o + 0x2a),
    category: c.u8(o + 0x2e),
    isPrerequisite: c.u8(o + 0x2f),
    membersPerTarget: c.u8(o + 0x30),
    restraint: c.u8(o + 0x31),
    successSound: c.str(o + 0x34, 11),
    failureSound: c.str(o + 0x3f, 11),
    targetStreamName: c.str(o + 0x4a, 9),
    actionTable: c.u16(o + 0x53),
    actionObjective: c.u16(o + 0x55),
    text: c.str(o + 0x57, 64),
  };
}

/**
 * Reads an MTBL chunk as mission_table_load and objective_table_install read
 * it. A chunk shorter than the header gives no records ((size - 0x26) is
 * unsigned in the original, so the installer would read a huge count; the
 * shipped data has none).
 *
 * @portOnly the read half of mission_table_load and objective_table_install
 */
export function decodeMtbl(c: Chunk): MtblChunk {
  const n = c.size >= MTBL_RECORDS_AT ? Math.floor((c.size - MTBL_RECORDS_AT) / MTBL_RECORD_SIZE) : 0;
  return {
    group: c.i32(0x08),
    timeLimit: c.i32(0x0c),
    successSound: c.str(0x12, 11),
    failureSound: c.str(0x1d, 9),
    records: Array.from({ length: n }, (_, i) => decodeObjectiveRecord(c, MTBL_RECORDS_AT + i * MTBL_RECORD_SIZE)),
  };
}
