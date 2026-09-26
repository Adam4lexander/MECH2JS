/**
 * XPLO (keyword xplode, tag 43): pre-builds one effect into the next simSlots
 * entry (xploSlotFill, refused at 0x100). project_chunk_exec's XPLO branch:
 *
 *   +0x08  short  OBJECT id (project_mangle_id, project_object_find), -1 for
 *                 none. The object's node becomes SimSlot.node and is taken
 *                 out of the world; a node whose object's family nibble is 0
 *                 gets object type 0x20
 *   +0x0a  short  SimSlot.bitmapSlot: a bitmap3dTable slot, the effect's
 *                 sprite; when above 0 it is started with
 *                 bitmap3d_set_enable(slot, 2), play once
 *   +0x0c  short  SimSlot.typeIndex, an effectTypes index; outside 0..0x1f
 *                 the branch stores 3
 *
 * A slot that already has a node keeps it and only counts; either way
 * active is set to 0 and typeIndex written.
 */
import type { Chunk } from '../stream.ts';

export interface XploChunk {
  /** +0x08 the OBJ id (before project_mangle_id) whose node the effect uses, -1 for none */
  objectId: number;
  /** +0x0a SimSlot.bitmapSlot, a bitmap3dTable slot; started only when above 0 */
  bitmapSlot: number;
  /** +0x0c SimSlot.typeIndex as stored; the handler replaces anything outside 0..0x1f with 3 */
  typeIndex: number;
}

/**
 * Reads an XPLO chunk. typeIndex is returned as stored.
 *
 * @portOnly the read half of project_chunk_exec's XPLO branch
 */
export function decodeXplo(c: Chunk): XploChunk {
  return { objectId: c.i16(0x08), bitmapSlot: c.i16(0x0a), typeIndex: c.i16(0x0c) };
}
