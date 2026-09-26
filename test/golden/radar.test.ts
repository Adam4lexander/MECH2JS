// The DISP resource RADAR loaded by the port's lx_module_load and read by
// readRadarModule, printed the way tools/dump_radar.py prints it and
// compared with listing/radar.txt - every field of every mode, the shared
// records (transition state, colours, bearing buffer) by the offsets they
// were read from.
import { beforeAll, describe, it } from 'vitest';
import { ExeImage } from '../../src/data/exe/ExeImage.ts';
import { lxModuleLoad } from '../../src/data/exe/tables/menus.ts';
import { ProjectFile } from '../../src/data/prj/ProjectFile.ts';
import type { ViewWindow } from '../../src/generated/classes.gen.ts';
import { readRadarModule } from '../../src/sim/cockpit/radar.ts';
import { gameSource, hasDecompiled, hasGameData, readListing } from '../support/env.ts';
import { expectSameLines, lines } from '../support/listing.ts';

const hex = (v: number) => `0x${(v >>> 0).toString(16)}`;
const pyRepr = (s: string) => (s.includes("'") && !s.includes('"') ? `"${s}"` : `'${s}'`);

describe.runIf(hasGameData && hasDecompiled)('DISP RADAR', () => {
  let prj: ProjectFile;
  let exe: ExeImage;
  beforeAll(async () => {
    const src = gameSource();
    prj = new ProjectFile(await src.read('MW2.PRJ'));
    exe = ExeImage.fromExe(await src.read('MW2.EXE'));
  });

  it('radar.txt corresponds', () => {
    const lx = lxModuleLoad(prj.readResource('DISP', 1)!)!;
    const r = readRadarModule(lx.block, lx.fixups);
    const dv = new DataView(lx.block.buffer, lx.block.byteOffset, lx.block.byteLength);
    const i32 = (o: number) => dv.getInt32(o, true);
    const ptr = (o: number) => (lx.fixups.has(o) ? hex(i32(o)) : i32(o) === 0 ? '-' : `${i32(o)}?`);
    const paneAt = (o: number) => `${hex(o)} {${[0, 4, 8, 12, 16].map((k) => i32(o + k)).join(', ')}}`;
    // the parsed panes must agree with the bytes they came from
    const pane = (o: number, p: ViewWindow) => {
      const s = paneAt(o);
      const mine = `${hex(o)} {${i32(o)}, ${p.left}, ${p.top}, ${p.right}, ${p.bottom}}`;
      return mine === s ? s : `${s} PARSED AS ${mine}`;
    };
    const L: string[] = [
      `MW2 DISP ${prj.resourceName('DISP', 1)} - MW2.PRJ DISP 1, loaded as lx_module_load does, read as radar_mode_install does`,
      `module ${lx.block.length} bytes, ${lx.fixups.size} fixups; root ${hex(r.root)} -> mode table ${hex(r.modesAt)}, aux ${hex(r.auxAt)}`,
      '',
      `aux ${hex(r.auxAt)}: ${r.aux[0]} ${r.aux[1]} ${r.aux[2]} ${ptr(r.auxAt + 12)} ${ptr(r.auxAt + 16)} point {${r.aux[5]}, ${r.aux[6]}} ${r.aux[7]}`,
      'modes: ' + [0, 1, 2, 3, 4, 5].map((m) => `${m} ${ptr(r.modesAt + 4 * m)}`).join('  '),
      '',
    ];
    r.modes.forEach((d, m) => {
      if (!d) return;
      const at = d.at;
      L.push(`mode ${m} at ${hex(at)}`);
      L.push(`  +0x00 pane ${pane(i32(at), d.pane)}`);
      L.push(`  +0x04 save pane ${pane(i32(at + 4), d.savePane)}`);
      L.push(`  +0x08 viewport ${d.viewportIndex}  +0x0c open sound ${d.openSound}  +0x10 close sound ${d.closeSound}`);
      const t = d.transition;
      if (!t) L.push('  +0x14 transition -');
      else {
        L.push(`  +0x14 transition ${hex(t.at.rec)}: state ${hex(t.at.state)} {${t.now}, ${t.before}, ${t.elapsed}} params ${hex(t.at.params)} duration ${t.duration}`);
        L.push(`        from ${pane(i32(t.at.params + 4), t.from)}`);
        L.push(`        to   ${pane(i32(t.at.params + 8), t.to)}`);
        L.push(`        out  ${pane(i32(t.at.params + 12), t.out)}`);
      }
      L.push(
        `  +0x18 range ${d.range}  +0x1c shown ${d.shownRange}  +0x20 default ${d.defaultRange}  +0x24 least ${d.leastRange}  +0x28 most ${d.mostRange}  +0x2c scale ${d.zoomScale}`,
      );
      L.push(`  +0x30 font ${d.fontId}`);
      L.push(`  +0x34 ${hex(d.unread34.at)} ${pyRepr(d.unread34.text)}  +0x38 ${hex(d.unread38.at)}`);
      L.push(`  +0x3c range label ${hex(d.rangeLabel.at)} ${pyRepr(d.rangeLabel.text)}  +0x40 buffer ${hex(d.rangeText.at)}`);
      L.push(`  +0x44 bearing label ${hex(d.bearingLabel.at)} ${pyRepr(d.bearingLabel.text)}  +0x48 buffer ${hex(d.bearingText.at)}  +0x4c shown ${d.shownHeading}`);
      L.push(`  +0x50 metres ${hex(d.metres.at)} ${pyRepr(d.metres.text)}  +0x54 km ${hex(d.km.at)} ${pyRepr(d.km.text)}`);
      const p = d.points;
      L.push(`  +0x58 points {${p[0]}, ${p[1]}} {${p[2]}, ${p[3]}} {${p[4]}, ${p[5]}}`);
      L.push(`  +0x70 shapes ${hex(d.shapesAt)}: ${Array.from(d.shapes).join(' ')}`);
      L.push(`  +0x74 colours ${hex(d.coloursAt)}: ${Array.from(d.colours).join(' ')}`);
      L.push(`  +0x78 anim ${hex(d.animAt)}: ${Array.from(d.anim).join(' ')}`);
      const fns = d.hookIndex.map((k) => exe.u32(0x955c4 + 4 * k));
      L.push(`  +0x7c hooks ${d.hookIndex.join(' ')} -> ${fns.map((a) => (a ? hex(a) : '-')).join(' ')}`);
      L.push('');
    });
    while (L[L.length - 1] === '') L.pop();
    expectSameLines('radar.txt', lines(readListing('radar.txt')), L);
  });
});
