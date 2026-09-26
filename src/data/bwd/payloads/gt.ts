/**
 * GT (keyword gamething, tag 40): a destructible thing the mission places.
 * Read by project_chunk_exec's GT branch (0x4f1de..0x4f2e5; the decompiled C
 * loses the second id into a register, so tools/dump_gamethings.py took the
 * offsets from the disassembly):
 *
 *   +0x08  short   OBJECT id: project_mangle_id, then world_record_find or
 *                  world_record_alloc; that record becomes GameThing.geomIndex.
 *                  -1: none, and the linking below is skipped
 *   +0x0a  short   REPLACEMENT id, resolved the same way (only when +0x08 is
 *                  not -1); world_record_link_gamething(record, replacement,
 *                  thing) - the replacement starts hidden and shows once the
 *                  thing is destroyed
 *   +0x0c  12 bytes  not read
 *   +0x18  short   GameThing.hitPoints (sign-extended)
 *   +0x1a  ushort  objective mask, widened, then mission_record_add_value
 *                  with (thing index | 0x400)
 *   +0x1c  ushort  GameThing.flags
 *   +0x20  char[22] GameThing.name    (strncpy 0x16, last byte forced NUL)
 *   +0x36  char[22] GameThing.nameAlt (the same)
 *
 * GameThing.affiliation is not in the chunk: it is the dword of the last AFFL
 * chunk the interpreter ran (affl.ts), -1 at the start of each run.
 */
import type { Chunk } from '../stream.ts';

export interface GtChunk {
  /** +0x08 the OBJ this thing is (before project_mangle_id), -1 for none */
  objectId: number;
  /** +0x0a the OBJ shown once it is destroyed, -1 for none; not read when objectId is -1 */
  replacementId: number;
  /** +0x18 GameThing.hitPoints */
  hitPoints: number;
  /** +0x1a objective mask as stored (see widenObjectiveMask) */
  objectiveMask: number;
  /** +0x1c GameThing.flags */
  flags: number;
  /** +0x20 GameThing.name, at most 21 characters */
  name: string;
  /** +0x36 GameThing.nameAlt, at most 21 characters */
  nameAlt: string;
}

/**
 * Reads a GT chunk at the offsets project_chunk_exec reads it.
 *
 * @portOnly the read half of project_chunk_exec's GT branch
 */
export function decodeGt(c: Chunk): GtChunk {
  return {
    objectId: c.i16(0x08),
    replacementId: c.i16(0x0a),
    hitPoints: c.i16(0x18),
    objectiveMask: c.u16(0x1a),
    flags: c.u16(0x1c),
    name: c.str(0x20, 0x15),
    nameAlt: c.str(0x36, 0x15),
  };
}
