// The Smacker features MechWarrior 2's own files never use - SMK4's doubled
// full blocks, the ring frame, Y doubling and interlacing, PCM and stereo
// audio - checked on small files built here bit by bit. Also the tree cache,
// mono blocks and palette records, which the real files do use, in isolation.
// (test/golden/smacker.test.ts decodes the real files.)
import { describe, expect, it } from 'vitest';
import { applySmackerPalette, decodeSmackerAudio, SmackerDecoder, SMK_PALETTE_SCALE, type SmackerAudioTrack } from '../../src/data/formats/smacker.ts';

/** LSB-first bit writer. */
class BW {
  readonly v: number[] = [];
  bit(b: number): this {
    this.v.push(b & 1);
    return this;
  }
  num(x: number, n: number): this {
    for (let i = 0; i < n; i++) this.bit((x >>> i) & 1);
    return this;
  }
  code(c: readonly number[]): this {
    for (const b of c) this.bit(b);
    return this;
  }
  bytes(): Uint8Array {
    const out = new Uint8Array(Math.ceil(this.v.length / 32) * 4);
    this.v.forEach((b, i) => (out[i >> 3]! |= b << (i & 7)));
    return out;
  }
}

/** Writes a balanced byte tree over `values`; returns each value's code. */
function byteTree(w: BW, values: number[]): Map<number, number[]> {
  const codes = new Map<number, number[]>();
  const rec = (list: number[], prefix: number[]) => {
    if (list.length === 1) {
      w.bit(0).num(list[0]!, 8);
      codes.set(list[0]!, prefix);
      return;
    }
    w.bit(1);
    const mid = list.length >> 1;
    rec(list.slice(0, mid), [...prefix, 0]);
    rec(list.slice(mid), [...prefix, 1]);
  };
  rec([...new Set(values)].sort((a, b) => a - b), []);
  return codes;
}

interface Big {
  size: number;
  codes: Map<number, number[]>;
}

/** Writes a big tree (presence bit first) over 16-bit `values`; escapes are plain values that become cache slots. */
function bigTree(w: BW, values: number[] | null, escapes: [number, number, number] = [0xfff0, 0xfff1, 0xfff2]): Big {
  if (!values) {
    w.bit(0);
    return { size: 12, codes: new Map() };
  }
  const uniq = [...new Set(values)].sort((a, b) => a - b);
  w.bit(1);
  w.bit(1);
  const lo = byteTree(w, uniq.map((v) => v & 0xff));
  w.bit(0);
  w.bit(1);
  const hi = byteTree(w, uniq.map((v) => v >> 8));
  w.bit(0);
  for (const e of escapes) w.num(e, 16);
  const codes = new Map<number, number[]>();
  let entries = 0;
  const rec = (list: number[], prefix: number[]) => {
    entries++;
    if (list.length === 1) {
      const v = list[0]!;
      w.bit(0).code(lo.get(v & 0xff)!).code(hi.get(v >> 8)!);
      codes.set(v, prefix);
      return;
    }
    w.bit(1);
    const mid = list.length >> 1;
    rec(list.slice(0, mid), [...prefix, 0]);
    rec(list.slice(mid), [...prefix, 1]);
  };
  rec(uniq, []);
  w.bit(0);
  return { size: (Math.max(entries, 2) + 3) * 4, codes };
}

interface Frame {
  palette?: Uint8Array;
  audio?: (Uint8Array | undefined)[];
  video: Uint8Array;
}

