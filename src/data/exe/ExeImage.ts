/**
 * Read access to MW2.EXE's memory image at the game's own linear addresses
 * (the image starts at 0x10000). Every static table the port reads from the
 * executable is addressed exactly as the decompilation names it.
 *
 * @portOnly executable loader
 */

import { cstr, latin1 } from '../../core/binary/ByteReader.ts';
import { unpackLe, type UnpackedImage } from './leImage.ts';

export class ExeImage {
  readonly low: number;
  readonly high: number;
  readonly bytes: Uint8Array;
  private readonly dv: DataView;

  constructor(readonly image: UnpackedImage) {
    this.low = image.low;
    this.high = image.high;
    this.bytes = image.bytes;
    this.dv = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
  }

  static fromExe(exe: Uint8Array): ExeImage {
    return new ExeImage(unpackLe(exe));
  }

  contains(addr: number, len = 1): boolean {
    return addr >= this.low && addr + len <= this.high;
  }
  private at(addr: number, len: number): number {
    if (!this.contains(addr, len)) throw new RangeError(`address 0x${addr.toString(16)} outside image`);
    return addr - this.low;
  }

  u8(addr: number): number {
    return this.bytes[this.at(addr, 1)]!;
  }
  i8(addr: number): number {
    return this.dv.getInt8(this.at(addr, 1));
  }
  u16(addr: number): number {
    return this.dv.getUint16(this.at(addr, 2), true);
  }
  i16(addr: number): number {
    return this.dv.getInt16(this.at(addr, 2), true);
  }
  u32(addr: number): number {
    return this.dv.getUint32(this.at(addr, 4), true);
  }
  i32(addr: number): number {
    return this.dv.getInt32(this.at(addr, 4), true);
  }
  f64(addr: number): number {
    return this.dv.getFloat64(this.at(addr, 8), true);
  }
  slice(addr: number, len: number): Uint8Array {
    const o = this.at(addr, len);
    return this.bytes.subarray(o, o + len);
  }
  /** NUL-terminated string starting exactly at addr (an address taken from a reference, never from scanning). */
  cstrAt(addr: number, max = 4096): string {
    const o = this.at(addr, 1);
    return cstr(this.bytes.subarray(o, Math.min(o + max, this.bytes.length)));
  }
  latin1(addr: number, len: number): string {
    return latin1(this.slice(addr, len));
  }
  /** A string pointer: 0 reads as null. */
  strPtr(addr: number): string | null {
    const p = this.u32(addr);
    return p === 0 ? null : this.cstrAt(p);
  }
}
