/**
 * The game CD image (MECH2_16B.BIN / .CUE) for tests: an IsoImage over its
 * data track, read from disk a byte range at a time as the browser reads it
 * over HTTP.
 */
import fs from 'node:fs';
import path from 'node:path';
import { IsoImage, RawSectorSource } from '../../src/data/formats/iso9660.ts';
import { parseCue, type CueSheet } from '../../src/data/formats/cue.ts';
import { MW2_ROOT } from './env.ts';

export function readCdCue(): CueSheet {
  const sheet = parseCue(fs.readFileSync(path.join(MW2_ROOT, 'MECH2_16B.CUE'), 'latin1'));
  if (!sheet) throw new Error('MECH2_16B.CUE: no tracks');
  return sheet;
}

/** fs-backed byte ranges of a file under MW2_ROOT; `reads` counts the calls. */
export function fileRangeReader(name: string): { read: (offset: number, length: number) => Promise<Uint8Array>; reads: { n: number; bytes: number } } {
  const fd = fs.openSync(path.join(MW2_ROOT, name), 'r');
  const reads = { n: 0, bytes: 0 };
  return {
    reads,
    read: async (offset, length) => {
      const b = new Uint8Array(length);
      const got = fs.readSync(fd, b, 0, length, offset);
      reads.n++;
      reads.bytes += got;
      return b.subarray(0, got);
    },
  };
}

let cached: Promise<IsoImage> | null = null;

/** The CD's ISO 9660 volume (track 1, MODE1/2352), opened once per test file. */
export function openCdImage(): Promise<IsoImage> {
  if (!cached) {
    const sheet = readCdCue();
    const t1 = sheet.tracks.find((t) => t.number === 1)!;
    cached = IsoImage.open(new RawSectorSource(fileRangeReader(sheet.file).read, t1.start));
  }
  return cached;
}

/** FNV-1a over byte arrays, as 8 hex digits. */
export function fnv1a(...parts: Uint8Array[]): string {
  let h = 0x811c9dc5;
  for (const p of parts) for (let i = 0; i < p.length; i++) h = Math.imul(h ^ p[i]!, 0x01000193) >>> 0;
  return h.toString(16).padStart(8, '0');
}
