// Every Smacker file MechWarrior 2 ships - DEMODATA\AMWLOGO1.SMK in the
// install and the 140 under SMK\ on the CD - decoded to the end by the
// port's decoder. With no reference decoder to hand, correctness is checked
// by the format's own redundancy:
//   - each Huffman tree's header size is exactly (entries + 3 cache slots) * 4,
//     and the four trees fit their declared byte count;
//   - every frame's block runs cover width * height / 16 blocks exactly, and
//     its video bitstream ends in the frame's last 4 bytes (frames are padded
//     to 4), never past it;
//   - every audio chunk unpacks to the size it declares, within the header's
//     maximum, its bitstream likewise ending in its last 4 bytes, and each
//     movie's audio lasts as long as its frames;
//   - palette chunks use their length (up to the padding).
// A decoder that misread a tree, a block type or a run length would lose
// sync and fail these within a frame. FNV-1a digests of the decoded output
// then pin the result against regressions.
import { describe, expect, it } from 'vitest';
import { parseSmacker, SmackerDecoder, smackerFrameDurationUs, type SmackerHeader } from '../../src/data/formats/smacker.ts';
import { gameSource, hasCdImage, hasShellData, hasShellDecompiled, MW2_ROOT, readShellListing } from '../support/env.ts';
import { fnv1a, openCdImage } from '../support/cdImage.ts';

if (!hasCdImage) console.warn(`[golden] SKIPPING smacker CD suites: no MECH2_16B.BIN + MECH2_16B.CUE under MW2_ROOT=${MW2_ROOT}`);
if (!hasShellData) console.warn(`[golden] SKIPPING smacker AMWLOGO1 suite: no front end under MW2_ROOT=${MW2_ROOT}`);

interface MovieCheck {
  header: SmackerHeader;
  frames: number;
  /** FNV-1a over every frame's pixels and palette */
  digest: string;
  /** per listed frame, FNV-1a of pixels + palette */
  frameDigests: Map<number, string>;
  audioSamples: number;
}

/** Decodes every frame, asserting the consistency checks above. */
function checkMovie(name: string, bytes: Uint8Array, keep: readonly number[] = []): MovieCheck {
  const d = new SmackerDecoder(bytes);
  const h = d.header;
  expect(h.dataEnd, `${name}: frames end at the file's end`).toBe(bytes.length);
  // a tree of one leaf is sized as two entries
  for (const t of d.trees) expect(Math.max(t.entries, t.present ? 2 : 0) + 3, `${name}: ${t.name} tree fills its header size`).toBe(t.capacity);
  expect(d.treeBitsRead, `${name}: trees within their data`).toBeLessThanOrEqual(h.treesSize * 8);
  const blocks = (h.width / 4) * (h.height / 4);
  const frameDigests = new Map<number, string>();
  let digest = 0x811c9dc5;
  let frames = 0;
  let audioSamples = 0;
  let f;
  while ((f = d.decodeNextFrame())) {
    const s = f.stats;
    const at = `${name} frame ${f.index}`;
    expect(f.index, at).toBe(frames);
    expect(s.blocks, `${at}: blocks`).toBe(blocks);
    expect(s.blocksPastEnd, `${at}: runs past the last block`).toBe(0);
    expect(s.blockKinds.reduce((a, b) => a + b, 0), at).toBe(blocks);
    expect(s.videoBitsRead, `${at}: video read past its data`).toBeLessThanOrEqual(s.videoBytes * 8);
    expect(s.videoBytes * 8 - s.videoBitsRead, `${at}: video left unread`).toBeLessThan(32);
    if (f.paletteChanged) {
      expect(s.paletteUsed, at).toBeLessThanOrEqual(s.paletteBytes);
      expect(s.paletteBytes - s.paletteUsed, `${at}: palette left unread`).toBeLessThan(4);
    }
    if (frames === 0) {
      expect(f.paletteChanged, `${name}: frame 0 carries a palette`).toBe(true);
      // (the size word's keyframe bit is clear on every frame of every MW2 movie)
      expect(f.keyframe, name).toBe(false);
      expect(f.palette.some((v) => v !== 0), `${name}: frame 0 palette is not all black`).toBe(true);
    }
    for (const a of s.audio) {
      const t = h.audio.find((x) => x.track === a.track)!;
      expect(a.empty, at).toBe(false);
      expect(a.unpackedSize, `${at}: audio over the header's maximum`).toBeLessThanOrEqual(t.maxUnpackedSize);
      expect(f.audio[a.track]!.length * (t.bits / 8), `${at}: audio length`).toBe(a.unpackedSize);
      expect(a.bitsRead, `${at}: audio read past its data`).toBeLessThanOrEqual(a.bytes * 8);
      expect(a.bytes * 8 - a.bitsRead, `${at}: audio left unread`).toBeLessThan(32);
      audioSamples += f.audio[a.track]!.length / t.channels;
    }
    for (const p of [f.pixels, f.palette]) for (let i = 0; i < p.length; i++) digest = Math.imul(digest ^ p[i]!, 0x01000193);
    if (keep.includes(f.index)) frameDigests.set(f.index, fnv1a(f.pixels, f.palette));
    frames++;
  }
  expect(frames, `${name}: frame count`).toBe(h.frames);
  if (h.audio.length) {
    // the soundtrack lasts as long as the pictures, to within a frame
    const secs = audioSamples / h.audio[0]!.sampleRate;
    const video = (h.frames * h.frameDurationUs) / 1e6;
    expect(Math.abs(secs - video), `${name}: audio ${secs.toFixed(3)} s against video ${video.toFixed(3)} s`).toBeLessThan(h.frameDurationUs / 1e6);
  }
  return { header: h, frames, digest: (digest >>> 0).toString(16).padStart(8, '0'), frameDigests, audioSamples };
}

