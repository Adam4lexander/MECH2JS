// The game CD's file system (MECH2_16B.BIN, track 1) read through the port's
// ISO 9660 reader, a byte range at a time. Files the install copied off the
// CD are compared byte for byte, so a reader that handed back the wrong
// extent would fail here, not just one that miscounted.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { IsoImage, RawSectorSource, isoCleanName } from '../../src/data/formats/iso9660.ts';
import { hasCdImage, MW2_ROOT } from '../support/env.ts';
import { fileRangeReader, openCdImage, readCdCue } from '../support/cdImage.ts';

if (!hasCdImage) console.warn(`[golden] SKIPPING iso9660: no MECH2_16B.BIN + MECH2_16B.CUE under MW2_ROOT=${MW2_ROOT}`);

describe.runIf(hasCdImage)('game CD (ISO 9660)', () => {
  it('reads the primary volume descriptor; the volume fills track 1 exactly', async () => {
    const iso = await openCdImage();
    expect(iso.volume.volumeId).toBe('MECH2_16B');
    expect(iso.volume.logicalBlockSize).toBe(2048);
    // track 2 (audio) starts after a 2 s pregap: its INDEX 01 minus 150 sectors is track 1's end
    const cue = readCdCue();
    const t2 = cue.tracks.find((t) => t.number === 2)!;
    expect(iso.volume.volumeSpaceSize).toBe(t2.start / 2352 - 150);
    expect(iso.root.directory).toBe(true);
  });

  it('lists the root', async () => {
    const iso = await openCdImage();
    const root = (await iso.readDir(iso.root)).map((e) => (e.directory ? `${e.name}/` : `${e.name} ${e.size}`));
    expect(root).toEqual([
      'BINMOD.EXE 9114',
      'CFGS/',
      'CPU.EXE 5802',
      'DEMODATA/',
      'ENGLISH.LRM 4234',
      'FIXBOOT.EXE 29376',
      'GIDDI/',
      'INSTALL.EXE 258323',
      'INWIN.EXE 5984',
      'KEATING/',
      'LAUNCH/',
      'MECH2/',
      'MW2REG.EXE 137272',
      'OLD_HERC.DRV 264',
      'README.TXT 781',
      'REGISTER.BAT 349',
      'SETSOUND.EXE 168741',
      'SMK/',
      'SND/',
      'VESACHK.EXE 9574',
      'VFX/',
    ]);
  });

  it('walks the tree: one level of directories, and no two extents overlap', async () => {
    const iso = await openCdImage();
    const all = await iso.walk();
    const dirs = new Map<string, { files: number; bytes: number }>();
    for (const { path: p, entry } of all) {
      if (entry.directory) {
        expect(p).not.toContain('/');
        continue;
      }
      const d = p.includes('/') ? p.slice(0, p.indexOf('/')) : '';
      const s = dirs.get(d) ?? { files: 0, bytes: 0 };
      s.files++;
      s.bytes += entry.size;
      dirs.set(d, s);
    }
    expect(Object.fromEntries([...dirs].map(([d, s]) => [d, `${s.files} files, ${s.bytes} bytes`]))).toEqual({
      '': '12 files, 629814 bytes',
      CFGS: '4 files, 11348 bytes',
      DEMODATA: '37 files, 688439 bytes',
      GIDDI: '27 files, 101927 bytes',
      KEATING: '51 files, 2601568 bytes',
      LAUNCH: '75 files, 8159360 bytes',
      MECH2: '32 files, 28071932 bytes',
      SMK: '247 files, 72946244 bytes',
      SND: '33 files, 742387 bytes',
      VFX: '6 files, 177885 bytes',
    });
    const extents = all
      .map(({ entry }) => ({ from: entry.lba, to: entry.lba + Math.ceil(entry.size / 2048) }))
      .filter((e) => e.to > e.from)
      .sort((a, b) => a.from - b.from);
    for (let i = 0; i < extents.length; i++) {
      expect(extents[i]!.to).toBeLessThanOrEqual(i + 1 < extents.length ? extents[i + 1]!.from : iso.volume.volumeSpaceSize);
    }
  });

  it('finds every file under SMK, case-insensitively', async () => {
    const iso = await openCdImage();
    const smk = await iso.list('smk');
    const ext = (n: string) => n.slice(n.lastIndexOf('.') + 1);
    expect(smk.filter((e) => ext(e.name) === 'SMK').length).toBe(140);
    expect(smk.filter((e) => ext(e.name) === 'SHP').length).toBe(107);
    expect(smk.every((e) => !e.directory && e.rawName.endsWith(';1'))).toBe(true);
    for (const e of smk) {
      const lower = await iso.lookup(`smk/${e.name.toLowerCase()}`);
      const raw = await iso.lookup(`\\SMK\\${e.rawName}`);
      expect(lower).toEqual(e);
      expect(raw).toEqual(e);
    }
    expect(await iso.lookup('SMK/NOSUCH.SMK')).toBeNull();
    expect(await iso.lookup('NOSUCH/MINTRO.SMK')).toBeNull();
    expect(await iso.lookup('SMK/MINTRO.SMK/X')).toBeNull();
    expect(isoCleanName('README.;1')).toBe('README');
  });

  it('reads files byte-identical to the copies the install took from the CD', async () => {
    const iso = await openCdImage();
    let compared = 0;
    for (const dir of ['DEMODATA', 'GIDDI', '']) {
      const entries = await iso.readDir(dir ? (await iso.lookup(dir))! : iso.root);
      for (const e of entries) {
        if (e.directory) continue;
        const local = path.join(MW2_ROOT, dir, e.name);
        if (!fs.existsSync(local) || /\.(CPC|CFG)$/i.test(e.name)) continue; // the player's control configs change after install
        const want = new Uint8Array(fs.readFileSync(local));
        const got = await iso.readFile(e);
        expect(got.length, e.name).toBe(want.length);
        expect(Buffer.compare(Buffer.from(got), Buffer.from(want)), `${dir}/${e.name}`).toBe(0);
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(40);
    // a partial read lands on the same bytes
    const e = (await iso.lookup('DEMODATA/AMWLOGO1.SMK'))!;
    const whole = await iso.readFile(e);
    expect(Array.from(await iso.readFile(e, 3000, 5000))).toEqual(Array.from(whole.subarray(3000, 8000)));
  });

  it('reads through a fresh image with one range request per directory and file', async () => {
    const cue = readCdCue();
    const r = fileRangeReader(cue.file);
    const iso = await IsoImage.open(new RawSectorSource(r.read, cue.tracks[0]!.start));
    const before = r.reads.n;
    await iso.read('SMK/AMWLOGO1.SMK');
    await iso.read('smk/amwlogo1.smk');
    // root, SMK, then the file twice (directories are cached, files are not)
    expect(r.reads.n - before).toBe(4);
  });
});
