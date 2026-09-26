/**
 * BWD chunk streams - the mission scripts. A stream is IFF-like: a leading
 * 'BWD\0' chunk whose header is a fixed 12 bytes ({tag, streamLength,
 * maxChunkSize}), then chunks of {int tag; int size; payload}, size counting
 * the 8-byte header.
 *
 * ProjectItem is the reader state project_open_stream fills and
 * project_next_chunk advances (mw2_types.h ProjectItem, 28 bytes).
 */

import { cstr, latin1 } from '../../core/binary/ByteReader.ts';
import { systemError } from '../../core/systemError.ts';

export class ProjectItem {
  /** +0x00 1: a cached BWD resource from MW2.PRJ; 0: a loose file */
  cached = 0;
  /** +0x01 the BWD resource id, or -1 for a loose file */
  resourceId = -1;
  /** +0x03 the stream's name, at most 8 characters */
  name = '';
  /** +0x0c from the BWD header */
  streamLength = 0;
  /** +0x10 from the BWD header */
  maxChunkSize = 0;
  /** +0x14 the stream, starting at its BWD chunk */
  base: Uint8Array = new Uint8Array(0);
  /** +0x18 offset of the current chunk from base */
  current = 0;
}

/** One chunk: the view the interpreter reads payload fields through. */
export class Chunk {
  readonly dv: DataView;
  constructor(
    readonly bytes: Uint8Array,
    /** tag with trailing NULs removed: 'OBJ', 'BLK', 'REPR' */
    readonly tag: string,
    /** size including the 8-byte header */
    readonly size: number,
    /** offset in its stream */
    readonly offset: number,
  ) {
    this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  // Offsets are from the chunk start, as the decompiled code writes them
  // (cur + 8 is the first payload byte). Reads past the chunk's end return 0,
  // as reading the next chunk's bytes would in the original only by accident.
  private ok(o: number, n: number): boolean {
    return o >= 0 && o + n <= this.bytes.length;
  }
  u8(o: number): number {
    return this.ok(o, 1) ? this.bytes[o]! : 0;
  }
  i8(o: number): number {
    return this.ok(o, 1) ? this.dv.getInt8(o) : 0;
  }
  i16(o: number): number {
    return this.ok(o, 2) ? this.dv.getInt16(o, true) : 0;
  }
  u16(o: number): number {
    return this.ok(o, 2) ? this.dv.getUint16(o, true) : 0;
  }
  i32(o: number): number {
    return this.ok(o, 4) ? this.dv.getInt32(o, true) : 0;
  }
  u32(o: number): number {
    return this.ok(o, 4) ? this.dv.getUint32(o, true) : 0;
  }
  /** NUL-terminated string at o, at most max bytes (strncpy semantics). */
  str(o: number, max = 256): string {
    if (o >= this.bytes.length) return '';
    return cstr(this.bytes.subarray(o, Math.min(this.bytes.length, o + max)));
  }
  /** A {short id; char name[]} stream reference at o, as INCL/PITF/GPS carry them. */
  ref(o: number): StreamRef {
    return { id: this.i16(o), name: this.str(o + 2, 64) };
  }
}

/** A {short id; char name[]} reference to a stream: id -1 resolves the name, -2 forces a loose file. */
export interface StreamRef {
  id: number;
  name: string;
}

export const tagOf = (bytes: Uint8Array, o: number): string => latin1(bytes.subarray(o, o + 4)).replace(/\0+$/, '');

/**
 * Makes an item over a stream that starts with its BWD chunk; null (and
 * system_error 0x2b) if it does not. The header's second and third dwords are
 * streamLength and maxChunkSize.
 *
 * @portOnly the tail of project_open_stream; the lookup half is engine/resources/streams.ts
 */
export function projectItemFromStream(bytes: Uint8Array, item: ProjectItem): ProjectItem | null {
  if (bytes.length < 12 || tagOf(bytes, 0) !== 'BWD') {
    systemError(0x2b, `${item.name} ID ${item.resourceId}`);
    return null;
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  item.streamLength = dv.getUint32(4, true) | 0;
  item.maxChunkSize = dv.getUint32(8, true) | 0;
  item.base = bytes;
  item.current = 0;
  return item;
}

/**
 * Advances to the next chunk: past a fixed 12 bytes for the BWD lead chunk,
 * otherwise by the current chunk's size. Stops (null) at streamLength; a
 * chunk larger than maxChunkSize or smaller than 8 is system_error 0x2c (a
 * warning) and also ends the walk, the cursor left where it was.
 *
 * @mw2 project_next_chunk 0x0004ba30
 * @fidelity exact
 */
export function projectNextChunk(item: ProjectItem): Chunk | null {
  const b = item.base;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const cur = item.current;
  const next = tagOf(b, cur) === 'BWD' ? 0xc : dv.getUint32(cur + 4, true);
  const at = cur + next;
  if (at >= item.streamLength) return null;
  if (at + 8 > b.length) {
    // The original would read past its buffer here; the shipped data never does.
    systemError(0x2c, `${item.name} ID ${item.resourceId} (chunk header past end of stream)`);
    return null;
  }
  const size = dv.getUint32(at + 4, true);
  if ((size | 0) > item.maxChunkSize || size < 8) {
    systemError(0x2c, `${item.name} ID ${item.resourceId}`);
    return null;
  }
  item.current = at;
  return new Chunk(b.subarray(at, Math.min(b.length, at + size)), tagOf(b, at), size, at);
}

/** Every chunk of a stream in order, as project_next_chunk yields them. @portOnly */
export function* walkStream(bytes: Uint8Array, name = ''): Generator<Chunk> {
  const item = new ProjectItem();
  item.name = name;
  if (!projectItemFromStream(bytes, item)) return;
  for (;;) {
    const c = projectNextChunk(item);
    if (!c) return;
    yield c;
  }
}
