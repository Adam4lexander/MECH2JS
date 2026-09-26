/**
 * The mission tables (MTBL, keyword mission_table): sixteen slots, one per
 * group, each holding a COPY OF THE WHOLE MTBL CHUNK - header and 0x97-byte
 * MissionObjectiveRecords (layout in src/data/bwd/payloads/mtbl.ts and
 * mw2_types.h MissionTableChunk). objective_table_install converts a table
 * into the runtime ObjectiveTable (src/mission/objectives.ts); the static
 * copy stays for the target marking below, which reads each record's
 * targetStreamName (+0x4a) in place.
 *
 * Target marking: project_chunk_exec calls mission_mark_by_name with the
 * running stream's own name, which puts state 7 ("open for targets") on
 * every objective whose targetStreamName matches; the stream's GT, GP and
 * NAVP chunks then call mission_record_add_value to append the objects they
 * place to those objectives' target lists. mission_marks_scan_nop sits where
 * the marks would be cleared and does nothing, so the marks persist until
 * objective evaluation first writes the state.
 */
import { quirk, divergence } from '../../core/provenance.ts';
import { udiv, u16, u8 } from '../../core/int/cint.ts';
import { Chunk } from '../../data/bwd/stream.ts';
import { LABEL } from '../../generated/labels.gen.ts';
import { registerGlobals } from '../../engine/globals.ts';
import { bootImage, imageI32 } from '../../engine/image.ts';
import { objectiveTableInstall, objectives } from '../objectives.ts';
import { scenario } from './scenario.ts';

export const MISSION_TABLE_SLOTS = 16;
/** Records the marking loops visit per table, whatever the table's count. */
export const OBJECTIVES_PER_TABLE = 0x30;
/** MissionTableChunk.records and the record stride. */
export const MTBL_RECORDS = 0x26;
export const MTBL_RECORD = 0x97;
/** MissionObjectiveRecord.targetStreamName */
const TARGET_STREAM_NAME = 0x4a;

export const missionTables = registerGlobals(
  'missionTables',
  {
    /** 0x153858: MissionTableChunk *[16], each a copy of its MTBL chunk */
    missionTables: new Array<Chunk | null>(MISSION_TABLE_SLOTS).fill(null),
    /** 0x153898: (size - 8) / 0x97 per slot - NOT the installer's (size - 0x26) / 0x97; no reader found */
    configTableCounts: new Int32Array(MISSION_TABLE_SLOTS),
    /** 0xd4034: one past the highest slot installed; the marking loops and main's objective_table_start loop bound on it */
    missionTableCount: 0,
    /**
     * 0x93954: the string "$". project_chunk_exec's MTBL branch switches the
     * name it marks with to this after loading a table; no objective in
     * MW2.PRJ is named '$', so that marks nothing in the shipped data.
     */
    mtblMarkName: '$',
    /** 0x9eb70: a block mission_tables_free frees and nulls; no writer found - unestablished */
    dat_0009eb70: null as unknown,
  },
  () => {
    const m = missionTables;
    m.missionTables = new Array<Chunk | null>(MISSION_TABLE_SLOTS).fill(null);
    m.configTableCounts = new Int32Array(MISSION_TABLE_SLOTS);
    m.missionTableCount = imageI32(LABEL.missionTableCount, 0);
    m.mtblMarkName = bootImage()?.cstrAt(LABEL.mtblMarkName, 16) ?? '$';
    m.dat_0009eb70 = null;
  },
);

/** C stricmp == 0: ASCII letters folded, nothing else. @portOnly */
export function stricmpEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    let x = a.charCodeAt(i);
    let y = b.charCodeAt(i);
    if (x >= 0x41 && x <= 0x5a) x += 0x20;
    if (y >= 0x41 && y <= 0x5a) y += 0x20;
    if (x !== y) return false;
  }
  return true;
}

/**
 * Record r's targetStreamName, read in place and unbounded as stricmp reads
 * it. Records past the table's end read as '' - the original reads whatever
 * follows the copy in memory.
 *
 * @portOnly
 */
export function missionRecordTargetName(table: Chunk, r: number): string {
  const o = MTBL_RECORDS + r * MTBL_RECORD + TARGET_STREAM_NAME;
  if (o >= table.bytes.length) quirk('the marking loops read all 48 records, past the table copy', 'mission_mark_by_name');
  return table.str(o);
}

/**
 * MTBL: copies the chunk into the slot its +8 names (freeing what was
 * there), records (size - 8) / 0x97 in configTableCounts, and installs the
 * table's objectives. Returns 1 (the original's allocation can fail:
 * system_error 0x40 and 0).
 *
 * @mw2 mission_table_load 0x0004d880
 * @fidelity exact
 * @divergence a slot outside 0..15 is refused (the original writes outside the array); MW2.PRJ has none
 */