function buildSmk(o: {
  sig?: 'SMK2' | 'SMK4';
  w: number;
  h: number;
  frames: Frame[];
  flags?: number;
  rate?: number;
  trees: { bytes: Uint8Array; sizes: number[] };
  audioRate?: number[];
  audioSize?: number[];
}): Uint8Array {
  const ring = (o.flags ?? 0) & 1;
  const n = o.frames.length;
  const chunks = o.frames.map((f) => {
    const parts: Uint8Array[] = [];
    let type = 0;
    if (f.palette) {
      type |= 1;
      parts.push(f.palette);
    }
    (f.audio ?? []).forEach((a, t) => {
      if (!a) return;
      type |= 2 << t;
      const len = new Uint8Array(4);
      new DataView(len.buffer).setUint32(0, a.length + 4, true);
      parts.push(len, a);
    });
    parts.push(f.video);
    let size = parts.reduce((s, p) => s + p.length, 0);
    size = (size + 3) & ~3;
    const out = new Uint8Array(size);
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return { out, type };
  });
  const head = new Uint8Array(104 + n * 5);
  const dv = new DataView(head.buffer);
  head.set(new TextEncoder().encode(o.sig ?? 'SMK2'));
  dv.setUint32(4, o.w, true);
  dv.setUint32(8, o.h, true);
  dv.setUint32(12, n - ring, true);
  dv.setInt32(16, o.rate ?? 100, true);
  dv.setUint32(20, o.flags ?? 0, true);
  (o.audioSize ?? []).forEach((s, i) => dv.setUint32(24 + i * 4, s, true));
  dv.setUint32(52, o.trees.bytes.length, true);
  o.trees.sizes.forEach((s, i) => dv.setUint32(56 + i * 4, s, true));
  (o.audioRate ?? []).forEach((r, i) => dv.setUint32(72 + i * 4, r >>> 0, true));
  chunks.forEach((c, i) => {
    dv.setUint32(104 + i * 4, c.out.length | (i === 0 ? 1 : 0), true);
    head[104 + n * 4 + i] = c.type;
  });
  const total = head.length + o.trees.bytes.length + chunks.reduce((s, c) => s + c.out.length, 0);
  const file = new Uint8Array(total);
  file.set(head);
  file.set(o.trees.bytes, head.length);
  let at = head.length + o.trees.bytes.length;
  for (const c of chunks) {
    file.set(c.out, at);
    at += c.out.length;
  }
  return file;
}

/** A palette chunk: its length byte, then the records, padded to 4. */
function palChunk(records: number[]): Uint8Array {
  const size = (records.length + 1 + 3) & ~3;
  const out = new Uint8Array(size);
  out[0] = size / 4;
  out.set(records, 1);
  return out;
}

/** 256 new entries: entry i = (i & 63, (i >> 2) & 63, 63 - (i & 63)) */
const rampPalette = () => palChunk(Array.from({ length: 256 }, (_, i) => [i & 63, (i >> 2) & 63, 63 - (i & 63)]).flat());

const solid = (c: number, run = 0) => 3 | (run << 2) | (c << 8);

