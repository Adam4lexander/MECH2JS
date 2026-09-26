/**
 * anim2dSlots: up to 7 Anim2D records, the cockpit's SHP animations. The ANM2
 * chunk (keyword anim_2d) adds one; hud_widget02_tick and hud_widget13_tick
 * draw slot 0 through anim2d_draw. The one ANM2 in MW2.PRJ loops SNOWCLR
 * (SHP 175, drawn as 175 + assetVariant).
 *
 * anim2dCount is never decremented or reset, so at most 7 ANM2 chunks are
 * accepted per run of MW2.EXE (label note on anim2dCount).
 */
import { Anim2D } from '../../generated/classes.gen.ts';
import { LABEL } from '../../generated/labels.gen.ts';
import type { Chunk } from '../../data/bwd/stream.ts';
import { registerGlobals } from '../../engine/globals.ts';
import { imageI32 } from '../../engine/image.ts';

export const ANIM2D_SLOT_COUNT = 7;

function bootAnim2d() {
  return {
    /** 0xa4a10: Anim2D pointers, null in the image */
    anim2dSlots: new Array<Anim2D | null>(ANIM2D_SLOT_COUNT).fill(null),
    /** 0x9552c: slots handed out so far */
    anim2dCount: imageI32(LABEL.anim2dCount, 0),
  };
}

export const anim2d = registerGlobals('anim2d', bootAnim2d(), () => {
  Object.assign(anim2d, bootAnim2d());
});

/**
 * The ANM2 handler: adds an Anim2D {flags from +8, ticksPerFrame from +0xa,
 * shpId from +0xe} to the next slot and returns the slot, or 0xffff when all
 * 7 are taken, the chunk's id count (+0xc) is not 1 or the id is below 1.
 * project_chunk_exec passes the chunk's fields as anim2d_add's four arguments
 * (flags, ticksPerFrame, idCount, &ids) and discards the result.
 *
 * @mw2 anim2d_add 0x00010c30
 * @fidelity exact
 * @divergence takes the chunk rather than its four fields; the malloc cannot fail
 */
export function anim2dAdd(c: Chunk): number {
  const flags = c.i16(8);
  const ticksPerFrame = c.i16(0xa);
  const idCount = c.i16(0xc);
  const id = c.i16(0xe);
  const a = anim2d;
  if (a.anim2dCount >= ANIM2D_SLOT_COUNT) return 0xffff;
  if (idCount !== 1) return 0xffff;
  if (id < 1) return 0xffff;
  const r = new Anim2D(); // malloc + memset 0
  a.anim2dSlots[a.anim2dCount] = r;
  r.state = 0;
  r.startTick = 0;
  r.flags = flags;
  r.ticksPerFrame = ticksPerFrame;
  r.shpId = id;
  return a.anim2dCount++;
}
