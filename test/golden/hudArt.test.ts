// The HUD's art: every SHP shape table and FONT in MW2.PRJ parsed and decoded
// by the port, printed the way tools/dump_shapes.py and tools/dump_fonts.py
// print them, compared with listing/shapes.txt and listing/fonts.txt. The
// per-shape CRC covers the decoded raster, so a row decoded wrongly fails.
import { beforeAll, describe, it } from 'vitest';
import { ProjectFile } from '../../src/data/prj/ProjectFile.ts';
import { parseShapeTable, walkShape } from '../../src/data/formats/shp.ts';
import { glyphOffset, glyphWidth, parseFont } from '../../src/data/formats/font.ts';
import { gameSource, hasDecompiled, hasGameData, readListing } from '../support/env.ts';
import { expectSameLines, lines, padL, padR } from '../support/listing.ts';
import { crc32, hex8 } from '../support/crc32.ts';

const hex = (v: number) => (v >>> 0).toString(16);

describe.runIf(hasGameData && hasDecompiled)('HUD art', () => {
  let prj: ProjectFile;
  beforeAll(async () => {
    prj = new ProjectFile(await gameSource().read('MW2.PRJ'));
  });

  it('shapes.txt corresponds', () => {
    const L: string[] = [];
    const problems: string[] = [];
    let tables = 0;
    let shapes = 0;
    let negmin = 0;
    const t = prj.type('SHP')!;
    for (let id = 0; id < t.entries.length; id++) {
      const data = prj.readResource('SHP', id);
      if (!data) continue;
      const name = prj.resourceName('SHP', id);
      const st = parseShapeTable(data);
      tables++;
      const count = st.shapes.length;
      L.push(`${padL(id, 4)} ${padR(name, 9)} ${padL(data.length, 6)} bytes  version ${st.version}  ${count} shape${count === 1 ? '' : 's'}`);
      st.shapes.forEach((s, n) => {
        shapes++;
        const w = s.xmax - s.xmin + 1;
        const h = s.ymax - s.ymin + 1;
        const raster = new Uint8Array(w * h * 2);
        let drawn = 0;
        const problem = walkShape(st, n, (row, x, c, run, src, at) => {
          for (let i = 0; i < c; i++) {
            const o = (row * w + x + i) * 2;
            raster[o] = 1;
            raster[o + 1] = run ? src[at]! : src[at + i]!;
          }
          drawn += c;
        });
        if (s.origin === ((((-s.xmin) & 0xffff) << 16) | ((-s.ymin) & 0xffff)) >>> 0) negmin++;
        L.push(
          `       shape ${n} at 0x${hex(s.offset)} (+0xc 0x${hex(s.tableWord)}): x ${s.xmin}..${s.xmax}  y ${s.ymin}..${s.ymax}  ${w}x${h}` +
            `  +0 ${hex8(s.word0)}  +4 ${hex8(s.origin)}  drawn ${drawn}  crc ${hex8(crc32(raster))}${problem ? `  PROBLEM: ${problem}` : ''}`,
        );
        if (problem) problems.push(`${id} ${name} shape ${n}: ${problem}`);
      });
    }
    const head = [
      'MW2 SHP shape tables - MW2.PRJ',
      `${tables} tables, ${shapes} shapes, ${problems.length} problems`,
      `${negmin} shapes have +4 == (-xmin) << 16 | (-ymin)`,
      '',
      'crc: CRC-32 of the decoded raster, two bytes per pixel - (1, colour) drawn, (0, 0) not',
      '',
    ];
    const out = [...head, ...L, ...(problems.length ? ['', 'PROBLEMS', ...problems] : [])];
    expectSameLines('shapes.txt', lines(readListing('shapes.txt')), out);
  });

  it('fonts.txt corresponds', () => {
    const L: string[] = [];
    let fonts = 0;
    let glyphs = 0;
    const problems: string[] = [];
    const t = prj.type('FONT')!;
    for (let id = 0; id < t.entries.length; id++) {
      const data = prj.readResource('FONT', id);
      if (!data) continue;
      const name = prj.resourceName('FONT', id);
      const f = parseFont(data);
      fonts++;
      L.push(`${id} ${name}  ${data.length} bytes  version ${f.version}  +4 ${f.word4}  height ${f.height}  +0xc 0x${hex(f.wordC)}`);
      let first = 0x10;
      if (f.word4) {
        first = Infinity;
        for (let i = 0; i < f.word4; i++) first = Math.min(first, glyphOffset(f, i));
      }
      const count = (first - 0x10) >> 2;
      for (let ch = 0; ch < count; ch++) {
        const at = glyphOffset(f, ch);
        const width = glyphWidth(f, ch);
        const px = data.subarray(at + 4, at + 4 + width * f.height);
        let problem = '';
        if (px.length !== width * f.height) {
          problem = 'glyph runs past the end';
          problems.push(`${id} ${name} ch ${ch}: ${problem}`);
        }
        glyphs++;
        const shown = ch >= 0x21 && ch < 0x7f ? String.fromCharCode(ch) : '  ';
        L.push(`  ${padL(ch, 3)} ${shown}  at 0x${hex(at).padStart(4, '0')}  width ${padL(width, 2)}  crc ${hex8(crc32(px))}${problem ? `  PROBLEM: ${problem}` : ''}`);
      }
    }
    const head = [
      'MW2 FONT resources - MW2.PRJ',
      `${fonts} fonts, ${glyphs} glyphs, ${problems.length} problems`,
      '',
      "glyphs: as many as the offset table holds before the first glyph; crc: CRC-32 of the",
      "glyph's width * height bytes as stored",
      '',
    ];
    const out = [...head, ...L, ...(problems.length ? ['', 'PROBLEMS', ...problems] : [])];
    expectSameLines('fonts.txt', lines(readListing('fonts.txt')), out);
  });
});