describe('smacker video', () => {
  it('reads SMK4 full blocks in all three modes, and SMK2 full blocks without mode bits', () => {
    const fullVals = [0x0100, 0x0302, 0x0504, 0x0706, 0x0908, 0x0b0a, 0x0d0c, 0x0f0e, 0x0201, 0x0403];
    const build = (sig: 'SMK2' | 'SMK4', body: (v: BW, full: Big, type: Big) => void) => {
      const t = new BW();
      const mmap = bigTree(t, null);
      const mclr = bigTree(t, null);
      const full = bigTree(t, fullVals);
      const type = bigTree(t, [1]);
      const v = new BW();
      body(v, full, type);
      return new SmackerDecoder(
        buildSmk({ sig, w: 4, h: 4, frames: [{ palette: rampPalette(), video: v.bytes() }], trees: { bytes: t.bytes(), sizes: [mmap.size, mclr.size, full.size, type.size] } }),
      );
    };
    const F = (full: Big, x: number) => full.codes.get(x)!;
    // mode 0: per row the right pair then the left pair
    const rows = (v: BW, full: Big) => {
      for (let y = 0; y < 4; y++) v.code(F(full, ((4 * y + 3) << 8) | (4 * y + 2))).code(F(full, ((4 * y + 1) << 8) | (4 * y)));
    };
    let d = build('SMK4', (v, full, type) => {
      v.code(type.codes.get(1)!).bit(0).bit(0);
      rows(v, full);
    });
    let f = d.decodeNextFrame()!;
    expect(Array.from(f.pixels)).toEqual(Array.from({ length: 16 }, (_, i) => i));
    expect(f.stats.blockKinds).toEqual([0, 1, 0, 0]);
    d = build('SMK2', (v, full, type) => {
      v.code(type.codes.get(1)!);
      rows(v, full);
    });
    expect(Array.from(d.decodeNextFrame()!.pixels)).toEqual(Array.from({ length: 16 }, (_, i) => i));
    // mode 1: 2x2 pixels, one code per two rows
    d = build('SMK4', (v, full, type) => {
      v.code(type.codes.get(1)!).bit(1).code(F(full, 0x0201)).code(F(full, 0x0403));
    });
    expect(Array.from(d.decodeNextFrame()!.pixels)).toEqual([1, 1, 2, 2, 1, 1, 2, 2, 3, 3, 4, 4, 3, 3, 4, 4]);
    // mode 2: rows doubled, right pair then left pair
    d = build('SMK4', (v, full, type) => {
      v.code(type.codes.get(1)!).bit(0).bit(1).code(F(full, 0x0302)).code(F(full, 0x0100)).code(F(full, 0x0706)).code(F(full, 0x0504));
    });
    f = d.decodeNextFrame()!;
    expect(Array.from(f.pixels)).toEqual([0, 1, 2, 3, 0, 1, 2, 3, 4, 5, 6, 7, 4, 5, 6, 7]);
    expect(f.stats.videoBitsRead).toBeLessThanOrEqual(f.stats.videoBytes * 8);
  });

  it('draws mono blocks from a colour pair and a 16-bit map, bit set = high colour', () => {
    const t = new BW();
    const mmap = bigTree(t, [0x8421, 0x0ff0]);
    const mclr = bigTree(t, [0x0a0b]);
    const full = bigTree(t, null);
    const type = bigTree(t, [0 | (1 << 2)]); // mono, run 2
    const v = new BW().code(type.codes.get(4)!);
    v.code(mclr.codes.get(0x0a0b)!).code(mmap.codes.get(0x8421)!);
    v.code(mclr.codes.get(0x0a0b)!).code(mmap.codes.get(0x0ff0)!);
    const d = new SmackerDecoder(
      buildSmk({ w: 8, h: 4, frames: [{ palette: rampPalette(), video: v.bytes() }], trees: { bytes: t.bytes(), sizes: [mmap.size, mclr.size, full.size, type.size] } }),
    );
    const f = d.decodeNextFrame()!;
    const L = 0x0b;
    const H = 0x0a;
    expect(Array.from(f.pixels)).toEqual([
      ...[H, L, L, L, L, L, L, L],
      ...[L, H, L, L, H, H, H, H],
      ...[L, L, H, L, H, H, H, H],
      ...[L, L, L, H, L, L, L, L],
    ]);
  });

  it("decodes an escape leaf as the tree's most recent value, cleared each frame", () => {
    const A = solid(5);
    const B = solid(9);
    const t = new BW();
    const [mmap, mclr, full] = [bigTree(t, null), bigTree(t, null), bigTree(t, null)];
    const type = bigTree(t, [A, B, 0x7777], [0x7777, 0x7778, 0x7779]);
    const esc = type.codes.get(0x7777)!;
    // frame 0: A, B, then the escape - the cache's newest, B.
    // frame 1: the escape first - the cache was cleared, so 0: a mono block
    // whose absent trees give colour 0 - then A, and the escape again (A).
    const v0 = new BW().code(type.codes.get(A)!).code(type.codes.get(B)!).code(esc);
    const v1 = new BW().code(esc).code(type.codes.get(A)!).code(esc);
    const d = new SmackerDecoder(
      buildSmk({
        w: 12,
        h: 4,
        frames: [{ palette: rampPalette(), video: v0.bytes() }, { video: v1.bytes() }],
        trees: { bytes: t.bytes(), sizes: [mmap.size, mclr.size, full.size, type.size] },
      }),
    );
    expect(d.trees.map((x) => [x.name, x.present, x.entries, x.capacity, x.escapesUsed])).toEqual([
      ['MMAP', false, 0, 3, 0],
      ['MCLR', false, 0, 3, 0],
      ['FULL', false, 0, 3, 0],
      ['TYPE', true, 5, 8, 1],
    ]);
    const row = (f: { pixels: Uint8Array }) => Array.from(f.pixels.subarray(0, 12));
    expect(row(d.decodeNextFrame()!)).toEqual([5, 5, 5, 5, 9, 9, 9, 9, 9, 9, 9, 9]);
    expect(row(d.decodeNextFrame()!)).toEqual([0, 0, 0, 0, 5, 5, 5, 5, 5, 5, 5, 5]);
  });

  it('cuts a run at the last block, doubles or interlaces rows, and plays the ring frame', () => {
    const t = new BW();
    const [mmap, mclr, full] = [bigTree(t, null), bigTree(t, null), bigTree(t, null)];
    const type = bigTree(t, [solid(1, 5), solid(2, 5), solid(3, 0)]); // runs of 6 over 2 blocks
    const frame = (c: number) => new BW().code(type.codes.get(c)!).bytes();
    const trees = { bytes: t.bytes(), sizes: [mmap.size, mclr.size, full.size, type.size] };
    const frames = [{ palette: rampPalette(), video: frame(solid(1, 5)) }, { video: frame(solid(2, 5)) }, { video: frame(solid(1, 5)) }];
    const d = new SmackerDecoder(buildSmk({ w: 8, h: 4, frames, trees, flags: 1 | 4 }));
    expect([d.header.frames, d.header.ringFrame, d.header.yDoubled, d.header.displayHeight]).toEqual([2, true, true, 8]);
    const f0 = d.decodeNextFrame()!;
    expect(f0.stats.blocksPastEnd).toBe(4);
    expect(Array.from(f0.pixels)).toEqual(new Array(64).fill(1));
    expect(Array.from(d.decodeNextFrame()!.pixels)).toEqual(new Array(64).fill(2));
    expect(d.decodeNextFrame()).toBeNull();
    const ring = d.decodeRingFrame();
    expect(ring.index).toBe(2);
    expect(Array.from(ring.pixels)).toEqual(new Array(64).fill(1));
    expect(d.nextFrame).toBe(1);
    expect(Array.from(d.decodeNextFrame()!.pixels)).toEqual(new Array(64).fill(2));

    const il = new SmackerDecoder(buildSmk({ w: 8, h: 4, frames: frames.slice(0, 1), trees, flags: 2 }));
    const p = il.decodeNextFrame()!.pixels;
    expect(il.header.displayHeight).toBe(8);
    for (let y = 0; y < 8; y++) expect(Array.from(p.subarray(y * 8, y * 8 + 8))).toEqual(new Array(8).fill(y & 1 ? 0 : 1));
  });
});

