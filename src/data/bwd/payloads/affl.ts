/**
 * AFFL (keyword affiliation, tag 61): project_chunk_exec keeps the dword at
 * +0x08 in a local (started at -1 for each interpreter run) and the GT branch
 * copies it into GameThing.affiliation - the index into affiliationAllegiance
 * that gamething_allegiance reads, negative meaning none.
 */
import type { Chunk } from '../stream.ts';

export interface AfflChunk {
  /** +0x08 the affiliation every following GT in this run gets */
  affiliation: number;
}

/**
 * Reads an AFFL chunk.
 *
 * @portOnly the read half of project_chunk_exec's AFFL branch
 */
export function decodeAffl(c: Chunk): AfflChunk {
  return { affiliation: c.i32(0x08) };
}