describe('smacker frame timing', () => {
  it('reads the frame-rate field as the format defines it', () => {
    expect(smackerFrameDurationUs(100)).toBe(100_000); // ms
    expect(smackerFrameDurationUs(67)).toBe(67_000);
    expect(smackerFrameDurationUs(-10000)).toBe(100_000); // 10 us units
    expect(smackerFrameDurationUs(-6700)).toBe(67_000);
    expect(smackerFrameDurationUs(0)).toBe(100_000);
  });
});

describe.runIf(hasShellData)('DEMODATA/AMWLOGO1.SMK (install)', () => {
  it('decodes every frame consistently, and reproduces itself after reset', async () => {
    const bytes = await gameSource().read('DEMODATA/AMWLOGO1.SMK');
    const h = parseSmacker(bytes);
    expect([h.signature, h.width, h.height, h.frames, h.frameRate, h.frameDurationUs, h.flags, h.audio.length]).toEqual(['SMK2', 408, 76, 20, -10000, 100_000, 0, 0]);
    const r = checkMovie('AMWLOGO1', bytes, [0, 1, 10, 19]);
    expect(r.frames).toBe(20);
    expect(Object.fromEntries(r.frameDigests)).toEqual({ 0: '13448020', 1: '022f3de0', 10: '16bab8f5', 19: 'b54f595b' });
    expect(r.digest).toBe('ce7ec225');

    const d = new SmackerDecoder(bytes);
    const first = d.decodeNextFrame()!;
    while (d.decodeNextFrame());
    expect(d.decodeNextFrame()).toBeNull();
    expect(() => d.decodeRingFrame()).toThrow(/no ring frame/);
    d.reset();
    const again = d.decodeNextFrame()!;
    expect(fnv1a(again.pixels, again.palette)).toBe(fnv1a(first.pixels, first.palette));
  });
});