describe('smacker palette records', () => {
  it('keeps, copies from the previous palette, and sets 6-bit entries scaled to 8 bits', () => {
    expect([SMK_PALETTE_SCALE[0], SMK_PALETTE_SCALE[1], SMK_PALETTE_SCALE[16], SMK_PALETTE_SCALE[32], SMK_PALETTE_SCALE[48], SMK_PALETTE_SCALE[63]]).toEqual([0, 4, 65, 130, 195, 255]);
    const pal = new Uint8Array(768);
    for (let i = 0; i < 768; i++) pal[i] = i & 0xff;
    const before = pal.slice();
    // keep 2; copy 3 from entry 10; one new (63, 32, 1); keep the remaining 250
    const rec = [0x81, 0x42, 10, 63, 32, 1, 0xff, 0x80 | 121];
    expect(applySmackerPalette(pal, Uint8Array.from(rec), 0, rec.length)).toBe(rec.length);
    expect(Array.from(pal.subarray(0, 6))).toEqual(Array.from(before.subarray(0, 6)));
    expect(Array.from(pal.subarray(6, 15))).toEqual(Array.from(before.subarray(30, 39)));
    expect(Array.from(pal.subarray(15, 18))).toEqual([255, 130, 4]);
    expect(Array.from(pal.subarray(18))).toEqual(Array.from(before.subarray(18)));
    // copies read the palette as it was before the chunk, not as rewritten so far
    const p2 = before.slice();
    applySmackerPalette(p2, Uint8Array.from([0, 0, 0, 0x40, 0, 0xfe, 0xfe]), 0, 7);
    expect(Array.from(p2.subarray(3, 6))).toEqual(Array.from(before.subarray(0, 3)));
    expect(() => applySmackerPalette(pal.slice(), Uint8Array.from([0x41, 255]), 0, 2)).toThrow(/past entry 255/);
  });
});

