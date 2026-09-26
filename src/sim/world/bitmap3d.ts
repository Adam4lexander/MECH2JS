/**
 * 3dbitmaps: the frame animations textured polygons draw.
 *
 * bitmap3dFrames is 512 blocks of 32 Bitmap3dFrame entries, each a CEL
 * resource id (-1 empty). bitmap3dTable is 512 Bitmap3dSlot records, each
 * playing one block: which frame shows, how many 182 Hz ticks each frame
 * lasts, and whether it loops, plays once or is stopped.
 *
 * The mission stream builds them (BMPJ appends a frame to the current block,
 * BMID binds a slot to it and moves the next BMPJ on to a fresh block, BSEC
 * sets a slot's period, BMEN its play mode); main runs bitmap3d_animate every
 * frame; effects start and rewind their sprite's slot.
 *
 * HOW A POLYGON FINDS ITS TEXTURE (bitmap3d_draw, 0x37860, which is the
 * renderer's): a WTBO polygon code of mode 0x5000/0x6000/0x7000 carries a slot
 * number in its low byte. The draw adds 0x100 to it unless its fifth argument
 * is set (the polygon callers pass 0, so polygons use slots 0x100..0x1ff; the
 * one caller that passes 1 draws slot numbers as given), and draws nothing
 * while the slot's playMode is 0 or its state is negative. Otherwise the frame
 * is bitmap3dFrames[slot.block][slot.frame]; a celId below 1 draws nothing,
 * else the CEL is cache_load_resource(celId, CEL) - its first two ushorts are
 * width and height and the pixels start at +4. See bitmap3dDrawFrame().
 */
import { Bitmap3dFrame, Bitmap3dSlot } from '../../generated/classes.gen.ts';
import { LABEL } from '../../generated/labels.gen.ts';
import { cdiv, i16, u16 } from '../../core/int/cint.ts';
import { divergence } from '../../core/provenance.ts';
import { clock } from '../../engine/clock.ts';
import { registerGlobals } from '../../engine/globals.ts';
import { imageI32 } from '../../engine/image.ts';

export const BITMAP3D_SLOT_COUNT = 0x200;
export const BITMAP3D_BLOCK_COUNT = 0x200;
export const BITMAP3D_FRAMES_PER_BLOCK = 0x20;
/** 0x96cfc - not labelled; see bitmap3d.dat00096cfc. */
const DAT_00096CFC = 0x96cfc;

function bootBitmap3d() {
  return {
    /** 0x12ded0: Bitmap3dSlot[512] (zero in the image: bitmap3d_reset runs before anything reads it) */
    bitmap3dTable: Array.from({ length: BITMAP3D_SLOT_COUNT }, () => new Bitmap3dSlot()),
    /** 0x12fad0: Bitmap3dFrame[512][32] */
    bitmap3dFrames: Array.from({ length: BITMAP3D_BLOCK_COUNT }, () => Array.from({ length: BITMAP3D_FRAMES_PER_BLOCK }, () => new Bitmap3dFrame())),
    /** 0x96cec: -2 in the image, so the first BMPJ of a run calls bitmap3d_reset */
    bitmap3dNeedsReset: imageI32(LABEL.bitmap3dNeedsReset, -2),
    /** 0x96cf4: the block BMPJ appends to */
    bitmap3dCurrentBlock: imageI32(LABEL.bitmap3dCurrentBlock, 0),
    /** 0x96cf8: set by BMID; the next BMPJ moves to a new block first */
    bitmap3dAdvancePending: imageI32(LABEL.bitmap3dAdvancePending, 0),
    /**
     * 0x96cfc, unlabelled. bitmap3d_add_frame sets it to 1 when the block it
     * appends to already had a first frame, else 0; bitmap3d_set_id then gives
     * the slot it binds ticksPerFrame 0x2d only while it is set. So a block of
     * one frame keeps whatever period its slot had. bitmap3d_reset zeroes it.
     */
    dat00096cfc: imageI32(DAT_00096CFC, 0),
  };
}

export const bitmap3d = registerGlobals('bitmap3d', bootBitmap3d(), () => {
  Object.assign(bitmap3d, bootBitmap3d());
});

