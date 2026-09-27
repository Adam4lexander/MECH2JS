/**
 * The PCX pictures in DATABASE.MW2 (the shell's screens), as VFX's PCX
 * routines read them in MW2SHELL.EXE: 8-bit, RLE, the 256-colour palette in
 * the file's last 0x300 bytes.
 *
 *   +0x04 xmin, +0x06 ymin, +0x08 xmax, +0x0a ymax (shorts)
 *   +0x42 bytes per line
 *   +0x80 the RLE data: a byte with its top two bits set is a count (low 6
 *         bits) for the byte after it; any other byte is itself
 */

/** A decoded picture: rows of `bytesPerLine` palette indices. */
export interface PcxImage {
  width: number;
  height: number;
  bytesPerLine: number;
  pixels: Uint8Array;
}

/**
 * The palette in the file's last 0x300 bytes, shifted down to the VGA DAC's
 * 6 bits.
 *
 * @mw2shell vfx_lib_sub_047f25 0x00047f25
 * @fidelity exact
 */
export function pcxPalette(pcx: Uint8Array, out: Uint8Array): void {
  const at = pcx.length - 0x300;
  for (let i = 0; i < 0x300; i++) out[i] = pcx[at + i]! >> 2;
}

/**
 * The RLE rows, each decoded into a line buffer of bytesPerLine and handed
 * to the row copier; ymax - ymin + 1 rows. A run may overrun the line (the
 * decoder stops at the first byte at or past it and starts the next line
 * there), as the original's line buffer at 0x84ca1 lets it.
 *
 * @mw2shell vfx_lib_sub_047ea3 0x00047ea3
 * @fidelity exact
 */
export function pcxDecode(pcx: Uint8Array): PcxImage {
  const dv = new DataView(pcx.buffer, pcx.byteOffset, pcx.byteLength);
  const ymax = dv.getInt16(10, true);
  const ymin = dv.getInt16(6, true);
  const xmax = dv.getInt16(8, true);
  const xmin = dv.getInt16(4, true);
  const bytesPerLine = dv.getUint16(0x42, true);
  const rows = (((ymax - ymin) & 0xffff) >>> 0) + 1;
  const pixels = new Uint8Array(rows * bytesPerLine);
  const line = new Uint8Array(bytesPerLine + 0x40);
  let p = 0x80;
  for (let row = 0; row < rows; row++) {
    let o = 0;
    while (o < bytesPerLine) {
      const b = pcx[p++] ?? 0;
      if ((b & 0xc0) === 0xc0) {
        const v = pcx[p++] ?? 0;
        for (let n = b & 0x3f; n !== 0; n--) line[o++] = v;
      } else line[o++] = b;
    }
    pixels.set(line.subarray(0, bytesPerLine), row * bytesPerLine);
  }
  return { width: xmax - xmin + 1, height: rows, bytesPerLine, pixels };
}
