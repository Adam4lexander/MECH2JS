/**
 * Reads a struct out of memory (the EXE image, or a file payload) using its
 * generated schema. Pointers come back as raw addresses; char arrays as
 * strings (to the first NUL); other arrays as number arrays; inline structs
 * recursively. Padding is skipped.
 *
 * @portOnly schema support
 */

import { STRUCTS, type StructName } from '../../generated/structs.gen.ts';
import type { FieldSpec, StructSchema } from './types.ts';

export interface Memory {
  u8(addr: number): number;
  i8(addr: number): number;
  u16(addr: number): number;
  i16(addr: number): number;
  u32(addr: number): number;
  i32(addr: number): number;
}

/** Adapts a byte array (a file payload) to Memory, with address 0 at its start. */
export function bytesMemory(b: Uint8Array): Memory {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return {
    u8: (a) => dv.getUint8(a),
    i8: (a) => dv.getInt8(a),
    u16: (a) => dv.getUint16(a, true),
    i16: (a) => dv.getInt16(a, true),
    u32: (a) => dv.getUint32(a, true),
    i32: (a) => dv.getInt32(a, true),
  };
}

export function schemaOf(name: string): StructSchema {
  const s = (STRUCTS as Record<string, StructSchema>)[name];
  if (!s) throw new Error(`no schema for struct ${name}`);
  return s;
}

function readScalar(mem: Memory, f: FieldSpec, a: number): number {
  switch (f.kind) {
    case 'int':
      return mem.i32(a);
    case 'uint':
    case 'ptr':
      return mem.u32(a);
    case 'short':
      return mem.i16(a);
    case 'ushort':
      return mem.u16(a);
    case 'byte':
    case 'pad':
      return mem.u8(a);
    case 'sbyte':
      return mem.i8(a);
    case 'char':
      return mem.i8(a);
    default:
      throw new Error(`readScalar: ${f.kind}`);
  }
}

function readField(mem: Memory, f: FieldSpec, base: number): unknown {
  const a0 = base + f.offset;
  if (f.kind === 'char' && f.count > 1) {
    let s = '';
    for (let i = 0; i < f.count; i++) {
      const c = mem.u8(a0 + i);
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s;
  }
  if (f.kind === 'struct') {
    const inner = schemaOf(f.target!);
    if (f.count === 1) return readSchema(mem, inner, a0);
    return Array.from({ length: f.count }, (_, i) => readSchema(mem, inner, a0 + i * f.size));
  }
  if (f.count === 1) return readScalar(mem, f, a0);
  return Array.from({ length: f.count }, (_, i) => readScalar(mem, f, a0 + i * f.size));
}

export function readSchema(mem: Memory, schema: StructSchema, addr: number): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const f of schema.fields) {
    if (f.kind === 'pad') continue;
    o[f.name] = readField(mem, f, addr);
  }
  return o;
}

/** Typed convenience over readSchema for a named struct. */
export function readStruct<T>(mem: Memory, name: StructName, addr: number): T {
  return readSchema(mem, schemaOf(name), addr) as T;
}

/** count consecutive records starting at addr. */
export function readArray<T>(mem: Memory, name: StructName, addr: number, count: number): T[] {
  const s = schemaOf(name);
  return Array.from({ length: count }, (_, i) => readSchema(mem, s, addr + i * s.size) as T);
}