describe('smacker audio', () => {
  const track = (bits: 8 | 16, channels: 1 | 2, codec: SmackerAudioTrack['codec']): SmackerAudioTrack => ({
    track: 0,
    sampleRate: 22050,
    bits,
    channels,
    codec,
    flags: 0,
    maxUnpackedSize: 1 << 20,
  });

  it('passes PCM through: 8-bit unsigned, 16-bit little-endian', () => {
    const b8 = Uint8Array.from([0, 128, 255]);
    expect(Array.from(decodeSmackerAudio(track(8, 1, 'pcm'), b8, 0, 3).samples)).toEqual([-32768, 0, 127 << 8]);
    const b16 = Uint8Array.from([0x34, 0x12, 0xff, 0xff]);
    expect(Array.from(decodeSmackerAudio(track(16, 2, 'pcm'), b16, 0, 4).samples)).toEqual([0x1234, -1]);
  });

  /** Packs `samples` (interleaved) as DPCM the way the decoder reads it. */
  function packDpcm(bits: 8 | 16, channels: 1 | 2, samples: number[]): Uint8Array {
    const stereo = channels - 1;
    const n = samples.length;
    const unpacked = n * (bits / 8);
    const deltas: number[][] = Array.from({ length: bits === 16 ? 4 : 2 }, () => []);
    const plan: [number, number][] = [];
    for (let i = channels; i < n; i++) {
      const c = i & stereo;
      const d = samples[i]! - samples[i - channels]!;
      if (bits === 16) {
        const u = d & 0xffff;
        plan.push([c * 2, u & 0xff], [c * 2 + 1, u >> 8]);
        deltas[c * 2]!.push(u & 0xff);
        deltas[c * 2 + 1]!.push(u >> 8);
      } else {
        plan.push([c, d & 0xff]);
        deltas[c]!.push(d & 0xff);
      }
    }
    const w = new BW().num(unpacked, 32).bit(1).bit(stereo).bit(bits === 16 ? 1 : 0);
    const codes: Map<number, number[]>[] = [];
    for (let i = 0; i < 1 << (stereo + (bits === 16 ? 1 : 0)); i++) {
      w.bit(1);
      codes.push(byteTree(w, deltas[i]!.length ? deltas[i]! : [0]));
      w.bit(0);
    }
    for (let c = stereo; c >= 0; c--) {
      const s = samples[c]!;
      if (bits === 16) w.num((s >> 8) & 0xff, 8).num(s & 0xff, 8);
      else w.num(s, 8);
    }
    for (const [tr, v] of plan) w.code(codes[tr]!.get(v)!);
    return w.bytes();
  }

  for (const [bits, channels] of [
    [8, 1],
    [8, 2],
    [16, 1],
    [16, 2],
  ] as const) {
    it(`unpacks ${bits}-bit ${channels === 2 ? 'stereo' : 'mono'} DPCM`, () => {
      const n = 64;
      const raw = Array.from({ length: n }, (_, i) => {
        const c = i % channels;
        return bits === 16 ? Math.round(Math.sin(i / (5 + c)) * 20000) : 128 + Math.round(Math.sin(i / (5 + c)) * 100);
      });
      const packed = packDpcm(bits, channels, raw);
      const r = decodeSmackerAudio(track(bits, channels, 'dpcm'), packed, 0, packed.length);
      expect(Array.from(r.samples)).toEqual(bits === 16 ? raw : raw.map((s) => (s - 128) << 8));
      expect(r.stats.unpackedSize).toBe(n * (bits / 8));
      expect(r.stats.bitsRead).toBeLessThanOrEqual(packed.length * 8);
      expect(packed.length * 8 - r.stats.bitsRead).toBeLessThan(32);
    });
  }

  it('rejects a chunk whose format disagrees with the track', () => {
    const packed = packDpcm(8, 1, [128, 129, 130]);
    expect(() => decodeSmackerAudio(track(16, 1, 'dpcm'), packed, 0, packed.length)).toThrow(/mono 8-bit/);
  });
});
