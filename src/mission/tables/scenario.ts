/**
 * The scenario table (STBL, keyword scenario_table): one table of 12-byte
 * records after an 8-byte header, each record a stream name. An INCL whose
 * by-name reference starts with '^' takes the next of these names
 * (project_item_apply), so the list is consumed in order across a load.
 *
 * MW2.PRJ has no STBL chunk and no '^' reference (the golden test checks);
 * the mechanism is ported for completeness.
 */
import { udiv } from '../../core/int/cint.ts';
import type { Chunk } from '../../data/bwd/stream.ts';
import { LABEL } from '../../generated/labels.gen.ts';
import { registerGlobals } from '../../engine/globals.ts';
import { imageI32 } from '../../engine/image.ts';

export const scenario = registerGlobals(
  'scenario',
  {
    /** 0x9eb6c: a copy of the whole STBL chunk, header and all, or null */
    scenarioTable: null as Uint8Array | null,
    /** 0x1538d8: (size - 8) / 0xc records */
    scenarioTableCount: 0,
    /** 0x9eb74: the next record project_item_apply takes */
    scenarioTableIndex: 0,
  },
  () => {
    scenario.scenarioTable = null;
    scenario.scenarioTableCount = imageI32(LABEL.scenarioTableCount, 0);
    scenario.scenarioTableIndex = imageI32(LABEL.scenarioTableIndex, 0);
  },
);

/**
 * STBL: replaces the scenario table with a copy of the chunk and rewinds the
 * index. Returns 1 (the original's allocation can fail: system_error 0x3f
 * and 0).
 *
 * @mw2 scenario_table_load 0x0004d7f0
 * @fidelity exact
 */
export function scenarioTableLoad(c: Chunk): number {
  const s = scenario;
  s.scenarioTable = null; // free
  s.scenarioTableCount = 0;
  s.scenarioTableIndex = 0;
  // cache_alloc(size) then a rep movsd of `size` bytes from the chunk
  const copy = new Uint8Array(c.size >>> 0);
  copy.set(c.bytes.subarray(0, Math.min(c.bytes.length, copy.length)));
  s.scenarioTable = copy;
  s.scenarioTableCount = udiv((c.size - 8) >>> 0, 0xc) | 0;
  return 1;
}
