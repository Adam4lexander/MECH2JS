/**
 * NAVP (keyword navpoint, tag 44) and NAVO (navobject, tag 45): the two
 * chunks that build a TrackedObject - the 128-entry trackedObjects table the
 * AI steers by and the nav display walks.
 *
 * NAVP, project_chunk_exec 0x4f4d0..0x4f5cb (the decompiled C of this branch
 * is garbled by the rep movs direction-flag idiom; the offsets are from the
 * disassembly, as tools/dump_navpoints.py records):
 *
 *   +0x08/+0x0c/+0x10  int x, y, z  -> TrackedObject.x/y/z after
 *                      block_transform_point (a navpoint inside BLK..ENDB is
 *                      in that block's frame)
 *   +0x14  int     -> TrackedObject.heading (16.16 degrees)
 *   +0x18  short   -> TrackedObject.inUse (sign-extended; 0 occurs)
 *   +0x1a  ushort  -> TrackedObject.flags
 *   +0x1c  short   -> TrackedObject.targetHandle, (type << 8) | index
 *   +0x1e  short   -> TrackedObject.groupId
 *   +0x20  ushort  -> TrackedObject.range, times 100 (metres in the chunk)
 *   +0x22  ushort  objective mask, widened, then mission_record_add_value
 *                  with (tracked index | 0x100)
 *   +0x24  char[21] -> TrackedObject.name (strncpy 0x15, NUL forced at +0x15)
 *   +0x3a..        not read
 *
 * NAVO, 0x4f5d0..0x4f70f: +0x0a short object id (project_mangle_id; a world
 * record gives world_object_get_pos, else the OBJ's node gives
 * scene_node_get_world_euler and followNode), +0x0c short range stored AS-IS
 * (no * 100), +0x0e ushort objective mask. inUse 1, flags and targetHandle 0,
 * no name. +0x08 is not read.
 */
import type { Chunk } from '../stream.ts';

export interface NavpChunk {
  /** +0x08 position in cm, in the enclosing block's frame (block_transform_point) */
  x: number;
  /** +0x0c the height */
  y: number;
  /** +0x10 */
  z: number;
  /** +0x14 TrackedObject.heading, 16.16 degrees */
  heading: number;
  /** +0x18 TrackedObject.inUse (signed short; only ever tested against zero) */
  inUse: number;
  /** +0x1a TrackedObject.flags */
  flags: number;
  /** +0x1c TrackedObject.targetHandle, (type << 8) | index; signed short as stored */
  targetHandle: number;
  /** +0x1e TrackedObject.groupId */
  groupId: number;
  /** +0x20 range in METRES (unsigned); the handler stores range * 100 */
  rangeMetres: number;
  /** +0x22 objective mask as stored (see widenObjectiveMask) */
  objectiveMask: number;
  /** +0x24 TrackedObject.name, at most 21 characters */
  name: string;
}

export interface NavoChunk {
  /** +0x0a an OBJ id (before project_mangle_id): a world record, else an object whose node the entry follows */
  objectId: number;
  /** +0x0c TrackedObject.range, signed short stored as-is */
  range: number;
  /** +0x0e objective mask as stored (see widenObjectiveMask) */
  objectiveMask: number;
}

/**
 * Reads a NAVP chunk at the offsets project_chunk_exec reads it.
 *
 * @portOnly the read half of project_chunk_exec's NAVP branch
 */
export function decodeNavp(c: Chunk): NavpChunk {
  return {
    x: c.i32(0x08),
    y: c.i32(0x0c),
    z: c.i32(0x10),
    heading: c.i32(0x14),
    inUse: c.i16(0x18),
    flags: c.u16(0x1a),
    targetHandle: c.i16(0x1c),
    groupId: c.i16(0x1e),
    rangeMetres: c.u16(0x20),
    objectiveMask: c.u16(0x22),
    name: c.str(0x24, 0x15),
  };
}

/**
 * Reads a NAVO chunk at the offsets project_chunk_exec reads it.
 *
 * @portOnly the read half of project_chunk_exec's NAVO branch
 */
export function decodeNavo(c: Chunk): NavoChunk {
  return {
    objectId: c.i16(0x0a),
    range: c.i16(0x0c),
    objectiveMask: c.u16(0x0e),
  };
}
