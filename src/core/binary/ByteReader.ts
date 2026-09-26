/**
 * Little-endian cursor over a byte buffer, for parsing the game's files and
 * its executable image. Strings are Latin-1 (DOS code page bytes map 1:1 to
 * U+0000..U+00FF, so no byte is lost).
 *
 * @portOnly file-format support
 */

export class ByteReader {
  readonly bytes: Uint8Array;
  readonly view: DataView;
  pos: number;

  constructor(src: ArrayBuffer | Uint8Array, pos = 0) {
    this.bytes = src instanceof Uint8Array ? src : new Uint8Array(src);
    this.view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
    this.pos = pos;
  }

  get length(): number {
    return this.bytes.length;
  }
  get remaining(): number {
    return this.bytes.length - this.pos;
  }
  eof(): boolean {
    return this.pos >= this.bytes.length;
  }
  seek(pos: number): this {
    this.pos = pos;
    return this;
  }
  skip(n: number): this {
    this.pos += n;
    return this;
  }

  private need(n: number): void {
    if (this.pos + n > this.bytes.length) {
      throw new RangeError(`read of ${n} bytes at ${this.pos} past end (${this.bytes.length})`);
    }
  }

  u8(): number {
    this.need(1);
    return this.bytes[this.pos++]!;
  }
  i8(): number {
    this.need(1);
    return this.view.getInt8(this.pos++);
  }
  u16(): number {
    this.need(2);
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }
  i16(): number {
    this.need(2);
    const v = this.view.getInt16(this.pos, true);
    this.pos += 2;
    return v;
  }
  u32(): number {
    this.need(4);
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }
  i32(): number {
    this.need(4);
    const v = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }
  f64(): number {
    this.need(8);
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }
  bytesN(n: number): Uint8Array {
    this.need(n);
    const b = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return b;
  }
  /** Four-character tag, as the game compares them (bytes in file order). */
  tag4(): string {
    return latin1(this.bytesN(4));
  }
  /** Fixed-width field holding a NUL-terminated string. */
  fixedStr(n: number): string {
    return cstr(this.bytesN(n));
  }
  /** NUL-terminated string at the cursor; the cursor moves past the NUL. */
  cstr(): string {
    const start = this.pos;
    while (this.pos < this.bytes.length && this.bytes[this.pos] !== 0) this.pos++;
    const s = latin1(this.bytes.subarray(start, this.pos));
    if (this.pos < this.bytes.length) this.pos++;
    return s;
  }
  /** A new reader over [pos, pos+n) with its own cursor at 0. */
  sub(n: number): ByteReader {
    return new ByteReader(this.bytesN(n));
  }

  // Random access without moving the cursor.
  u8At(o: number): number {
    return this.bytes[o]!;
  }
  u16At(o: number): number {
    return this.view.getUint16(o, true);
  }
  i16At(o: number): number {
    return this.view.getInt16(o, true);
  }
  u32At(o: number): number {
    return this.view.getUint32(o, true);
  }
  i32At(o: number): number {
    return this.view.getInt32(o, true);
  }
}

export function latin1(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]!);
  return s;
}

/** Bytes up to the first NUL, as Latin-1. */
export function cstr(b: Uint8Array): string {
  const z = b.indexOf(0);
  return latin1(z < 0 ? b : b.subarray(0, z));
}
