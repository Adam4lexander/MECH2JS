/**
 * The VFX library's GIF reader (vfx_lib, 0x584a7..0x588c2): the size and
 * palette of a GIF's first image, and an LZW decoder that writes it into a
 * pane row by row. MW2.EXE uses it for the two pictures of the fifth cheat
 * code (sim/ui/cheatCredits.ts).
 *
 * gif_decode keeps its state in a 0x502e-byte block the caller allocates
 * (GIF_WORK_SIZE); the port keeps it as those bytes, at the original's
 * offsets:
 *   +0 next code, +4 its limit, +8 x, +0xc y, +0x10 bytes left in the data
 *   sub-block, +0x14 the bit buffer, +0x18 its bit count, +0x1c the code
 *   size, +0x20 pixels left in the row, +0x24 width, +0x28 height (dwords);
 *   +0x2c interlace (descriptor bit 0x40), +0x2d the interlace pass (bytes);
 *   +0x2e the output stack (0x1000 bytes), +0x102e each code's first byte,
 *   +0x202e its last byte, +0x302e its prefix (0x1000 words; 0xffff none,
 *   0xfffe unused).
 * The helpers take the block in EDI and the data pointer in ESI; the port
 * passes both in a GifRun.
 */
import type { ViewWindow } from '../../generated/classes.gen.ts';
import { LABEL } from '../../generated/labels.gen.ts';
import { unestablished } from '../../core/provenance.ts';
import { registerGlobals } from '../globals.ts';
import { imageU8 } from '../image.ts';
import { vfxPaneWriteRow } from './vfx.ts';

/** The work block gif_decode is given (the malloc(0x502e) of its caller). */
export const GIF_WORK_SIZE = 0x502e;

const NEXT = 0;
const LIMIT = 4;
const X = 8;
const Y = 0xc;
const BLOCK_LEFT = 0x10;
const BITS = 0x14;
const NBITS = 0x18;
const CODE_SIZE = 0x1c;
const ROW_LEFT = 0x20;
const WIDTH = 0x24;
const HEIGHT = 0x28;
const INTERLACED = 0x2c;
const PASS = 0x2d;
const STACK = 0x2e;
const FIRST = 0x102e;
const LAST = 0x202e;
const PREFIX = 0x302e;

export const gifGlobals = registerGlobals(
  'gif',
  {
    /** 0xa15d4 (gifPane): the pane gif_decode was given; gif_put_pixel writes into it */
    gifPane: null as ViewWindow | null,
  },
  () => {
    gifGlobals.gifPane = null;
  },
);

/**
 * The row gif_put_pixel gathers. @portOnly the original borrows the bytes of
 * paletteWorking (0xa02c1), which palette_fade_used_colours refills before
 * it reads any entry, so nothing sees the difference
 */
const row = new Uint8Array(0x10000);

/** One decode: the work block and the data being read. @portOnly EDI and ESI of the helpers */
interface GifRun {
  w: Uint8Array;
  dv: DataView;
  data: Uint8Array;
  at: number;
}

const u16 = (b: Uint8Array, o: number): number => (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8);
const get = (r: GifRun, o: number): number => r.dv.getInt32(o, true);
const set = (r: GifRun, o: number, v: number): void => r.dv.setInt32(o, v | 0, true);
const nextData = (r: GifRun): number => r.data[r.at++] ?? 0;

/** A table byte (+0x102e / +0x202e + code); a code past the block reads 0. */
function tableByte(r: GifRun, base: number, code: number): number {
  const o = base + code;
  if (o >= GIF_WORK_SIZE) {
    unestablished('gif_decode: a code past the table (a corrupt GIF) reads past the work block in the original', 'gif_decode');
    return 0;
  }
  return r.w[o]!;
}

function setTableByte(r: GifRun, base: number, code: number, v: number): void {
  const o = base + code;
  if (o >= GIF_WORK_SIZE) {
    unestablished('gif_decode: the table grew past 0x1000 codes (no clear code) - the original writes past the work block', 'gif_decode');
    return;
  }
  r.w[o] = v & 0xff;
}

function prefix(r: GifRun, code: number): number {
  const o = PREFIX + code * 2;
  if (o + 1 >= GIF_WORK_SIZE) {
    unestablished('gif_decode: a code past the table (a corrupt GIF) reads past the work block in the original', 'gif_decode');
    return 0xffff;
  }
  return r.dv.getUint16(o, true);
}

function setPrefix(r: GifRun, code: number, v: number): void {
  const o = PREFIX + code * 2;
  if (o + 1 >= GIF_WORK_SIZE) {
    unestablished('gif_decode: the table grew past 0x1000 codes (no clear code) - the original writes past the work block', 'gif_decode');
    return;
  }
  r.dv.setUint16(o, v & 0xffff, true);
}

