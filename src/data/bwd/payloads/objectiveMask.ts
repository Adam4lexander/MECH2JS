/**
 * The objective mask the placement chunks carry (GT +0x1a, GPS +0x20, NAVP
 * +0x22, NAVO +0x0e). project_chunk_exec widens each one the same way before
 * handing it to mission_record_add_value, which appends the placed thing to
 * every state-7 objective of the running stream whose type shares a bit with
 * the widened mask:
 *
 *   any of 0x730 set  ->  all of 0x730 set
 *   any of 0x003 set  ->  both of 0x003 set
 *
 * Read from project_chunk_exec's GT (0x4f1de..), GPS (0x4f91d..), NAVP
 * (0x4f4d0..) and NAVO (0x4f5d0..) branches, where the same four statements
 * appear inline four times.
 */

/**
 * The widening project_chunk_exec applies to a placement chunk's objective
 * mask. The input is the ushort as stored.
 *
 * @portOnly the four inline copies of this in project_chunk_exec; ported with the chunk handlers
 */
export function widenObjectiveMask(mask: number): number {
  let m = mask & 0xffff;
  if (m & 0x730) m |= 0x730;
  if (m & 3) m |= 3;
  return m;
}
