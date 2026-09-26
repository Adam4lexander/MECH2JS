/**
 * Fills a live struct object from bytes in memory (the EXE image's
 * initialised data), field by field through its schema. Pointer fields are
 * left alone - an address in the image means nothing to the port - and are
 * the caller's to wire up.
 *
 * @portOnly
 */
import type { Memory } from './read.ts';
import { schemaOf } from './read.ts';

type Live = Record<string, unknown>;

export function assignFromMemory(live: object, structName: string, mem: Memory, addr: number): void {
  const s = schemaOf(structName);
  const o = live as Live;
  for (const f of s.fields) {
    if (f.kind === 'pad' || f.kind === 'ptr') continue;
    const a = addr + f.offset;
    const read = (at: number): number => {
      switch (f.kind) {
        case 'int':
          return mem.i32(at);
        case 'uint':
          return mem.u32(at);
        case 'short':
          return mem.i16(at);
        case 'ushort':
          return mem.u16(at);
        case 'sbyte':
        case 'char':
          return mem.i8(at);
        default:
          return mem.u8(at);
      }
    };
    if (f.kind === 'struct') {
      if (f.count === 1) assignFromMemory(o[f.name] as object, f.target!, mem, a);
      else (o[f.name] as object[]).forEach((x, i) => assignFromMemory(x, f.target!, mem, a + i * f.size));
    } else if (f.kind === 'char' && f.count > 1) {
      let str = '';
      for (let i = 0; i < f.count; i++) {
        const c = mem.u8(a + i);
        if (c === 0) break;
        str += String.fromCharCode(c);
      }
      o[f.name] = str;
    } else if (f.count > 1) {
      const arr = o[f.name] as { [i: number]: number; length: number };
      for (let i = 0; i < f.count; i++) arr[i] = read(a + i * f.size);
    } else {
      o[f.name] = read(a);
    }
  }
}
