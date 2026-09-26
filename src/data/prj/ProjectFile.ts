/**
 * The .PRJ resource container (MW2.PRJ), read the way project_file.c reads it.
 *
 *   file +0x00   "PROJ"
 *   file +0x0c   the header block (ProjectHeader): length at +4 (so file +0x10),
 *                typeCount at +0xc, then typeCount ProjectTypeEntry of 0x18 bytes
 *   type entry   tag[4], dirOffset, dirSize, 8 unread bytes, recordPrefix (62)
 *   directory    8-byte {start, length} entries from +0x16; slot i is resource
 *                id i (ids are one-based: id 0 is rejected)
 *   record       62-byte DATA header ("DATA", length-8, tag, id at +0x18,
 *                name at +0x1e) then the payload the game reads
 *
 * The whole file is held in memory (20 MB) - the port's stand-in for DOS
 * file handles plus the resource cache.
 */

import { cstr, latin1 } from '../../core/binary/ByteReader.ts';

export interface ProjectType {
  index: number;
  tag: string;
  dirOffset: number;
  dirSize: number;
  recordPrefix: number;
  /** directory entries: [start, length] per slot (slot 0 included) */
  entries: Array<[number, number]>;
}

export interface ResourceInfo {
  tag: string;
  id: number;
  /** from the DATA record header; '' when absent */
  name: string;
  size: number;
}

export class ProjectFile {
  readonly bytes: Uint8Array;
  readonly dv: DataView;
  readonly headerLength: number;
  readonly types: ProjectType[] = [];
  private readonly typeByTag = new Map<string, ProjectType>();

  /**
   * @mw2 project_file_open 0x0004a380
   * @fidelity partial
   * @divergence reads from an in-memory buffer; only mode 0 (the one project_open uses)
   */
  constructor(bytes: Uint8Array, readonly fileName = 'MW2.PRJ') {
    this.bytes = bytes;
    this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (latin1(bytes.subarray(0, 4)) !== 'PROJ') throw new Error(`${fileName}: not a PROJ container`);
    this.headerLength = this.dv.getUint32(0x10, true) + 8;
    const hdr = 0xc;
    const count = this.dv.getUint16(hdr + 0xc, true);
    for (let i = 0; i < count; i++) {
      const e = hdr + 0xe + i * 0x18;
      const t: ProjectType = {
        index: i,
        tag: latin1(bytes.subarray(e, e + 4)).replace(/\0+$/, ''),
        dirOffset: this.dv.getUint32(e + 4, true),
        dirSize: this.dv.getUint32(e + 8, true),
        recordPrefix: this.dv.getUint16(e + 0x14, true),
        entries: [],
      };
      this.types.push(t);
      this.typeByTag.set(t.tag, t);
    }
    this.loadDirectories();
  }

  /**
   * @mw2 project_load_directories 0x0004a710
   * @fidelity exact
   */
  private loadDirectories(): void {
    for (const t of this.types) {
      if (t.dirOffset === 0) continue;
      const n = Math.max(0, Math.floor((t.dirSize - 0x16) / 8));
      for (let j = 0; j < n; j++) {
        const o = t.dirOffset + 0x16 + j * 8;
        t.entries.push([this.dv.getUint32(o, true), this.dv.getUint32(o + 4, true)]);
      }
    }
  }

  /**
   * Index of a type tag, or -1. Tags shorter than 4 characters are NUL-padded
   * in the file ("MEK\0", "HUD\0"); pass them without the padding.
   *
   * @mw2 project_find_type 0x0004a670
   * @fidelity exact
   */
  findType(tag: string): number {
    return this.typeByTag.get(tag)?.index ?? -1;
  }

  type(tag: string): ProjectType | undefined {
    return this.typeByTag.get(tag);
  }

  /**
   * Payload byte count of (tag, id), or -1 if the type is unknown or id is 0.
   *
   * @mw2 project_resource_size 0x0004a820
   * @fidelity exact
   */
  resourceSize(tag: string, id: number): number {
    id &= 0xffff;
    if (id === 0) return -1;
    const t = this.typeByTag.get(tag);
    if (!t) return -1;
    const e = t.entries[id];
    if (!e) return 0; // the original reads past the directory; nothing in the game asks for one
    const n = (e[1] | 0) - t.recordPrefix;
    return n > 0 ? n : 0;
  }

