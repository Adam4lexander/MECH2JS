/**
 * SHP: the Miles VFX shape tables the HUD draws - reticles, target brackets,
 * the compass and altitude tapes, damage diagrams, the message bar.
 *
 * Read out of vfx_shape_draw (0x5435c), vfx_shape_count (0x58a43),
 * vfx_shape_size (0x58908) and vfx_shape_origin (0x588e5); see
 * decompiled/tools/dump_shapes.py for the addresses of each read.
 *
 *   table +0   "1.10", a version nothing reads
 *         +4   u32 shape count (vfx_shape_count)
 *         +8   per shape {u32 offset, u32 unread}, offsets from the table
 *   shape +0   u32 vfx_shape_bounds returns it: a size, high word x, low
 *              word y, that layout_pane_fit_shape fits a pane to. In 258 of
 *              309 shapes (xmax - xmin, ymax - ymin), one less than drawn;
 *              the PAUSE shapes store the drawn size
 *         +4   u32 vfx_shape_origin returns it; in 282 of 309 shapes it is
 *              (-xmin) << 16 | (-ymin) (shapes.txt)
 *         +8   i32 xmin, ymin, xmax, ymax about the draw point
 *         +0x18 rows ymin..ymax, each a token stream ended by 0:
 *              1 = skip the next byte's count of pixels; even t = run of
 *              t >> 1 copies of the next byte; odd t = t >> 1 literal bytes.
 *              Every run and string is drawn, colour 0 included.
 */

export interface ShapeHeader {
  /** byte offset of the shape within the table */
  offset: number;
  /** the table's second dword beside the offset; no reader found */
  tableWord: number;
  /** shape +0, what vfx_shape_bounds returns: x << 16 | y, a size (see the header note) */
  word0: number;
  /** shape +4, what vfx_shape_origin returns */
  origin: number;
  xmin: number;
  ymin: number;
  xmax: number;
  ymax: number;
}

export interface ShapeTable {
  bytes: Uint8Array;
  version: string;
  shapes: ShapeHeader[];
}

export function parseShapeTable(b: Uint8Array): ShapeTable {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const count = dv.getUint32(4, true);
  const shapes: ShapeHeader[] = [];
  for (let n = 0; n < count; n++) {
    const offset = dv.getUint32(8 + n * 8, true);
    shapes.push({
      offset,
      tableWord: dv.getUint32(0xc + n * 8, true),
      word0: dv.getUint32(offset, true),
      origin: dv.getUint32(offset + 4, true),
      xmin: dv.getInt32(offset + 8, true),
      ymin: dv.getInt32(offset + 0xc, true),
      xmax: dv.getInt32(offset + 0x10, true),
      ymax: dv.getInt32(offset + 0x14, true),
    });
  }
  let version = '';
  for (let i = 0; i < 4 && b[i] !== 0; i++) version += String.fromCharCode(b[i]!);
  return { bytes: b, version, shapes };
}

/**
 * Walk one shape's rows, calling span(row, x, count, src, at) for every run
 * or string: row and x relative to (xmin, ymin); for a string the pixels are
 * src[at .. at + count), for a run src[at] repeated. Returns null, or what
 * went wrong: a row past the width or a stream that ends early.
 */
export function walkShape(
  t: ShapeTable,
  n: number,
  span: (row: number, x: number, count: number, run: boolean, src: Uint8Array, at: number) => void,
): string | null {
  const s = t.shapes[n]!;
  const b = t.bytes;
  const w = s.xmax - s.xmin + 1;
  const h = s.ymax - s.ymin + 1;
  let p = s.offset + 0x18;
  for (let row = 0; row < h; row++) {
    let x = 0;
    for (;;) {
      if (p >= b.length) return `stream ends in row ${row}`;
      const tok = b[p++]!;
      if (tok === 0) break;
      if (tok === 1) {
        x += b[p++]!;
        continue;
      }
      const count = tok >> 1;
      if (x + count > w) return `row ${row} runs to x=${x + count} past width ${w}`;
      if (tok & 1) {
        span(row, x, count, false, b, p);
        p += count;
      } else {
        span(row, x, count, true, b, p);
        p += 1;
      }
      x += count;
    }
  }
  return null;
}
