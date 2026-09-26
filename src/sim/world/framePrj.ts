/**
 * frameProjTable: 96 records of {dword, short, short} that FPRJ chunks
 * (keyword frame_prj) append through frame_prj_add. The chunk's +0xc ushort
 * becomes the dword (the chunk is skipped when it is 0xffff), +8 the first
 * short (-1 becomes 1) and +0xa the second (-1 becomes 0); that mapping is the
 * interpreter's.
 *
 * WRITE-ONLY in MW2.EXE: every fixup into the table lies in frame_prj_add or
 * its two resets, and nothing reads it. No FPRJ chunk occurs in MW2.PRJ. So
 * the fields have no established meaning and keep positional names.
 */
import { LABEL } from '../../generated/labels.gen.ts';
import { i16 } from '../../core/int/cint.ts';
import { registerGlobals } from '../../engine/globals.ts';
import { imageI32 } from '../../engine/image.ts';

export const FRAME_PROJ_COUNT = 0x60;

/** One frameProjTable record (8 bytes). @portOnly no struct in mw2_types.h */
export interface FrameProjEntry {
  /** +0 dword: frame_prj_add's first argument masked to 16 bits; -1 when clear */
  field_0x0: number;
  /** +4 short */
  field_0x4: number;
  /** +6 short */
  field_0x6: number;
}

const blank = (): FrameProjEntry => ({ field_0x0: 0, field_0x4: 0, field_0x6: 0 });

function bootFrameProj() {
  return {
    /** 0xa4710: FrameProjEntry[96], zero in the image */
    frameProjTable: Array.from({ length: FRAME_PROJ_COUNT }, blank),
    /** 0x95518: records in the table; -1 in the image, meaning 'not yet cleared' */
    frameProjCount: imageI32(LABEL.frameProjCount, -1),
  };
}

export const frameProj = registerGlobals('frameProj', bootFrameProj(), () => {
  Object.assign(frameProj, bootFrameProj());
});

/**
 * Appends {value & 0xffff, a, b} and returns its index, or -1 when the table
 * is full. The first call of a run clears all 96 records.
 *
 * @mw2 frame_prj_add 0x00010b50
 * @fidelity exact
 */
export function framePrjAdd(id: number, a: number, b: number): number {
  const fp = frameProj;
  if (fp.frameProjCount === -1) {
    for (let i = 0; i < FRAME_PROJ_COUNT; i++) framePrjSlotClear(fp.frameProjTable[i]!);
    fp.frameProjCount = 0;
  }
  if (fp.frameProjCount === -1 || fp.frameProjCount > 0x5f) return -1;
  const e = fp.frameProjTable[fp.frameProjCount]!;
  e.field_0x0 = id & 0xffff;
  e.field_0x4 = i16(a);
  e.field_0x6 = i16(b);
  return fp.frameProjCount++;
}

/**
 * Sets every record to {-1, 0, 0} and the count to 0. UNREACHED in MW2.EXE -
 * no call, jump or fixup targets it.
 *
 * @mw2 frame_prj_reset 0x00010bd0
 * @fidelity exact
 */
export function framePrjReset(): void {
  for (const e of frameProj.frameProjTable) {
    e.field_0x0 = -1;
    e.field_0x4 = 0;
    e.field_0x6 = 0;
  }
  frameProj.frameProjCount = 0;
}

/**
 * @mw2 frame_prj_slot_clear 0x00010c10
 * @fidelity exact
 */
export function framePrjSlotClear(e: FrameProjEntry): void {
  e.field_0x0 = -1;
  e.field_0x4 = 0;
  e.field_0x6 = 0;
}
