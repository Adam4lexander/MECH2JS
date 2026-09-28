/**
 * TMPackDataBaseObj: the shell's archive container - DATABASE.MW2 (screens,
 * music, samples, fonts, shapes), ARCHWO.MW2 and ARCHJF.MW2 (the Clan
 * archive pages and pictures). MW2SHELL.EXE's mpack_db module
 * (decompiled/mw2shell/src/archive/mpack_db.c).
 *
 *   int32 count; int32 offset[count]
 *   items are addressed 1..count; an item's size is the next offset minus its
 *   own, the last runs to the end of the file.
 *
 * The container does not say which items are LZSS-packed: the caller picks
 * mpackDbGetItem (stored bytes) or mpackDbGetItemUnpacked.
 *
 * The original reads through a FILE*; the port holds the archive's bytes.
 */
import { unestablished } from '../../core/provenance.ts';

export interface MPackEntry {
  offset: number;
  size: number;
}

/** @portOnly the open archive: the C struct's path, file and {offset, size} collection */
export interface MPackDb {
  path: string;
  bytes: Uint8Array;
  count: number;
  entries: MPackEntry[];
}

/**
 * Reads the item count and offsets and derives each item's size from the
 * next offset (the last from the file length).
 *
 * @mw2shell mpack_db_open 0x00021810
 * @fidelity exact
 * @divergence takes the archive's bytes rather than fopen-ing the path (a missing archive is the host's error)
 */
export function mpackDbOpen(path: string, bytes: Uint8Array): MPackDb {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = dv.getInt32(0, true);
  const entries: MPackEntry[] = [];
  for (let i = 0; i < count; i++) entries.push({ offset: dv.getInt32(4 + i * 4, true), size: 0 });
  for (let i = 1; i < count; i++) entries[i - 1]!.size = entries[i]!.offset - entries[i - 1]!.offset;
  if (count > 0) entries[count - 1]!.size = bytes.length - entries[count - 1]!.offset;
  return { path, bytes, count, entries };
}

/** The entry for id (1-based), or null - the bounds test every reader makes. */
function entryOf(db: MPackDb, id: number): MPackEntry | null {
  if (db.entries.length < id || id < 0) return null;
  if (id === 0) {
    // passes the test, then asks the collection for element -1
    unestablished('mpack_db: id 0 passes the bounds test and reads collection element -1', 'mpack_db_get_item');
    return null;
  }
  return db.entries[id - 1]!;
}

/**
 * The item's stored bytes, or null for an id outside the archive (the
 * original returns 1).
 *
 * @mw2shell mpack_db_get_item 0x00021a30
 * @fidelity exact
 */
export function mpackDbGetItem(db: MPackDb, id: number): Uint8Array | null {
  const e = entryOf(db, id);
  if (!e) return null;
  return db.bytes.slice(e.offset, e.offset + e.size);
}

/**
 * The item unpacked: an int32 unpacked size, then LZSS through a 4096-byte
 * window cleared to 0 and written from position 0. Flag bytes are read LSB
 * first; a 1 bit is a literal byte, a 0 bit a little-endian word whose low 12
 * bits are an absolute window position and whose high 4 bits are length - 3.
 * It stops once the unpacked size is used up (a final match may overrun it:
 * the original's malloc is the unpacked size, the port's buffer is sized for
 * the overrun and trimmed).
 *
 * @mw2shell mpack_db_get_item_unpacked 0x00021ad0
 * @fidelity exact
 */
export function mpackDbGetItemUnpacked(db: MPackDb, id: number): Uint8Array | null {
  const e = entryOf(db, id);
  if (!e) return null;
  return lzssUnpack(db.bytes, e.offset).data;
}

/**
 * The LZSS body of mpack_db_get_item_unpacked, over a byte buffer. Returns
 * the data and how many stored bytes it consumed (dump_mpack.py uses that
 * to tell packed items from raw ones).
 *
 * @portOnly the decoder loop of mpack_db_get_item_unpacked, reading from memory
 */
export function lzssUnpack(src: Uint8Array, at: number, end = src.length): { data: Uint8Array; consumed: number } {
  const dv = new DataView(src.buffer, src.byteOffset, src.byteLength);
  const size = dv.getInt32(at, true);
  // a raw item read as LZSS runs off its end: a RangeError rather than a read of the next item
  if (size > (end - at) * 9) throw new RangeError('LZSS size larger than the data could hold');
  let pos = at + 4;
  const byte = () => {
    if (pos >= end) throw new RangeError('LZSS data runs past its end');
    return src[pos++]!;
  };
  const window = new Uint8Array(0x1000);
  let w = 0;
  // a match can run up to 17 bytes past the declared size
  const out = new Uint8Array(Math.max(0, size) + 18);
  let o = 0;
  let flags = 2;
  let remaining = size;
  while (remaining > 0) {
    flags >>>= 1;
    if (flags === 1) flags = byte() | 0x100;
    if (flags & 1) {
      const b = byte();
      remaining--;
      window[w] = b;
      w = (w + 1) & 0xfff;
      out[o++] = b;
    } else {
      const lo = byte();
      const word = lo | (byte() << 8);
      const n = ((word >> 12) & 0xf) + 3;
      let s = word & 0xfff;
      remaining -= n;
      for (let k = 0; k < n; k++) {
        const b = window[s]!;
        s = (s + 1) & 0xfff;
        window[w] = b;
        w = (w + 1) & 0xfff;
        out[o++] = b;
      }
    }
  }
  return { data: out.slice(0, Math.max(0, size)), consumed: pos - at };
}

/**
 * Copies `count` bytes from the item's offset + `offset`, or null for a bad
 * id.
 *
 * @mw2shell mpack_db_read_at 0x00021cf0
 * @fidelity exact
 */
export function mpackDbReadAt(db: MPackDb, id: number, offset: number, count: number): Uint8Array | null {
  const e = entryOf(db, id);
  if (!e) return null;
  const p = e.offset + offset;
  return db.bytes.slice(p, p + count);
}

/**
 * Reads from the item's offset + `offset` up to a '\n' or a NUL. `stop` is
 * 2 when it stopped at a NUL, 0 at a newline; null for a bad id.
 *
 * @mw2shell mpack_db_read_line 0x00021d50
 * @fidelity exact
 */
export function mpackDbReadLine(db: MPackDb, id: number, offset: number): { text: string; stop: 0 | 2 } | null {
  const e = entryOf(db, id);
  if (!e) return null;
  let p = e.offset + offset;
  let s = '';
  for (;;) {
    if (p >= db.bytes.length) {
      // fgetc at the end of the file returns EOF (-1): its low byte is neither '\n' nor NUL, so the original runs off the buffer
      unestablished('mpack_db_read_line: the file ends before a newline or NUL', 'mpack_db_read_line');
      return { text: s, stop: 0 };
    }
    const c = db.bytes[p++]!;
    if (c === 10) return { text: s, stop: 0 };
    if (c === 0) return { text: s, stop: 2 };
    s += String.fromCharCode(c);
  }
}

/**
 * Like mpackDbReadLine, but stops only at a NUL.
 *
 * @mw2shell mpack_db_read_string 0x00021de0
 * @fidelity exact
 */
export function mpackDbReadString(db: MPackDb, id: number, offset: number): string | null {
  const e = entryOf(db, id);
  if (!e) return null;
  let p = e.offset + offset;
  let s = '';
  while (p < db.bytes.length && db.bytes[p] !== 0) s += String.fromCharCode(db.bytes[p++]!);
  return s;
}
