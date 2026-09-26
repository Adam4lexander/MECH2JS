/**
 * FONT: the Miles VFX fonts the HUD's text is drawn in.
 *
 * Read out of vfx_character_draw (0x57e93); see
 * decompiled/tools/dump_fonts.py for the address of each read.
 *
 *   +0    "1." and two NULs, a version the drawer does not read
 *   +4    u32 (128 in all three fonts) not read by the drawer
 *   +8    u32 glyph height
 *   +0xc  u32 (0xff in all three) not read by the drawer
 *   +0x10 u32 offset of glyph ch at +0x10 + ch * 4, from the font; ch is not
 *         range-checked by the drawer
 *   glyph u32 width, then width * height bytes row by row
 */

export interface Font {
  bytes: Uint8Array;
  version: string;
  word4: number;
  height: number;
  wordC: number;
}

export function parseFont(b: Uint8Array): Font {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let version = '';
  for (let i = 0; i < 4 && b[i] !== 0; i++) version += String.fromCharCode(b[i]!);
  return { bytes: b, version, word4: dv.getUint32(4, true), height: dv.getUint32(8, true), wordC: dv.getUint32(0xc, true) };
}

/** Where glyph ch starts: font + [font + 0x10 + ch * 4]. */
export function glyphOffset(f: Font, ch: number): number {
  const b = f.bytes;
  const o = 0x10 + ch * 4;
  return (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;
}

/** Glyph ch's width, the dword at its start. */
export function glyphWidth(f: Font, ch: number): number {
  const b = f.bytes;
  const o = glyphOffset(f, ch);
  return (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) | 0;
}
