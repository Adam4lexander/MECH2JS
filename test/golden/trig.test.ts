// sinTable / atanTable, rebuilt by the port's mathBuildTrigTables, against
// listing/trig_tables.txt (tools/dump_trig_tables.py) row by row.
import { describe, it } from 'vitest';
import { atanTable, sinTable } from '../../src/core/angle/trig.ts';
import { hasDecompiled, readListing } from '../support/env.ts';
import { expectSameLines, lines, padL, pyHex } from '../support/listing.ts';

describe.runIf(hasDecompiled)('trig tables vs listing/trig_tables.txt', () => {
  it('every row of both tables corresponds', () => {
    const all = lines(readListing('trig_tables.txt'));
    const start = all.findIndex((l) => l.startsWith('  i   sinTable'));
    const want = all.slice(start + 1, start + 1 + 256).map((l) => l.replace(/ {3}CHECK$/, ''));
    const got: string[] = [];
    for (let i = 0; i < 256; i++) {
      const s = sinTable[i]!;
      const t = atanTable[i]!;
      got.push(`${padL(i, 3)}   ${padL(s, 10)}  ${pyHex(s, 10)}   ${padL(t, 9)}  ${pyHex(t, 8)}  ${padL((t / 65536).toFixed(4), 8)} deg`);
    }
    expectSameLines('trig_tables', want, got);
  });
});
