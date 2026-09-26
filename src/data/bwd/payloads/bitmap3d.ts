/**
 * The four 3dbitmap chunks, which build the sprite animations
 * (bitmap3dFrames blocks of 32 CEL frames, and 512 bitmap3dTable slots that
 * play them). All four are dispatched by project_chunk_exec:
 *
 *   BMPJ  3dbitmap_prj     +0x08 short CEL id, or -1 and a name at +0x0a
 *                          resolved through TABL 8 (MAPTABLE,
 *                          resource_id_by_name(8)); unresolved is
 *                          system_error 0x28 and nothing is added. Otherwise
 *                          bitmap3d_add_frame(id, -1) appends it to the current
 *                          block (moving to the next block first when a BMID
 *                          has just bound this one). bitmap3d_add_frame ignores
 *                          an id below 1.
 *   BMID  3dbitmap_idlist  +0x08 short slot: bitmap3d_set_id(slot, -1) binds it
 *                          to the current block (frame 0, playMode 1, state 1,
 *                          and ticksPerFrame 0x2d when the flag at 0x96cfc is
 *                          set - bitmap3d_add_frame sets it when the frame it
 *                          added was not its block's first) and raises
 *                          bitmap3dAdvancePending
 *   BSEC  3dbitmap_sec     +0x08 short slot, +0x0a short
 *                          Bitmap3dSlot.ticksPerFrame (bitmap3d_set_sec), then
 *                          bitmap3d_set_enable(slot, 1)
 *   BMEN  3dbitmap_enable  +0x08 short slot, +0x0a short Bitmap3dSlot.playMode
 *                          (bitmap3d_set_enable): 0 stopped, 2 play once, any
 *                          other value loop
 *
 * bitmap3d_set_enable writes playMode only while the slot's state is not -2
 * (the value bitmap3d_reset leaves), and restores ticksPerFrame to 0x2d when
 * it is 0.
 */
import type { Chunk, StreamRef } from '../stream.ts';

export interface BmpjChunk {
  /** +0x08 CEL resource id and +0x0a its name: id -1 resolves the name through MAPTABLE */
  frame: StreamRef;
}

export interface BmidChunk {
  /** +0x08 the bitmap3dTable slot bound to the current block */
  slot: number;
}

export interface BsecChunk {
  /** +0x08 the bitmap3dTable slot */
  slot: number;
  /** +0x0a Bitmap3dSlot.ticksPerFrame, the frame period in 182 Hz ticks */
  ticksPerFrame: number;
}

export interface BmenChunk {
  /** +0x08 the bitmap3dTable slot */
  slot: number;
  /** +0x0a Bitmap3dSlot.playMode: 0 stopped, 2 play once, other values loop */
  playMode: number;
}

/**
 * Reads a BMPJ chunk: the {short id; name} reference project_chunk_exec
 * resolves. The name has no bound in the original; it is read to the
 * chunk's end.
 *
 * @portOnly the read half of project_chunk_exec's BMPJ branch
 */
export function decodeBmpj(c: Chunk): BmpjChunk {
  return { frame: { id: c.i16(0x08), name: c.str(0x0a, Math.max(0, c.bytes.length - 0x0a)) } };
}

/**
 * Reads a BMID chunk.
 *
 * @portOnly the read half of project_chunk_exec's BMID branch
 */
export function decodeBmid(c: Chunk): BmidChunk {
  return { slot: c.i16(0x08) };
}

/**
 * Reads a BSEC chunk.
 *
 * @portOnly the read half of project_chunk_exec's BSEC branch
 */
export function decodeBsec(c: Chunk): BsecChunk {
  return { slot: c.i16(0x08), ticksPerFrame: c.i16(0x0a) };
}

/**
 * Reads a BMEN chunk.
 *
 * @portOnly the read half of project_chunk_exec's BMEN branch
 */
export function decodeBmen(c: Chunk): BmenChunk {
  return { slot: c.i16(0x08), playMode: c.i16(0x0a) };
}
