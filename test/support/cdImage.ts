/**
 * The game CD image (MECH2_16B.BIN / .CUE) for tests: an IsoImage over its
 * data track, read from disk a byte range at a time as the browser reads it
 * over HTTP. And the CD drive either way (openCd): over the image, or over
 * the CD's files copied into the install (a ripped CD).
 */
import fs from 'node:fs';
import path from 'node:path';
import { IsoImage, RawSectorSource } from '../../src/data/formats/iso9660.ts';
import { parseCue, type CueSheet } from '../../src/data/formats/cue.ts';
import type { CdDrive } from '../../src/engine/dosFiles.ts';
import { hasCdImage, MW2_ROOT } from './env.ts';

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

/** The file under MW2_ROOT at a CD path ('KEATING/TRN1_01S.SFL'), ignoring case, or null. */
function installPath(rel: string): string | null {
  let cur = MW2_ROOT;
  for (const seg of rel.split('/').filter((x) => x !== '')) {
    const hit = fs.existsSync(cur) && fs.statSync(cur).isDirectory() ? fs.readdirSync(cur).find((e) => e.toLowerCase() === seg.toLowerCase()) : undefined;
    if (!hit) return null;
    cur = path.join(cur, hit);
  }
  return cur;
}

/** Drive D: as the app mounts it (app/shell/cdDrive.ts): the image when there is one, else the CD's files in the install. */
export async function openCd(): Promise<CdDrive> {
  if (hasCdImage) {
    const iso = await openCdImage();
    return {
      letter: 'D',
      read: async (p) => ((await iso.exists(p)) ? iso.read(p) : null),
      list: async (dir) => {
        const e = await iso.lookup(dir);
        return e && e.directory ? (await iso.readDir(e)).filter((c) => !c.directory && c.name !== '.' && c.name !== '..').map((c) => c.name) : null;
      },
    };
  }
  return {
    letter: 'D',
    read: async (p) => {
      const f = installPath(p);
      return f && fs.statSync(f).isFile() ? new Uint8Array(fs.readFileSync(f)) : null;
    },
    list: async (dir) => {
      const d = installPath(dir);
      return d && fs.statSync(d).isDirectory() ? fs.readdirSync(d).filter((n) => fs.statSync(path.join(d, n)).isFile()).map((n) => n.toUpperCase()) : null;
    },
  };
}

/** FNV-1a over byte arrays, as 8 hex digits. */
export function fnv1a(...parts: Uint8Array[]): string {
  let h = 0x811c9dc5;
  for (const p of parts) for (let i = 0; i < p.length; i++) h = Math.imul(h ^ p[i]!, 0x01000193) >>> 0;
  return h.toString(16).padStart(8, '0');
}
