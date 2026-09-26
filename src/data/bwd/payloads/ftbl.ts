/**
 * FTBL (keyword formation, tag 67): formation_table_load appends one
 * StarFormation to formationPresets - only when (size - 0x18) / 0xc == 5, the
 * five-member star, and fewer than 0x20 are loaded:
 *
 *   +0x08  char[16]  StarFormation.name (strncpy 0x10); group_set_formation_by_name
 *                    strcmps against it
 *   +0x18  five 12-byte slots: int x, z, heading -> slotX / slotZ / slotHeading
 */
import type { Chunk } from '../stream.ts';

export interface FtblSlot {
  /** StarFormation.slotX[i] */
  x: number;
  /** StarFormation.slotZ[i] */
  z: number;
  /** StarFormation.slotHeading[i] */
  heading: number;
}

export interface FtblChunk {
  /** +0x08 StarFormation.name, at most 16 characters */
  name: string;
  /** (size - 0x18) / 0xc slots; formation_table_load accepts the chunk only when this is 5 */
  slots: FtblSlot[];
}

/**
 * Reads an FTBL chunk at the offsets formation_table_load reads it.
 *
 * @portOnly the read half of formation_table_load
 */
export function decodeFtbl(c: Chunk): FtblChunk {
  const n = c.size >= 0x18 ? Math.floor((c.size - 0x18) / 0xc) : 0;
  return {
    name: c.str(0x08, 0x10),
    slots: Array.from({ length: n }, (_, i) => ({ x: c.i32(0x18 + i * 0xc), z: c.i32(0x1c + i * 0xc), heading: c.i32(0x20 + i * 0xc) })),
  };
}
