/**
 * STAR (keyword star, tag 58): the group setup chunk. star_table_load reads
 * one 0x18-byte record per group, in group order, (size - 8) / 0x18 of them:
 *
 *   +0x00  int      MechGroup.affiliation (and the index into
 *                   affiliationAllegiance)
 *   +0x04  byte     MechGroup.allegiance (also affiliationAllegiance[affiliation])
 *   +0x08  char[]   formation name, passed to group_set_formation_by_name -
 *                   unless the command line's -OF= / -OE= override it
 *   +0x05..+0x07 and the bytes after the name's NUL are not read
 */
import type { Chunk } from '../stream.ts';

export interface StarGroupRecord {
  /** +0x00 MechGroup.affiliation */
  affiliation: number;
  /** +0x04 MechGroup.allegiance */
  allegiance: number;
  /** +0x08 the formation name group_set_formation_by_name looks up */
  formation: string;
}

export interface StarChunk {
  /** (size - 8) / 0x18 records; record i sets up group i */
  groups: StarGroupRecord[];
}

/**
 * Reads a STAR chunk at the offsets star_table_load reads it. The formation
 * name has no bound in the original (it is passed as a pointer); the decoder
 * stops at the record's end.
 *
 * @portOnly the read half of star_table_load
 */
export function decodeStar(c: Chunk): StarChunk {
  const n = c.size >= 8 ? Math.floor((c.size - 8) / 0x18) : 0;
  return {
    groups: Array.from({ length: n }, (_, i) => {
      const o = 8 + i * 0x18;
      return { affiliation: c.i32(o), allegiance: c.u8(o + 4), formation: c.str(o + 8, 0x10) };
    }),
  };
}
