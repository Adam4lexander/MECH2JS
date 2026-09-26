/**
 * anim2dSlots: up to 7 Anim2D records, the cockpit's SHP animations. The ANM2
 * chunk (keyword anim_2d) adds one; hud_widget02_tick and hud_widget13_tick
 * draw slot 0 through anim2d_draw. The one ANM2 in MW2.PRJ loops SNOWCLR
 * (SHP 175, drawn as 175 + assetVariant).
 *
 * anim2dCount is never decremented or reset, so at most 7 ANM2 chunks are
 * accepted per run of MW2.EXE (label note on anim2dCount).
 */
import { Anim2D, type ViewWindow } from '../../generated/classes.gen.ts';
import { LABEL } from '../../generated/labels.gen.ts';
import type { Chunk } from '../../data/bwd/stream.ts';
import { registerGlobals } from '../../engine/globals.ts';
import { imageI32 } from '../../engine/image.ts';
import { clock } from '../../engine/clock.ts';
import { cdiv, cmod } from '../../core/int/cint.ts';
import { cacheLoadResource, cacheUnlock } from '../../engine/resources/cache.ts';
import { vfxShapeCount, vfxShapeDraw } from '../../engine/vfx/vfx.ts';
import { display } from '../display/video.ts';

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

/**
 * Frees one Anim2D: unlocks its SHP if loaded and empties the slot.
 * anim2dCount is not decremented, so the slot is never handed out again.
 *
 * @mw2 anim2d_free 0x00010d10
 * @fidelity exact
 */
export function anim2dFree(slot: number): void {
  const a = anim2d.anim2dSlots[slot];
  if (a) {
    if (a.shp) cacheUnlock((a.shpId + display.assetVariant) | 0, 'SHP');
    anim2d.anim2dSlots[slot] = null;
  }
}

/**
 * @mw2 anim2d_free_slot_or_all 0x00010ce0
 * @fidelity exact
 */
export function anim2dFreeSlotOrAll(slot: number): void {
  if (slot > -1) {
    anim2dFree(slot);
    return;
  }
  for (let i = 0; i < ANIM2D_SLOT_COUNT; i++) anim2dFree(i);
}

/**
 * Steps an Anim2D by simTick and draws the frame it is on at (x, y) in a
 * pane: looping takes the elapsed frames modulo frameCount; a play-once
 * animation past its end holds its last frame (flags bit 1, state 3) or
 * finishes (state 1), and a finished one with flags bit 3 frees its slot.
 * The slot check (slot >= 0 || slot < 7) is always true.
 *
 * @mw2 anim2d_draw 0x00010d70
 * @fidelity exact
 * @divergence a play-once animation that finishes without bit 1 leaves the frame variable unset in the original; nothing is drawn in that state, so it is never read
 */
export function anim2dDraw(pane: ViewWindow, slot: number, x: number, y: number): void {
  const a = anim2d.anim2dSlots[slot];
  if (!a || a.state === 1) return;
  if (!a.shp) {
    const shp = cacheLoadResource((display.assetVariant + a.shpId) | 0, 'SHP');
    a.shp = shp;
    if (!shp) {
      anim2dFreeSlotOrAll(slot);
      return;
    }
    a.frameCount = vfxShapeCount(shp);
  }
  if (a.state === 0) a.state = 2;
  let frame: number;
  if (a.startTick === 0) {
    a.startTick = clock.simTick;
    frame = 0;
  } else {
    frame = cdiv((clock.simTick - a.startTick) | 0, a.ticksPerFrame);
    if (frame < 0) frame = 0;
  }
  if ((a.flags & 1) === 0) frame = cmod(frame, a.frameCount);
  else if (a.frameCount <= frame) {
    if ((a.flags & 2) === 0) a.state = 1;
    else {
      a.state = 3;
      frame = ((a.frameCount & 0xffff) - 1) | 0;
    }
  }
  if (a.state !== 1) {
    vfxShapeDraw(pane, a.shp as Uint8Array, frame & 0xffff, x, y);
    return;
  }
  if ((a.flags & 8) !== 0) anim2dFreeSlotOrAll(slot);
}

/**
 * @mw2 anim2d_draw_thunk 0x00033130
 * @fidelity exact
 */
export function anim2dDrawThunk(pane: ViewWindow, slot: number, x: number, y: number): void {
  anim2dDraw(pane, slot, x, y);
}

/**
 * Starts an Anim2D over on its next draw. Nothing in MW2.EXE calls it.
 *
 * @mw2 anim2d_rewind 0x00010ed0
 * @fidelity exact
 */
export function anim2dRewind(slot: number): void {
  const a = anim2d.anim2dSlots[slot]!;
  a.state = 0;
  a.startTick = 0;
}