export function missionTableLoad(c: Chunk): number {
  const m = missionTables;
  const slot = c.i32(8);
  if (slot < 0 || slot >= MISSION_TABLE_SLOTS) {
    divergence(`MTBL slot ${slot} outside the 16 missionTables slots; not installed`, 'mission_table_load');
    return 0;
  }
  m.missionTables[slot] = null; // free
  m.configTableCounts[slot] = 0;
  // cache_alloc(size) and a rep movsd of the whole chunk
  const bytes = new Uint8Array(c.size >>> 0);
  bytes.set(c.bytes.subarray(0, Math.min(c.bytes.length, bytes.length)));
  const copy = new Chunk(bytes, c.tag, c.size, c.offset);
  m.missionTables[slot] = copy;
  m.configTableCounts[slot] = udiv((copy.i32(4) - 8) >>> 0, MTBL_RECORD);
  objectiveTableInstall(copy);
  return 1;
}

/**
 * Puts state 7 (open for targets) on every objective, in every live table,
 * whose state is 0, 1 or 7 and whose targetStreamName equals `name` ignoring
 * case. Returns where they were: bit (record & 31), and bit 16 + table. An
 * empty name marks nothing and returns 0.
 *
 * @mw2 mission_mark_by_name 0x0004d550
 * @fidelity exact
 */
export function missionMarkByName(name: string): number {
  let mask = 0;
  if (name === '') return 0;
  const m = missionTables;
  for (let t = 0; t < m.missionTableCount; t++) {
    const table = m.missionTables[t];
    if (!table) continue;
    const objs = objectives.objectiveTables[t]!.objectives;
    for (let r = 0; r < OBJECTIVES_PER_TABLE; r++) {
      const o = objs[r]!;
      const st = o.state;
      if ((st === 0 || st === 1 || st === 7) && stricmpEq(name, missionRecordTargetName(table, r))) {
        mask = mask | (1 << (r & 0x1f)) | ((1 << (t & 0x1f)) << 0x10);
        o.state = 7;
      }
    }
  }
  return mask >>> 0;
}

/**
 * Appends `value` (a target: index in the low byte, kind in the high) to
 * every objective in state 7 whose targetStreamName equals `name` ignoring
 * case and whose type shares a bit with `mask`, while it has fewer than 16.
 *
 * @mw2 mission_record_add_value 0x0004d640
 * @fidelity exact
 */
export function missionRecordAddValue(name: string, mask: number, value: number): void {
  const m = missionTables;
  for (let t = 0; t < m.missionTableCount; t++) {
    const table = m.missionTables[t];
    if (!table) continue;
    const objs = objectives.objectiveTables[t]!.objectives;
    for (let r = 0; r < OBJECTIVES_PER_TABLE; r++) {
      const o = objs[r]!;
      if (o.state !== 7) continue;
      if (!stricmpEq(name, missionRecordTargetName(table, r))) continue;
      if (((o.type & mask) >>> 0) === 0) continue;
      const n = o.targetCount;
      if (n >= 0x10) continue;
      o.targetCount = u8(n + 1);
      const v = u16(value);
      const target = o.targets[n]!;
      target.index = v & 0xff;
      target.kind = v >>> 8;
      missionStubTrue();
    }
  }
}

/**
 * Returns 1; mission_record_add_value calls it and ignores the answer.
 *
 * @mw2 mission_stub_true 0x00017290
 * @fidelity exact
 */
export function missionStubTrue(): number {
  return 1;
}

/**
 * Compiled to nothing: for each live table and record it tests the mark
 * bits and compares the state with 7, then discards the comparison (read
 * from the disassembly, 0x4d720..0x4d79e). The state-7 marks are therefore
 * NOT cleared when a stream ends.
 *
 * @mw2 mission_marks_scan_nop 0x0004d720
 * @fidelity exact
 */
export function missionMarksScanNop(): void {}

/**
 * Frees the scenario table, all sixteen mission tables and the block at
 * 0x9eb70. Leaves every count (scenarioTableCount, configTableCounts,
 * missionTableCount) and the runtime objective tables as they are.
 *
 * @mw2 mission_tables_free 0x0004dd60
 * @fidelity exact
 */
export function missionTablesFree(): void {
  scenario.scenarioTable = null;
  const m = missionTables;
  for (let i = 0; i < MISSION_TABLE_SLOTS; i++) m.missionTables[i] = null;
  m.dat_0009eb70 = null;
}
