/**
 * OBJL (keyword objloc, tag 41): the armour section a gamepiece's detail part
 * belongs to. project_chunk_exec's OBJL branch:
 *
 *   +0x08  short  part (OBJ) id: project_mangle_id, then project_detail_find
 *   +0x0a  short  location, skipped when 0xffff: detail_record_set_location
 *                 stores it; detail_record_build copies it into
 *                 WorldObject.hitLocation and projectile_update hands that to
 *                 mech_apply_damage - a 1-based section (1 head, 2 right torso,
 *                 3 centre torso, 4 left torso, 5 right arm, 6 left arm,
 *                 7 right leg, 8 left leg, MechChassis.sections' order)
 *
 * A part with no OBJL keeps location 0, which mech_apply_damage refuses.
 */
import type { Chunk } from '../stream.ts';

export interface ObjlChunk {
  /** +0x08 the detail part's OBJ id (before project_mangle_id) */
  partId: number;
  /** +0x0a the 1-based mech section; -1 (0xffff) means the chunk is skipped */
  location: number;
}

/**
 * Reads an OBJL chunk. The branch compares the location as a ushort against
 * 0xffff; it is returned signed, so that value reads -1.
 *
 * @portOnly the read half of project_chunk_exec's OBJL branch
 */
export function decodeObjl(c: Chunk): ObjlChunk {
  return { partId: c.i16(0x08), location: c.i16(0x0a) };
}