describe.runIf(hasCdImage)('every Smacker file on the CD', () => {
  it('decodes all 140 to the end with every consistency check holding', async () => {
    const iso = await openCdImage();
    const smk = (await iso.list('SMK')).filter((e) => e.name.endsWith('.SMK'));
    expect(smk.length).toBe(140);
    const kinds = new Map<string, number>();
    const digests: Record<string, string> = {};
    let frames = 0;
    for (const e of smk) {
      const r = checkMovie(e.name, await iso.readFile(e));
      const h = r.header;
      const a = h.audio.map((t) => `${t.sampleRate} Hz ${t.bits}-bit ${t.channels === 2 ? 'stereo' : 'mono'} ${t.codec}`).join(', ') || 'silent';
      const k = `${h.signature} flags ${h.flags}, ${a}`;
      kinds.set(k, (kinds.get(k) ?? 0) + 1);
      digests[e.name] = r.digest;
      frames += r.frames;
    }
    // MechWarrior 2 uses one flavour of Smacker: SMK2, no ring frame, no Y scaling, mono DPCM audio
    expect(Object.fromEntries(kinds)).toEqual({
      'SMK2 flags 0, silent': 116,
      'SMK2 flags 0, 22050 Hz 8-bit mono dpcm': 19,
      'SMK2 flags 0, 22050 Hz 16-bit mono dpcm': 4,
      'SMK2 flags 0, 11025 Hz 8-bit mono dpcm': 1,
    });
    expect(frames).toBe(6735);
    const movies = ['MINTRO.SMK', 'MWOLAND.SMK', 'MJFLAND.SMK', 'MEND.SMK', 'MEND2.SMK', 'AWORGSTR.SMK', 'AJFRGSTR.SMK', 'AMWLOGO1.SMK', 'APLAN01.SMK', 'AWOBALL.SMK'];
    expect(Object.fromEntries(movies.map((m) => [m, digests[m]]))).toEqual({
      'MINTRO.SMK': '61baf06d',
      'MWOLAND.SMK': '4bb91e45',
      'MJFLAND.SMK': '7fdf2e5a',
      'MEND.SMK': 'f7ee186f',
      'MEND2.SMK': '4b4333ea',
      'AWORGSTR.SMK': '942745fe',
      'AJFRGSTR.SMK': '920f0b43',
      'AMWLOGO1.SMK': 'ce7ec225', // the same as the install's copy
      'APLAN01.SMK': '89ddc79b',
      'AWOBALL.SMK': '8fdacbce',
    });
    // every file, name and digest, hashed together
    expect(fnv1a(new TextEncoder().encode(Object.entries(digests).map(([n, d]) => `${n} ${d}`).join('\n')))).toBe('5c9221d2');
  });
});

// ---- which names the shell asks for exist on the CD ------------------------

/** Names the shell plays as full-screen or in-screen movies: smk\<name>.smk only. */
const MOVIES = ['mintro', 'mwoland', 'mjfland', 'mend', 'mend2', 'aworgstr', 'ajfrgstr', 'amwlogo1'];

/**
 * Names screen_anims.txt shows only as expressions, resolved by hand from
 * the shell's strings: the planet table at 0x7f29c (aplanNN / aplanNNc,
 * 0x768c9..), the Trial of Grievance emblems at 0x7f328 (0x769ef..), the
 * training screen's two alternating anims (0x78088..), and the chassis
 * formats awomp%s / ajfmp%s / aiamp%s (0x83844), awosc%s / ajfsc%s /
 * aiasc%s (0x840c4) and awo%stbl / ajf%stbl (0x77c1b), whose %s is a
 * chassis's animCode (not enumerated here; see the patterns test).
 */
const INDIRECT = [
  ...Array.from({ length: 12 }, (_, i) => `aplan${String(i + 1).padStart(2, '0')}`),
  ...Array.from({ length: 12 }, (_, i) => `aplan${String(i + 1).padStart(2, '0')}c`),
  'wiawolf',
  'wiajf',
  'wiaghost',
  'wiasmoke',
  'wianova',
  'wiasteel',
  'awotrnwa',
  'awotrnwb',
  'ajftrnwa',
  'ajftrnwb',
];