/** The offset of the first image descriptor: past the 13-byte header and the global colour table. */
function descriptorAt(data: Uint8Array): number {
  const flags = data[0xa] ?? 0;
  let at = 0xd;
  if ((flags & 0x80) !== 0) at += (1 << ((flags & 7) + 1)) * 3;
  return at;
}

/**
 * The first image's size, width << 16 | height, from the image descriptor
 * that follows the header and global colour table (an extension block
 * before it is not skipped).
 *
 * @mw2 gif_image_size 0x0005888b
 * @fidelity exact
 */
export function gifImageSize(data: Uint8Array): number {
  const at = descriptorAt(data);
  return ((u16(data, at + 5) << 16) | u16(data, at + 7)) | 0;
}

/**
 * The palette into `palette`, narrowed to the DAC's 6 bits: the global
 * colour table, then the first image's local one over it when it has one.
 *
 * @mw2 gif_palette_read 0x0005882a
 * @fidelity exact
 */
export function gifPaletteRead(data: Uint8Array, palette: Uint8Array): void {
  const flags = data[0xa] ?? 0;
  let at = 0xd;
  if ((flags & 0x80) !== 0) {
    const n = (1 << ((flags & 7) + 1)) * 3;
    for (let i = 0; i < n; i++) palette[i] = (data[at++] ?? 0) >> 2;
  }
  const local = data[at + 9] ?? 0;
  if ((local & 0x80) !== 0) {
    const n = (1 << ((local & 7) + 1)) * 3;
    at += 10;
    for (let i = 0; i < n; i++) palette[i] = (data[at++] ?? 0) >> 2;
  }
}

/**
 * Starts the code table again: next code clear + 2, its limit clear * 2;
 * codes below clear stand for their own byte, the rest are marked unused.
 *
 * @mw2 gif_lzw_table_reset 0x000584a7
 * @fidelity exact
 */
export function gifLzwTableReset(r: GifRun, clear: number): void {
  set(r, NEXT, clear + 2);
  set(r, LIMIT, clear * 2);
  let b = 0;
  for (; b < clear; b++) {
    setTableByte(r, FIRST, b, b);
    setTableByte(r, LAST, b, b);
    setPrefix(r, b, 0xffff);
  }
  for (; b < 0x1000; b++) setPrefix(r, b, 0xfffe);
}

/**
 * The next byte of image data, taking a sub-block's length byte first when
 * the last sub-block is used up.
 *
 * @mw2 gif_read_byte 0x000584ef
 * @fidelity exact
 */
export function gifReadByte(r: GifRun): number {
  if (get(r, BLOCK_LEFT) === 0) set(r, BLOCK_LEFT, nextData(r));
  const b = nextData(r);
  set(r, BLOCK_LEFT, get(r, BLOCK_LEFT) - 1);
  return b;
}

/**
 * The next n bits (at most 8), least significant first, through the bit
 * buffer, masked with gifBitMasks[n].
 *
 * @mw2 gif_read_bits 0x00058508
 * @fidelity exact
 */
export function gifReadBits(r: GifRun, n: number): number {
  if (get(r, NBITS) === 0) {
    set(r, BITS, gifReadByte(r));
    set(r, NBITS, 8);
  }
  if (get(r, NBITS) < n) {
    const b = gifReadByte(r);
    set(r, BITS, get(r, BITS) | (b << get(r, NBITS)));
    set(r, NBITS, get(r, NBITS) + 8);
  }
  const v = get(r, BITS) & imageU8(LABEL.gifBitMasks + n, (1 << n) - 1);
  set(r, NBITS, get(r, NBITS) - n);
  set(r, BITS, get(r, BITS) >>> n);
  return v;
}

/**
 * Adds the next code: prefix `pre`, last byte the first byte of `of`'s
 * string, first byte the first byte of `pre`'s; past the limit (below 12
 * bits) the code size grows by one and the limit doubles.
 *
 * @mw2 gif_lzw_add_code 0x0005854e
 * @fidelity exact
 */
export function gifLzwAddCode(r: GifRun, of: number, pre: number): void {
  const next = get(r, NEXT);
  setPrefix(r, next, pre);
  setTableByte(r, LAST, next, tableByte(r, FIRST, of));
  setTableByte(r, FIRST, next, tableByte(r, FIRST, pre));
  set(r, NEXT, next + 1);
  if (get(r, NEXT) === get(r, LIMIT) && get(r, CODE_SIZE) < 0xc) {
    set(r, CODE_SIZE, get(r, CODE_SIZE) + 1);
    set(r, LIMIT, get(r, LIMIT) << 1);
  }
}

/**
 * One pixel into the row; a full row goes into the pane
 * (vfx_pane_write_row) and the next begins - one row down, back to the top
 * past the height; interlaced, down by gifInterlaceStep[pass], and a pass
 * that runs past the height starts the next at gifInterlaceStart[pass + 1].
 *
 * @mw2 gif_put_pixel 0x00058594
 * @fidelity exact
 */
