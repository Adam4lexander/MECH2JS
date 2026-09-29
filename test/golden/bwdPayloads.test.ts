// The BWD payload decoders (src/data/bwd/payloads) over every named BWD
// stream in MW2.PRJ: every MTBL string ends inside its field, and STAR and
// FTBL decode to the shapes their loaders accept.
import { beforeAll, describe, expect, it } from 'vitest';
import { ProjectFile } from '../../src/data/prj/ProjectFile.ts';
import { decodeMtbl, MTBL_RECORDS_AT, MTBL_RECORD_SIZE } from '../../src/data/bwd/payloads/mtbl.ts';
import { decodeStar } from '../../src/data/bwd/payloads/star.ts';
import { decodeFtbl } from '../../src/data/bwd/payloads/ftbl.ts';
import { gameSource, hasGameData } from '../support/env.ts';
import { namedStreams, type NamedStream } from '../support/bwdHelpers.ts';

describe.runIf(hasGameData)('BWD chunk payloads', () => {
  let prj: ProjectFile;
  let streams: NamedStream[];

  beforeAll(async () => {
    prj = new ProjectFile(await gameSource().read('MW2.PRJ'));
    streams = namedStreams(prj);
  });

  it('every MTBL string ends inside its field (the installer copies them unbounded)', () => {
    let strings = 0;
    const overruns: string[] = [];
    const field = (s: NamedStream, c: { bytes: Uint8Array }, o: number, n: number, what: string) => {
      strings++;
      if (!c.bytes.subarray(o, o + n).includes(0)) overruns.push(`${s.name} +0x${o.toString(16)} ${what}`);
    };
    for (const s of streams)
      for (const c of s.chunks) {
        if (c.tag !== 'MTBL' || c.size < MTBL_RECORDS_AT) continue;
        field(s, c, 0x12, 11, 'successSound');
        field(s, c, 0x1d, 9, 'failureSound');
        const n = decodeMtbl(c).records.length;
        for (let i = 0; i < n; i++) {
          const o = MTBL_RECORDS_AT + i * MTBL_RECORD_SIZE;
          field(s, c, o + 0x34, 11, 'successSound');
          field(s, c, o + 0x3f, 11, 'failureSound');
          field(s, c, o + 0x4a, 9, 'targetStreamName');
          field(s, c, o + 0x57, 64, 'text');
        }
      }
    expect(strings).toBeGreaterThan(0);
    expect(overruns).toEqual([]);
  });

  it('STAR and FTBL decode to the shapes their loaders accept', () => {
    // No listing prints these; this checks the decoders against the loaders'
    // own acceptance rules on every chunk in MW2.PRJ.
    let stars = 0;
    let ftbls = 0;
    for (const s of streams)
      for (const c of s.chunks) {
        if (c.tag === 'STAR') {
          stars++;
          const d = decodeStar(c);
          expect((c.size - 8) % 0x18, `${s.name} STAR size`).toBe(0);
          expect(d.groups.length).toBeGreaterThan(0);
          for (const g of d.groups) expect(g.formation.length, `${s.name} STAR formation name`).toBeGreaterThan(0);
        } else if (c.tag === 'FTBL') {
          ftbls++;
          const d = decodeFtbl(c);
          expect(d.slots.length, `${s.name} FTBL ${d.name}`).toBe(5);
          expect(d.name.length).toBeGreaterThan(0);
        }
      }
    expect(stars).toBeGreaterThan(0);
    expect(ftbls).toBeGreaterThan(0);
  });
});