/** The slot at a C short index, or undefined (with a divergence) where the original would write outside the table. */
function slotAt(slot: number, fn: string): Bitmap3dSlot | undefined {
  const s = bitmap3d.bitmap3dTable[slot];
  if (!s) divergence(`${fn}: slot ${slot} is outside bitmap3dTable; the original reads/writes past the table`);
  return s;
}

/**
 * Steps every live slot by the frames its period says have elapsed since it
 * last stepped, wrapping at 32 or at the first empty frame, and stops a
 * play-once slot the moment it wraps. The leftover ticks are kept so timing
 * does not drift.
 *
 * @mw2 bitmap3d_animate 0x00037a60
 * @fidelity exact
 */
export function bitmap3dAnimate(): void {
  const now = clock.simTick;
  const b = bitmap3d;
  for (let i = 0; i < BITMAP3D_SLOT_COUNT; i++) {
    const s = b.bitmap3dTable[i]!;
    // playMode and ticksPerFrame are tested as words (== 0), the period is
    // divided as an unsigned word (0x37a9d, 0x37ac5)
    if (s.state < 0 || s.playMode === 0 || s.ticksPerFrame === 0) continue;
    if (s.lastStepTick === 0) s.lastStepTick = now;
    const elapsed = (now - s.lastStepTick) | 0;
    const period = u16(s.ticksPerFrame);
    const n = cdiv(elapsed, period);
    let f = s.frame; // movsx: signed
    if (n > 0) {
      const block = b.bitmap3dFrames[s.block];
      for (let k = 0; k < n; k++) {
        f = (f + 1) & 0x1f;
        if (!block || block[f]!.celId < 1) f = 0;
      }
      // mode compared as a word; the frame compare is unsigned (jae, 0x37b24)
      if (u16(s.playMode) === 2 && f >>> 0 < s.frame >>> 0) {
        s.playMode = 0;
        f = 0;
      }
      s.frame = i16(f);
      s.lastStepTick = (now - ((elapsed - Math.imul(period, n)) | 0)) | 0;
    }
  }
}

/**
 * Appends a CEL id as the next frame of a block - the current one when `block`
 * is -1, moving to a new block first if a BMID has just bound the current one.
 * Resets both tables on the first call of a run. Returns 0, or -1 when the id
 * is below 1, the block out of range or the block full.
 *
 * @mw2 bitmap3d_add_frame 0x00037b60
 * @fidelity exact
 */
export function bitmap3dAddFrame(celId: number, block: number): number {
  const b = bitmap3d;
  let idx = 0;
  let found = false;
  if (b.bitmap3dNeedsReset === -2) bitmap3dReset();
  if (block === -1) {
    if (b.bitmap3dAdvancePending !== 0) {
      b.bitmap3dAdvancePending = 0;
      b.bitmap3dCurrentBlock = (b.bitmap3dCurrentBlock + 1) | 0;
    }
    block = b.bitmap3dCurrentBlock;
  }
  if (celId < 1 || block < 0 || block > 0x1ff) return -1;
  const frames = b.bitmap3dFrames[block]!;
  if (frames[0]!.celId < 1) {
    b.dat00096cfc = 0;
  } else {
    b.dat00096cfc = 1;
    while (!found) {
      idx++;
      if (idx > 0x1f) return -1;
      if (frames[idx]!.celId === -1) found = true;
    }
  }
  frames[idx]!.celId = i16(celId);
  return 0;
}

/**
 * Binds a slot to a frame block (the current one for -1, which also makes
 * the next BMPJ start a new block) and restarts it: frame 0, looping, state 1,
 * and a 0x2d-tick period when the block's last BMPJ was not its first frame.
 * Returns 1, or 0 when slot or block is out of range.
 *
 * @mw2 bitmap3d_set_id 0x00037c70
 * @fidelity exact
 */