export function gifPutPixel(r: GifRun, colour: number): void {
  const x = get(r, X);
  row[x & 0xffff] = colour & 0xff;
  set(r, X, x + 1);
  set(r, ROW_LEFT, get(r, ROW_LEFT) - 1);
  if (get(r, ROW_LEFT) !== 0) return;
  if (gifGlobals.gifPane) vfxPaneWriteRow(gifGlobals.gifPane, get(r, Y), row, get(r, WIDTH));
  set(r, X, 0);
  set(r, ROW_LEFT, get(r, WIDTH));
  if (r.w[INTERLACED] !== 0) {
    set(r, Y, get(r, Y) + imageU8(LABEL.gifInterlaceStep + r.w[PASS]!, [8, 8, 4, 2, 0][r.w[PASS]!] ?? 0));
    if (get(r, Y) >= get(r, HEIGHT)) {
      r.w[PASS] = (r.w[PASS]! + 1) & 0xff;
      set(r, Y, imageU8(LABEL.gifInterlaceStart + r.w[PASS]!, [0, 4, 2, 1, 0][r.w[PASS]!] ?? 0));
    }
    return;
  }
  set(r, Y, get(r, Y) + 1);
  if (get(r, Y) >= get(r, HEIGHT)) set(r, Y, 0);
}

/**
 * Decodes a GIF's first image into a pane, rows from the pane's top: the
 * LZW codes read at a growing code size; a clear code starts the table
 * again, the end code skips the remaining sub-blocks and stops; a code not
 * yet in the table adds prev + the first byte of prev, any other adds prev +
 * the first byte of the code (after a clear, nothing); each code's string is
 * put out through the stack at +0x2e. Returns byte 11 of the header, the
 * background colour index.
 *
 * @mw2 gif_decode 0x00058611
 * @fidelity exact
 * @divergence the original's 1-bit output path (EDX == 1), which its own code never takes (EDX is always 8), is not ported; a corrupt GIF whose codes run past the table stops where the original would read or write past its work block
 */
export function gifDecode(pane: ViewWindow, data: Uint8Array, work: Uint8Array): number {
  gifGlobals.gifPane = pane;
  work.fill(0, 0, 0x2e);
  const r: GifRun = { w: work, dv: new DataView(work.buffer, work.byteOffset, work.byteLength), data, at: 0 };
  const background = data[0xb] ?? 0;
  let at = descriptorAt(data);
  set(r, WIDTH, u16(data, at + 5));
  set(r, HEIGHT, u16(data, at + 7));
  const local = data[at + 9] ?? 0;
  work[INTERLACED] = local & 0x40;
  at += 10;
  if ((local & 0x80) !== 0) at += (1 << ((local & 7) + 1)) * 3;
  set(r, BLOCK_LEFT, 0);
  r.at = at;
  const minSize = nextData(r);
  const clear = 1 << (minSize & 0x1f);
  const end = clear + 1;
  set(r, CODE_SIZE, minSize + 1);
  gifLzwTableReset(r, clear);
  let prev = 0xffff;
  let done = false;
  work[PASS] = 0;
  set(r, ROW_LEFT, get(r, WIDTH));
  set(r, X, 0);
  set(r, Y, 0);
  while (!done) {
    const size = get(r, CODE_SIZE);
    let code: number;
    if (size <= 8) code = gifReadBits(r, size);
    else {
      const lo = gifReadBits(r, 8);
      code = (gifReadBits(r, size - 8) << 8) | lo;
    }
    if (code === clear) {
      gifLzwTableReset(r, clear);
      set(r, CODE_SIZE, minSize + 1);
      prev = 0xffff;
      continue;
    }
    if (code === end) {
      for (;;) {
        while (get(r, BLOCK_LEFT) !== 0) {
          r.at++;
          set(r, BLOCK_LEFT, get(r, BLOCK_LEFT) - 1);
        }
        set(r, BLOCK_LEFT, nextData(r));
        if (get(r, BLOCK_LEFT) === 0) break;
      }
      done = true;
      continue;
    }
    if (prefix(r, code) === 0xfffe) gifLzwAddCode(r, prev, prev);
    else if (prev !== 0xffff) gifLzwAddCode(r, code, prev);
    let n = 0;
    let c = code;
    do {
      if (n >= 0x1000) {
        unestablished('gif_decode: a code chain longer than the stack (a corrupt GIF) runs over the tables in the original', 'gif_decode');
        break;
      }
      work[STACK + n++] = tableByte(r, LAST, c);
      c = prefix(r, c);
    } while (c !== 0xffff);
    while (n > 0) gifPutPixel(r, work[STACK + --n]!);
    prev = code;
    if (r.at > data.length + 0x100) {
      unestablished('gif_decode: the data ran out before the end code; the original reads on past the file', 'gif_decode');
      break;
    }
  }
  return background;
}
