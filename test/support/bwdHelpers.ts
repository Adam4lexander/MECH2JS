/**
 * Helpers for the tests that walk MW2.PRJ's BWD streams: every named stream
 * (a resource whose record header names it), and a type's names by id.
 */
import type { ProjectFile } from '../../src/data/prj/ProjectFile.ts';
import { type Chunk, walkStream } from '../../src/data/bwd/stream.ts';

export interface NamedStream {
  rid: number;
  name: string;
  bytes: Uint8Array;
  chunks: Chunk[];
}

/** Every BWD resource with a record-header name, in id order, walked with project_next_chunk. */
export function namedStreams(prj: ProjectFile): NamedStream[] {
  const out: NamedStream[] = [];
  const bwd = prj.type('BWD');
  if (!bwd) return out;
  for (let rid = 0; rid < bwd.entries.length; rid++) {
    const name = prj.resourceName('BWD', rid);
    if (!name) continue;
    const bytes = prj.readResource('BWD', rid);
    if (!bytes) continue;
    out.push({ rid, name, bytes, chunks: [...walkStream(bytes, name)] });
  }
  return out;
}

/** One type's resource names: id -> record-header name. */
export function resourceNames(prj: ProjectFile, tag: string): Map<number, string> {
  const m = new Map<number, string>();
  const t = prj.type(tag);
  if (!t) return m;
  for (let id = 0; id < t.entries.length; id++) {
    const n = prj.resourceName(tag, id);
    if (n) m.set(id, n);
  }
  return m;
}
