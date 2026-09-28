/**
 * MW2SHELL.EXE's static memory: a writable copy of its loaded image (code,
 * initialised data and zero-filled BSS, 0x10000..), reset from the EXE each
 * time the shell "process" starts.
 *
 * The shell is mostly a file editor - the pilot registry, the two star
 * records, mw2prm.cfg's block, the BWD build buffer - and writes those
 * globals to disk with a single fwrite of the struct. Its strings are C
 * strings copied over earlier, longer ones, so the files carry the residue
 * (mw2prm.cfg holds "ADAM\0\0EX\0or" in a pilot name). Keeping these globals
 * as bytes at their own addresses reproduces the files exactly, and lets the
 * shell's static tables (chassisTable, formationNames...) be read where the
 * image has them, pointers and all. Heap data stays JS objects.
 *
 * Field offsets come from the generated schemas (fieldOffset), never from
 * numbers typed in by hand.
 *
 * @portOnly the process's data segment
 */
import { STRUCTS } from '../generated/shell/structs.gen.ts';
import type { ExeImage } from '../data/exe/ExeImage.ts';
import type { StructSchema } from '../engine/schema/types.ts';
import { registerGlobals } from '../engine/globals.ts';
import { bootImage } from '../engine/image.ts';

export class ShellMemory {
  readonly low: number;
  readonly bytes: Uint8Array;
  private readonly dv: DataView;

  constructor(low: number, bytes: Uint8Array) {
    this.low = low;
    this.bytes = bytes;
    this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  static fromImage(img: ExeImage): ShellMemory {
    return new ShellMemory(img.low, img.bytes.slice());
  }

  private at(addr: number, len: number): number {
    const o = addr - this.low;
    if (o < 0 || o + len > this.bytes.length) throw new RangeError(`shell address 0x${(addr >>> 0).toString(16)} outside its image`);
    return o;
  }

  u8(a: number): number {
    return this.bytes[this.at(a, 1)]!;
  }
  i8(a: number): number {
    return this.dv.getInt8(this.at(a, 1));
  }
  u16(a: number): number {
    return this.dv.getUint16(this.at(a, 2), true);
  }
  i16(a: number): number {
    return this.dv.getInt16(this.at(a, 2), true);
  }
  i32(a: number): number {
    return this.dv.getInt32(this.at(a, 4), true);
  }
  u32(a: number): number {
    return this.dv.getUint32(this.at(a, 4), true);
  }
  setU8(a: number, v: number): void {
    this.bytes[this.at(a, 1)] = v;
  }
  setI16(a: number, v: number): void {
    this.dv.setInt16(this.at(a, 2), v, true);
  }
  setI32(a: number, v: number): void {
    this.dv.setInt32(this.at(a, 4), v | 0, true);
  }

  /** `n` bytes at `a`, as a live view (writes go through) */
  view(a: number, n: number): Uint8Array {
    const o = this.at(a, n);
    return this.bytes.subarray(o, o + n);
  }

  /** memcpy(dst, src, n); overlapping copies behave as memmove */
  copy(dst: number, src: number, n: number): void {
    this.bytes.copyWithin(this.at(dst, n), this.at(src, n), this.at(src, n) + n);
  }

  fill(a: number, v: number, n: number): void {
    this.view(a, n).fill(v);
  }

  /** the C string at `a` (Latin-1), up to its NUL or `max` bytes */
  cstr(a: number, max = 0x10000): string {
    let s = '';
    for (let i = 0; i < max; i++) {
      const c = this.u8(a + i);
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s;
  }

  /** strcpy(dst, s): the characters and the NUL; the bytes after it are left as they were */
  strcpy(a: number, s: string): void {
    for (let i = 0; i < s.length; i++) this.setU8(a + i, s.charCodeAt(i) & 0xff);
    this.setU8(a + s.length, 0);
  }

  /** strcat(dst, s) */
  strcat(a: number, s: string): void {
    this.strcpy(a + this.cstr(a).length, s);
  }

  /** strncpy(dst, s, n): at most n characters, NUL-padded to n when s is shorter */
  strncpy(a: number, s: string, n: number): void {
    for (let i = 0; i < n; i++) this.setU8(a + i, i < s.length ? s.charCodeAt(i) & 0xff : 0);
  }

  /** the C string a pointer at `a` points to, or null for a NULL pointer */
  ptrStr(a: number): string | null {
    const p = this.u32(a);
    return p === 0 ? null : this.cstr(p);
  }
}

/** The byte offset of `field` (dotted for nested structs, with [i] for arrays) in a shell struct. */
export function fieldOffset(struct: keyof typeof STRUCTS, path: string): number {
  let s: StructSchema = STRUCTS[struct];
  let off = 0;
  for (const part of path.split('.')) {
    const m = /^(\w+)(?:\[(\d+)\])?$/.exec(part);
    if (!m) throw new Error(`fieldOffset: bad path ${path}`);
    const f = s.fields.find((x) => x.name === m[1]);
    if (!f) throw new Error(`fieldOffset: ${s.name} has no field ${m[1]}`);
    off += f.offset + (m[2] ? Number(m[2]) * f.size : 0);
    if (f.kind === 'struct') s = (STRUCTS as Record<string, StructSchema>)[f.target!]!;
  }
  return off;
}

/** The size of a shell struct. */
export function structSize(struct: keyof typeof STRUCTS): number {
  return STRUCTS[struct].size;
}

export const shellMemory = registerGlobals(
  'memory',
  {
    /** the shell's image, writable; null until MW2SHELL.EXE is loaded */
    mem: null as ShellMemory | null,
  },
  () => {
    const img = bootImage('mw2shell');
    shellMemory.mem = img ? ShellMemory.fromImage(img) : null;
  },
  'mw2shell',
);

/** @portOnly the shell's memory; fails before MW2SHELL.EXE's image is loaded */
export function mem(): ShellMemory {
  const m = shellMemory.mem;
  if (!m) throw new Error('MW2SHELL.EXE is not loaded (setBootImage(img, "mw2shell") and resetAllGlobals("mw2shell"))');
  return m;
}