  /**
   * The payload of (tag, id) as a view into the container, or null.
   *
   * @mw2 project_read_resource 0x0004aa30
   * @fidelity partial
   * @divergence returns a view instead of copying into a caller's buffer
   */
  readResource(tag: string, id: number): Uint8Array | null {
    const size = this.resourceSize(tag, id);
    if (size <= 0) return null;
    const t = this.typeByTag.get(tag)!;
    const start = t.entries[id & 0xffff]![0] + t.recordPrefix;
    if (start + size > this.bytes.length) return null;
    return this.bytes.subarray(start, start + size);
  }

  /**
   * The record header's name for (tag, id), checked the way
   * dump_project_index.read_names checks it (magic, length, id). '' when the
   * header does not check out.
   *
   * @portOnly the game never reads the record header; the editor does
   */
  resourceName(tag: string, id: number): string {
    const t = this.typeByTag.get(tag);
    const e = t?.entries[id];
    if (!t || !e) return '';
    const [start, length] = e;
    if (start === 0 || length <= t.recordPrefix || start + length > this.bytes.length) return '';
    const h = this.bytes.subarray(start, start + t.recordPrefix);
    if (latin1(h.subarray(0, 4)) !== 'DATA') return '';
    if (this.dv.getUint32(start + 4, true) !== length - 8 || this.dv.getUint16(start + 0x18, true) !== id) return '';
    const name = cstr(h.subarray(0x1e, 0x1e + 16));
    return /^[\x20-\x7e]+$/.test(name) ? name : '';
  }

  /** Every non-empty resource of a type. @portOnly */
  list(tag: string): ResourceInfo[] {
    const t = this.typeByTag.get(tag);
    if (!t) return [];
    const out: ResourceInfo[] = [];
    for (let id = 1; id < t.entries.length; id++) {
      const size = this.resourceSize(tag, id);
      if (size > 0) out.push({ tag, id, name: this.resourceName(tag, id), size });
    }
    return out;
  }
}

/** TABL resource numbers: one name index per resource type (resource_id_by_name's `table`). */
export const TABL = {
  GEO: 1,
  ANIM: 2,
  CPT: 3,
  HUD: 4,
  MGD: 5,
  MEK: 6,
  PAL: 7,
  MAP: 8,
  XYC: 9,
  SHP: 10,
  SND: 11,
  MUS: 12,
  LUM: 13,
  BWD: 14,
} as const;

/**
 * Resolves a resource NAME to its id through TABL resource `table`: count at
 * +8, 12-byte entries from +0xc, a 10-byte BYTE-NEGATED name (0x100 - c) then
 * a short id at +0xa, compared case-insensitively. Returns -1 if absent.
 *
 * @mw2 resource_id_by_name 0x00034480
 * @fidelity exact
 */
export function resourceIdByName(prj: ProjectFile, table: number, name: string): number {
  const t = prj.readResource('TABL', table);
  if (!t) return -1;
  const dv = new DataView(t.buffer, t.byteOffset, t.byteLength);
  const count = dv.getInt16(8, true);
  const want = name.toLowerCase();
  for (let i = 0; i < count; i++) {
    const o = 0xc + i * 12;
    let s = '';
    for (let k = 0; k < 10; k++) {
      const c = (0x100 - t[o + k]!) & 0xff;
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    if (s.toLowerCase() === want) return dv.getInt16(o + 0xa, true);
  }
  return -1;
}

/** Every (name, id) pair of a TABL index, in file order. @portOnly */
export function readNameTable(prj: ProjectFile, table: number): Array<{ name: string; id: number }> {
  const t = prj.readResource('TABL', table);
  if (!t) return [];
  const dv = new DataView(t.buffer, t.byteOffset, t.byteLength);
  const count = dv.getInt16(8, true);
  const out: Array<{ name: string; id: number }> = [];
  for (let i = 0; i < count; i++) {
    const o = 0xc + i * 12;
    let s = '';
    for (let k = 0; k < 10; k++) {
      const c = (0x100 - t[o + k]!) & 0xff;
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    out.push({ name: s, id: dv.getInt16(o + 0xa, true) });
  }
  return out;
}
