// Structural checks on every PAL, LUMA and CEL resource. There is no dump-tool
// listing for these, so the checks are the ones that would fail if the layout
// were misread: sizes tile exactly, and LUMA's identity row sits at level 15.
import { beforeAll, describe, expect, it } from 'vitest';
import { ProjectFile } from '../../src/data/prj/ProjectFile.ts';
import { parseCel, parseLuma, parsePal } from '../../src/data/formats/image.ts';
import { gameSource, hasGameData } from '../support/env.ts';

describe.runIf(hasGameData)('image resources', () => {
  let prj: ProjectFile;
  beforeAll(async () => {
    prj = new ProjectFile(await gameSource().read('MW2.PRJ'));
  });

  it('every PAL is exactly 256 RGB triples of 6-bit DAC values', () => {
    const pals = prj.list('PAL');
    expect(pals.length).toBe(116);
    for (const r of pals) {
      expect(r.size).toBe(768);
      const { rgb } = parsePal(prj.readResource('PAL', r.id)!);
      // 6-bit VGA DAC values: nothing above 63 in any palette
      expect(Math.max(...rgb)).toBeLessThanOrEqual(63);
    }
  });

  it('every LUMA is 16x256 with the identity at level 15', () => {
    const lumas = prj.list('LUMA');
    expect(lumas.map((l) => l.name)).toEqual(['FOG', 'STANDARD', 'TRAINING']);
    for (const r of lumas) {
      const { rows } = parseLuma(prj.readResource('LUMA', r.id)!);
      for (let i = 0; i < 256; i++) expect(rows[15 * 256 + i]).toBe(i);
    }
  });

  it('every CEL is exactly 4 + width*height bytes', () => {
    const cels = prj.list('CEL');
    expect(cels.length).toBe(747);
    for (const r of cels) {
      const c = parseCel(prj.readResource('CEL', r.id)!);
      expect(4 + c.width * c.height).toBe(r.size);
    }
  });
});
