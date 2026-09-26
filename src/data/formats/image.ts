/**
 * The three image resources: palettes, shade tables and bitmaps.
 *
 * PAL   768 bytes: 256 RGB triples of VGA DAC values, 6 BITS per channel
 *       (0..63): every byte of all 116 PAL resources is <= 63
 *       (test/golden/images.test.ts). palette_set_entries copies them to the
 *       DAC as they are. CORRECTION: this said 8-bit, reading game_boot's
 *       >> 2 (which narrows a different, 8-bit palette) as if it applied to
 *       PAL resources; the data settles it. Use pal6to8() for display.
 * LUMA  4096 bytes: 16 rows of 256. Row s maps a palette index to the index
 *       it becomes at shade level s. bitmap3d_draw only runs the shade path
 *       for 0 <= level < 15, and in all three shipped tables row 15 is the
 *       identity - so row-major [level][index] is what the data and the
 *       code agree on (test/golden/images.test.ts checks the identity).
 * CEL   ushort width, ushort height, then width*height palette indices.
 *       bitmap3d_draw scales texture u by width-1 and v by height-1, which
 *       is what names the two. Row order (u fastest) is the rasteriser's and
 *       is not yet read from it; unestablished.
 */

export interface Palette {
  /** 256 * 3 bytes, 6-bit VGA DAC values (0..63) */
  rgb: Uint8Array;
}

/** A 6-bit VGA DAC value as 8-bit, the way VGA hardware expands it (c << 2 | c >> 4). */
export const dac6to8 = (c: number): number => ((c << 2) | (c >> 4)) & 0xff;

/** A whole 6-bit palette as 8-bit RGB for display. */
export function pal6to8(rgb: Uint8Array): Uint8Array {
  return rgb.map(dac6to8);
}

export function parsePal(b: Uint8Array): Palette {
  if (b.length < 768) throw new Error(`PAL: ${b.length} bytes, expected 768`);
  return { rgb: b.subarray(0, 768) };
}

export interface LumaTable {
  /** 16 * 256: rows[level * 256 + index] */
  rows: Uint8Array;
}

export function parseLuma(b: Uint8Array): LumaTable {
  if (b.length < 4096) throw new Error(`LUMA: ${b.length} bytes, expected 4096`);
  return { rows: b.subarray(0, 4096) };
}

export interface Cel {
  width: number;
  height: number;
  pixels: Uint8Array;
}

export function parseCel(b: Uint8Array): Cel {
  const width = b[0]! | (b[1]! << 8);
  const height = b[2]! | (b[3]! << 8);
  if (4 + width * height > b.length) throw new Error(`CEL: ${width}x${height} needs ${4 + width * height} bytes, have ${b.length}`);
  return { width, height, pixels: b.subarray(4, 4 + width * height) };
}
