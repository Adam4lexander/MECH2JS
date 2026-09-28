// The shell's archives read by the port, printed in dump_mpack.py's exact
// format and compared line by line with the decompilation's listings.
import { describe, expect, it } from 'vitest';
import { lzssUnpack, mpackDbOpen } from '../../src/data/formats/mpack.ts';
import { expectSameLines, lines } from '../support/listing.ts';
import { gameSource, hasShellData, hasShellDecompiled, readShellListing } from '../support/env.ts';

function kind(b: Uint8Array): string {
  const s = (n: number) => String.fromCharCode(...b.subarray(0, n));
  if (b[0] === 0x0a && (b[1] === 5 || b[1] === 3) && b[3] === 8) return 'PCX';
  if (s(4) === 'FORM') return 'XMIDI/IFF';
  if (s(4) === 'RIFF') return 'RIFF';
  if (s(2) === 'MZ') return 'MZ executable';
  if (b[0] === 0x31 && b[1] === 0x2e && b[2] === 0 && b[3] === 0) return 'VFX font';
  if (s(4) === '1.10') return 'VFX shapes';
  if (b[0] === 0 && b[1] === 1) return 'archive page';
  return `? ${JSON.stringify(s(4))}`;
}

const pad = (v: string | number, n: number) => String(v).padStart(n);

function listing(file: string, bytes: Uint8Array): string[] {
  const db = mpackDbOpen(file, bytes);
  const L = [`# ${file}: ${db.count} items (ids 1..${db.count})`, '#  id    offset    stored  storage  unpacked  kind'];
  db.entries.forEach((e, i) => {
    let blob = bytes.subarray(e.offset, e.offset + e.size);
    let storage = 'raw';
    let unpacked = e.size;
    try {
      const u = lzssUnpack(bytes, e.offset, e.offset + e.size);
      if (u.consumed === e.size && u.data.length > 0) {
        blob = u.data;
        storage = 'lzss';
        unpacked = u.data.length;
      }
    } catch {
      /* not LZSS */
    }
    L.push(`${pad(i + 1, 4)}  ${pad(e.offset, 8)}  ${pad(e.size, 8)}  ${storage.padEnd(7)}  ${pad(unpacked, 8)}  ${kind(blob)}`);
  });
  return L;
}

describe.runIf(hasShellData && hasShellDecompiled)('mpack archives', () => {
  for (const [file, name] of [
    ['DATABASE.MW2', 'mpack_database.txt'],
    ['ARCHWO.MW2', 'mpack_archwo.txt'],
    ['ARCHJF.MW2', 'mpack_archjf.txt'],
  ] as const) {
    it(`${file} matches listing/${name}`, async () => {
      const bytes = await gameSource().read(file);
      const want = lines(readShellListing(name));
      expectSameLines(name, want, listing(file, bytes));
      expect(want.length).toBeGreaterThan(10);
    });
  }
});