describe.runIf(hasCdImage && hasShellDecompiled)('shell movie and animation names on the CD', () => {
  it('resolves each name as smk\\<name>.shp or smk\\<name>.smk', async () => {
    const iso = await openCdImage();
    const has = async (n: string) => (await iso.lookup(`SMK/${n}`)) !== null;
    const literal = new Set<string>();
    for (const line of readShellListing('screen_anims.txt').split('\n')) {
      const m = /^\s+\S+\s+\S+\s+([a-z0-9]+)\s/.exec(line);
      if (m) literal.add(m[1]!);
    }
    const anims = [...new Set([...literal, ...INDIRECT])].sort();
    const shp: string[] = [];
    const smkOnly: string[] = [];
    const missing: string[] = [];
    for (const n of anims) {
      if (await has(`${n}.shp`)) shp.push(n);
      else if (await has(`${n}.smk`)) smkOnly.push(n);
      else missing.push(n);
    }
    const movieMissing: string[] = [];
    for (const n of MOVIES) if (!(await has(`${n}.smk`))) movieMissing.push(n);
    expect(movieMissing).toEqual([]);
    // everything resolves; these are shape tables, the rest Smacker movies
    expect({ shp, missing }).toEqual({
      shp: ['wiabkg1', 'wiabkg2', 'wiacn', 'wiacp', 'wiadsgn', 'wialanch', 'wiamp4mp', 'wiastar', 'wiavn', 'wiavp', 'wjfdsgn', 'wjfmp4mp', 'wjfstar', 'wwomp4mp'],
      missing: [],
    });
    expect(smkOnly.length + shp.length + missing.length).toBe(anims.length);
  });

  it('finds the chassis-coded families', async () => {
    const iso = await openCdImage();
    const names = (await iso.list('SMK')).map((e) => e.name);
    const codes = (re: RegExp) =>
      names
        .map((n) => re.exec(n))
        .filter((m): m is RegExpExecArray => m !== null)
        .map((m) => m[1]!)
        .sort()
        .join(' ');
    expect({
      'awomp%s.shp': codes(/^AWOMP([A-Z]{2})\.SHP$/),
      'ajfmp%s.shp': codes(/^AJFMP([A-Z]{2})\.SHP$/),
      'aiamp%s.shp': codes(/^AIAMP([A-Z]{2})\.SHP$/),
      'awosc%s.shp': codes(/^AWOSC([A-Z]{2})\.SHP$/),
      'ajfsc%s.shp': codes(/^AJFSC([A-Z]{2})\.SHP$/),
      'aiasc%s.shp': codes(/^AIASC([A-Z]{2})\.SHP$/),
      'awo%stbl.smk': codes(/^AWO([A-Z]{2})TBL\.SMK$/),
      'ajf%stbl.smk': codes(/^AJF([A-Z]{2})TBL\.SMK$/),
    }).toEqual({
      'awomp%s.shp': 'BH DA DS JN KF LO MC MD MR MS MW RF SC SU WH',
      'ajfmp%s.shp': 'BH DA DS JN KF LO MC MD MR MS MW RF SC SU WH',
      'aiamp%s.shp': 'BH BM DA DS EL JN KF LO MC MD MR MS MW RF SC SU TA WH',
      'awosc%s.shp': 'BH DA DS JN KF LO MC MD MR MS MW RF SC SU WH',
      'ajfsc%s.shp': 'BH DA DS JN KF LO MC MD MR MS MW RF SC SU WH',
      'aiasc%s.shp': 'BH DA DS JN KF LO MC MD MR MS MW RF SC SU WH',
      'awo%stbl.smk': 'BH DA DS JN KF LO MC MD MR MS MT MW RF SC SU WH',
      'ajf%stbl.smk': 'BH DA DS JN KF LO MC MD MR MS MT MW RF SC SU WH',
    });
  });
});
