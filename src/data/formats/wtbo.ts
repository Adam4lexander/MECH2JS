/**
 * WTBO mesh records - the payload of a POLY resource is a run of them back to
 * back. This is the parse half of poly_load_wtbo_record: it reads a record
 * into plain arrays and verifies the checksum exactly as the loader does. The
 * build half (mesh_add_vertex / mesh_add_polygon into a WorldObject, the part
 * and LOD modes) lives in engine/scene/wtboLoader.ts.
 *
 *   +0x00  'WTBO' (0x4f425457)
 *   +0x04  checksum
 *   +0x08  name[16]; if byte 0 > 0x80 every byte is negated (c -> -c)
 *   +0x18  short vertexCount
 *   +0x1a  short polygonCount
 *   +0x1c  ushort flags: 0x2000 part mode, 0x1000 LOD mode (both latch for the
 *          rest of a block); low bits (& 0xcfff) set flags nothing reads
 *   +0x20  vertices, 0x10 bytes: int x, y, z; short texU, texV
 *   then   polygons, 0xc bytes (or 0x12 when count >= 5): ushort code,
 *          ushort count, then 4 (or 7) ushort index slots
 */

import { cstr } from '../../core/binary/ByteReader.ts';

export const WTBO_MAGIC = 0x4f425457;

export interface WtboPolygon {
  /** the raw polygon code, before poly_resolve_code */
  code: number;
  /** vertex indices, `count` of them */
  indices: number[];
  /** all slots as stored (4 or 7), for the checksum and the editor */
  slots: number[];
}

export interface WtboRecord {
  /** byte offset of the record within its POLY payload */
  offset: number;
  /** byte length of the record */
  length: number;
  name: string;
  checksum: number;
  flags: number;
  vertexCount: number;
  polygonCount: number;
  /** x, y, z per vertex (cm, model space, before offset/scale) */
  positions: Int32Array;
  /** texU, texV per vertex (texels) */
  texcoords: Int16Array;
  polygons: WtboPolygon[];
  /** the checksum the loader computes; record is rejected if != checksum */
  computedChecksum: number;
}

export const WTBO_PART_MODE = 0x2000;
export const WTBO_LOD_MODE = 0x1000;

/** Negated-name decode: when byte 0 > 0x80, each of the 16 bytes becomes -c. */
export function decodeWtboName(raw: Uint8Array): string {
  const b = new Uint8Array(raw);
  if (b[0]! > 0x80) for (let i = 0; i < b.length; i++) b[i] = (0x100 - b[i]!) & 0xff;
  return cstr(b);
}

/**
 * Parses the record at `pos`, or returns null if the magic is not there.
 * Reproduces the loader's checksum: C's signed % 0x100000 after each vertex
 * and each polygon, unused index slots up to 4 included.
 *
 * @portOnly the parse half of poly_load_wtbo_record (0x4fef0); the build half is ported in engine/scene/wtboLoader.ts
 */
export function parseWtboRecord(c: Uint8Array, pos: number): WtboRecord | null {
  if (pos + 0x20 > c.length) return null;
  const dv = new DataView(c.buffer, c.byteOffset, c.byteLength);
  if (dv.getUint32(pos, true) !== WTBO_MAGIC) return null;
  const checksum = dv.getInt32(pos + 4, true);
  const name = decodeWtboName(c.subarray(pos + 8, pos + 0x18));
  const nv = dv.getInt16(pos + 0x18, true);
  const np = dv.getInt16(pos + 0x1a, true);
  const flags = dv.getUint16(pos + 0x1c, true);
  const positions = new Int32Array(Math.max(0, nv) * 3);
  const texcoords = new Int16Array(Math.max(0, nv) * 2);
  let s = 0;
  let p = pos + 0x20;
  for (let i = 0; i < nv; i++) {
    const x = dv.getInt32(p, true);
    const y = dv.getInt32(p + 4, true);
    const z = dv.getInt32(p + 8, true);
    const u = dv.getInt16(p + 12, true);
    const v = dv.getInt16(p + 14, true);
    positions[i * 3] = x;
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = z;
    texcoords[i * 2] = u;
    texcoords[i * 2 + 1] = v;
    s = ((s + x + y + z + u + v) | 0) % 0x100000;
    p += 0x10;
  }
  const polygons: WtboPolygon[] = [];
  for (let i = 0; i < np; i++) {
    const code = dv.getUint16(p, true);
    const count = dv.getUint16(p + 2, true);
    const size = count < 5 ? 0xc : 0x12;
    const slots: number[] = [];
    for (let k = 0; k < (size - 4) / 2; k++) slots.push(dv.getUint16(p + 4 + k * 2, true));
    for (let k = 0; k < count; k++) s += slots[k] ?? 0;
    for (let k = count; k < 4; k++) s += slots[k]!;
    s = ((s + count + code) | 0) % 0x100000;
    polygons.push({ code, indices: slots.slice(0, count), slots });
    p += size;
  }
  return { offset: pos, length: p - pos, name, checksum, flags, vertexCount: nv, polygonCount: np, positions, texcoords, polygons, computedChecksum: s };
}

/** Every record in a POLY payload, in order, and the bytes left after the last. */
export function parseWtboBlock(c: Uint8Array): { records: WtboRecord[]; trailing: number } {
  const records: WtboRecord[] = [];
  let pos = 0;
  for (;;) {
    const r = parseWtboRecord(c, pos);
    if (!r) break;
    records.push(r);
    pos += r.length;
  }
  return { records, trailing: c.length - pos };
}

/** The LOD key: the number after '_' in a 0x1000 record's name (object_draw_lod_mesh's switch distance). */
export function wtboLodKey(name: string): number {
  const i = name.indexOf('_');
  if (i < 0) return 0;
  const m = /^\d+/.exec(name.slice(i + 1));
  return m ? Number(m[0]) : 0;
}