export function bitmap3dSetId(slot: number, block: number): number {
  const b = bitmap3d;
  if (block === -1) {
    b.bitmap3dAdvancePending = 1;
    block = b.bitmap3dCurrentBlock;
  }
  if (block > -1 && block < 0x200 && slot > -1 && slot < 0x200) {
    const s = b.bitmap3dTable[slot]!;
    s.block = i16(block);
    s.frame = 0;
    s.state = 1;
    s.playMode = 1;
    if (b.dat00096cfc !== 0) s.ticksPerFrame = 0x2d;
    return 1;
  }
  return 0;
}

/**
 * Empties both tables: every frame {-1, 0, null} and every slot {block -1,
 * frame 0, period 0, stopped, state -2, lastStepTick -1}, and clears the
 * current-block state.
 *
 * @mw2 bitmap3d_reset 0x00037d00
 * @fidelity exact
 * @divergence the CEL pointers are dropped without release, as in the original (the port's cache has nothing to release)
 */
export function bitmap3dReset(): void {
  const b = bitmap3d;
  for (const block of b.bitmap3dFrames) {
    for (const f of block) {
      f.celId = -1;
      f.field_0x2 = 0;
      f.cel = null;
    }
  }
  for (const s of b.bitmap3dTable) {
    s.block = -1;
    s.frame = 0;
    s.ticksPerFrame = 0;
    s.playMode = 0;
    s.state = -2;
    s.lastStepTick = -1;
  }
  b.bitmap3dNeedsReset = 0;
  b.bitmap3dCurrentBlock = 0;
  b.bitmap3dAdvancePending = 0;
  b.dat00096cfc = 0;
}

/**
 * Sets a slot's play mode (0 stopped, 2 once, other values loop) unless the
 * slot is still in bitmap3d_reset's -2 state, and gives it the 0x2d default
 * period if it has none - the period is written even for a -2 slot.
 *
 * @mw2 bitmap3d_set_enable 0x00037da0
 * @fidelity exact
 */
export function bitmap3dSetEnable(slot: number, mode: number): void {
  const s = slotAt(i16(slot), 'bitmap3d_set_enable');
  if (!s) return;
  if (s.state !== -2) s.playMode = i16(mode);
  if (s.ticksPerFrame === 0) s.ticksPerFrame = 0x2d;
}

/**
 * Points a slot at frame n (n above 0x1f becomes 0) and restarts its timing,
 * unless the slot is not running (state negative) or that frame is empty.
 *
 * @mw2 bitmap3d_set_frame 0x00037df0
 * @fidelity exact
 */
export function bitmap3dSetFrame(slot: number, frame: number): void {
  let f = u16(frame);
  if (f > 0x1f) f = 0;
  const s = slotAt(i16(slot), 'bitmap3d_set_frame');
  if (!s) return;
  if (s.state > -1 && (bitmap3d.bitmap3dFrames[s.block]?.[f]?.celId ?? 0) > 0) {
    s.lastStepTick = 0;
    s.frame = f;
  }
}

/**
 * Sets a slot's frame period in ticks.
 *
 * @mw2 bitmap3d_set_sec 0x00037e40
 * @fidelity exact
 */
export function bitmap3dSetSec(slot: number, sec: number): void {
  const s = slotAt(i16(slot), 'bitmap3d_set_sec');
  if (s) s.ticksPerFrame = i16(sec);
}

/**
 * The frame bitmap3d_draw would draw for a slot, or null where it draws
 * nothing: a stopped slot (playMode 0), one not running (state < 0) or an
 * empty frame (celId < 1). `polygon` is true for the polygon callers, which
 * draw slot + 0x100 (bitmap3d_draw's fifth argument 0). The CEL itself is
 * loaded by the caller (cache_load_resource(celId, 'CEL')) and may be kept in
 * frame.cel, as the original does.
 *
 * @portOnly the selection half of bitmap3d_draw (0x37860) for the renderer
 */
export function bitmap3dDrawFrame(slot: number, polygon: boolean): Bitmap3dFrame | null {
  const s = bitmap3d.bitmap3dTable[polygon ? slot + 0x100 : slot];
  if (!s || s.playMode === 0 || s.state < 0) return null;
  const f = bitmap3d.bitmap3dFrames[s.block]?.[s.frame];
  return f && f.celId >= 1 ? f : null;
}
