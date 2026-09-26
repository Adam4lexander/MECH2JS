// Every ANIM resource in MW2.PRJ parsed by the port, printed the way
// tools/dump_anims.py prints it (tracks, then each frame's bytes and its
// flags read as anim_player_step reads them), compared with listing/anims.txt.
import { beforeAll, describe, expect, it } from 'vitest';
import { ProjectFile } from '../../src/data/prj/ProjectFile.ts';
import { animLoaderAccepts, parseAnim, type AnimFrameRecord } from '../../src/data/formats/anim.ts';
import { gameSource, hasDecompiled, hasGameData, readListing } from '../support/env.ts';
import { expectSameLines, lines, padL, padR } from '../support/listing.ts';

const CHANNEL: Record<number, string> = { 0: 'move x', 1: 'move y', 2: 'move z', 3: 'pitch', 4: 'yaw', 5: 'roll' };
const hex2 = (v: number) => v.toString(16).padStart(2, '0');

/** dump_anims.decode_frame */
function decodeFrame(f: AnimFrameRecord): string[] {
  const b0 = f.flags;
  const b1 = f.flags2;
  const [a0, a1, a2, a3] = f.args;
  const parts: string[] = [];
  if (b0 & 0x01) parts.push(`LABEL ${a0}`);
  if (b0 & 0x02) parts.push('loop-start');
  if (b0 & 0x04) {
    const lst: number[] = [];
    for (const x of f.args) {
      if (x === -1) break;
      lst.push(x);
    }
    parts.push(`loop-unless-target-in [${lst.join(', ')}]`);
  }
  if (b0 & 0x08) parts.push('loop');
  if (b0 & 0x10) parts.push('event');
  if (b0 & 0x40) parts.push(`goto ${a1} if target==${a1}`);
  if (b0 & 0x80) parts.push(`goto ${a1} on new target`);
  if (b1 & 0x01) parts.push(`goto ${a2} if no target`);
  if (b1 & 0x02) parts.push(`ENTRY from ${a3}`);
  if (b1 & 0x04) parts.push('END');
  if (b1 & 0x08) parts.push('step-sound');
  const other0 = b0 & ~0xdf & 0xff;
  const other1 = b1 & ~0x0f & 0xff;
  if (other0 || other1) parts.push(`unknown bits ${hex2(other0)}/${hex2(other1)}`);
  return parts;
}

describe.runIf(hasGameData && hasDecompiled)('ANIM resources', () => {
  let prj: ProjectFile;
  beforeAll(async () => {
    prj = new ProjectFile(await gameSource().read('MW2.PRJ'));
  });

  it('anims.txt corresponds', () => {
    const L: string[] = [];
    let nres = 0;
    let misfit = 0;
    let badref = 0;
    let refused = 0;
    const t = prj.type('ANIM')!;
    for (let id = 0; id < t.entries.length; id++) {
      const name = prj.resourceName('ANIM', id);
      if (!name) continue;
      const c = prj.readResource('ANIM', id)!;
      nres++;
      const a = parseAnim(c);
      if (!a.fits) misfit++;
      L.push(`${name} (ANIM ${id})  ${a.trackCount} tracks, ${a.frameCount} frames${a.fits ? '' : '  LAYOUT DOES NOT FIT'}`);
      if (!a.fits) {
        L.push('');
        continue;
      }
      // with a track base of 0 (anim_track_base's value is runtime state)
      if (!animLoaderAccepts(a, 0)) refused++;
      for (const tr of a.tracks) {
        L.push(`  track ${padL(tr.slot, 2)}  ${padR(CHANNEL[tr.channel] ?? `ch${tr.channel}`, 6)} ${Array.from(tr.values).join(' ')}`);
      }
      const labels = new Set<number>();
      const refs = new Set<number>();
      a.frames.forEach((fr, i) => {
        if (fr.flags & 0x01) labels.add(fr.args[0]);
        if (fr.flags & 0xc0) refs.add(fr.args[1]);
        if (fr.flags2 & 0x01) refs.add(fr.args[2]);
        L.push(`  frame ${padL(i, 2)}  ${Array.from(fr.raw, hex2).join(' ')}  ${decodeFrame(fr).join(', ')}`);
      });
      const missing = [...refs].filter((r) => !labels.has(r)).sort((x, y) => x - y);
      if (missing.length) {
        badref++;
        L.push(`  TRANSITION TARGETS WITHOUT A LABEL: [${missing.join(', ')}]`);
      }
      L.push('');
    }
    L.unshift(`MW2 animations - MW2.PRJ, ${nres} ANIM resources, ${misfit} layout misfits, ${badref} with unlabelled targets`, '');
    expect(refused).toBe(0);
    expectSameLines('anims.txt', lines(readListing('anims.txt')), L);
  });
});
