/**
 * Smacker (RAD Game Tools, 'SMK2' / 'SMK4'): the front end's full-screen
 * movies (SMK\MINTRO.SMK, the landing and ending movies) and the screen
 * animations that are not VFX shape tables.
 *
 * Written from the public description of the format (the multimedia.cx wiki
 * "Smacker" page); MW2SHELL.EXE links RAD's library at 0x4bc70 (the
 * decompilation's `smacker` group, assembly, unread). Everything here is
 * the port's own.
 *
 *   header  +0    'SMK2' or 'SMK4'
 *           +4    u32 width, +8 u32 height (stored rows; see flags)
 *           +12   u32 frames (not counting a ring frame)
 *           +16   i32 frame rate: > 0 ms per frame, < 0 units of 10 us, 0 = 100 ms
 *           +20   u32 flags: 1 ring frame, 2 Y-interlaced, 4 Y-doubled
 *           +24   u32[7] largest unpacked audio chunk per track
 *           +52   u32 size of the Huffman tree data
 *           +56   u32[4] MMAP, MCLR, FULL, TYPE tree sizes: 4 bytes per entry, branches and
 *                 leaves plus the 3 cache slots (a one-leaf tree counts 2 entries; an
 *                 absent one 0) - exact in all 141 MW2 files
 *           +72   u32[7] audio track: bits 0-23 rate, 24-31 flags (0x80 packed,
 *                 0x40 present, 0x20 16-bit, 0x10 stereo, 0x08 Bink RDFT, 0x04 Bink DCT)
 *           +100  u32 unused
 *           +104  u32[n] frame sizes (bit 0 keyframe, bit 1 unknown; both clear in every MW2
 *                 file), n = frames (+1 ring)
 *                 u8[n]  frame types (bit 0 palette chunk, bits 1-7 audio for tracks 0-6)
 *                 tree data, then the frames back to back
 *   frame   [palette chunk: u8 length/4, then the records]
 *           [per audio track flagged: u32 length (including itself), data]
 *           video bitstream to the frame's end
 *
 * Bitstreams read least significant bit first. Frames are 4x4 blocks in
 * raster order, each block a type code from the TYPE tree:
 *   bits 0-1 kind (0 mono, 1 full, 2 void, 3 solid), bits 2-7 run length
 *   index (1..59, then 128, 256, 512, 1024, 2048), bits 8-15 solid colour.
 *
 * @portOnly the original played these through RAD's Smacker library.
 */

/** header flags (+20) */
export const SMK_FLAG_RING_FRAME = 1;
export const SMK_FLAG_Y_INTERLACE = 2;
export const SMK_FLAG_Y_DOUBLE = 4;

/** audio flags (the rate word's top byte) */
export const SMK_AUDIO_PACKED = 0x80;
export const SMK_AUDIO_PRESENT = 0x40;
export const SMK_AUDIO_16BIT = 0x20;
export const SMK_AUDIO_STEREO = 0x10;
export const SMK_AUDIO_BINK_RDFT = 0x08;
export const SMK_AUDIO_BINK_DCT = 0x04;

export type SmackerAudioCodec = 'pcm' | 'dpcm' | 'bink-rdft' | 'bink-dct';

export interface SmackerAudioTrack {
  /** track number 0..6 (the frame-type bit is 1 << (track + 1)) */
  track: number;
  sampleRate: number;
  bits: 8 | 16;
  channels: 1 | 2;
  codec: SmackerAudioCodec;
  /** the rate word's top byte, as stored */
  flags: number;
  /** header +24: the largest unpacked chunk, bytes */
  maxUnpackedSize: number;
}

export interface SmackerHeader {
  signature: 'SMK2' | 'SMK4';
  version: 2 | 4;
  width: number;
  /** rows stored per frame */
  height: number;
  /** rows shown: height doubled when the Y-interlace or Y-double flag is set */
  displayHeight: number;
  /** frames in the movie, not counting a ring frame */
  frames: number;
  /** the header's raw frame-rate field */
  frameRate: number;
  /** microseconds per frame, from frameRate */
  frameDurationUs: number;
  flags: number;
  ringFrame: boolean;
  yInterlaced: boolean;
  yDoubled: boolean;
  /** header +24, per track 0..6 */
  audioSize: number[];
  /** header +72, per track 0..6, as stored */
  audioRate: number[];
  /** the tracks whose rate word is non-zero */
  audio: SmackerAudioTrack[];
  treesSize: number;
  /** MMAP, MCLR, FULL, TYPE tree sizes, bytes */
  treeSizes: [number, number, number, number];
  /** per frame (ring frame last), byte size with the flag bits masked off */
  frameSizes: number[];
  /** per frame, the size word's low two bits (1 = keyframe) */
  frameSizeFlags: number[];
  /** per frame, the type byte */
  frameTypes: number[];
  /** per frame, byte offset in the file */
  frameOffsets: number[];
  treesOffset: number;
  /** byte offset of the first frame */
  dataOffset: number;
  /** end of the last frame */
  dataEnd: number;
}

const ascii4 = (b: Uint8Array, at: number) => String.fromCharCode(b[at]!, b[at + 1]!, b[at + 2]!, b[at + 3]!);

/**
 * Smacker's frame-rate field as microseconds per frame: a positive value is
 * milliseconds, a negative one hundredths of a millisecond, 0 means 10 fps.
 * @portOnly
 */
export function smackerFrameDurationUs(frameRate: number): number {
  if (frameRate > 0) return frameRate * 1000;
  if (frameRate < 0) return -frameRate * 10;
  return 100_000;
}

/** Reads a Smacker file's header and frame tables. Throws on anything that is not SMK2/SMK4. @portOnly */
export function parseSmacker(b: Uint8Array): SmackerHeader {
  if (b.length < 104) throw new Error('smacker: file too short for a header');
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const sig = ascii4(b, 0);
  if (sig !== 'SMK2' && sig !== 'SMK4') throw new Error(`smacker: bad signature ${JSON.stringify(sig)}`);
  const u = (at: number) => dv.getUint32(at, true);
  const width = u(4);
  const height = u(8);
  const frames = u(12);
  const frameRate = dv.getInt32(16, true);
  const flags = u(20);
  const audioSize = Array.from({ length: 7 }, (_, i) => u(24 + i * 4));
  const treesSize = u(52);
  const treeSizes: [number, number, number, number] = [u(56), u(60), u(64), u(68)];
  const audioRate = Array.from({ length: 7 }, (_, i) => u(72 + i * 4));
  const ringFrame = (flags & SMK_FLAG_RING_FRAME) !== 0;
  const n = frames + (ringFrame ? 1 : 0);
  const treesOffset = 104 + n * 5;
  if (width === 0 || height === 0 || width % 4 !== 0 || height % 4 !== 0) throw new Error(`smacker: bad size ${width}x${height}`);
  if (treesOffset + treesSize > b.length) throw new Error('smacker: header tables run past the file');
  const frameSizes: number[] = [];
  const frameSizeFlags: number[] = [];
  const frameTypes: number[] = [];
  const frameOffsets: number[] = [];
  let at = treesOffset + treesSize;
  for (let i = 0; i < n; i++) {
    const s = u(104 + i * 4);
    frameSizes.push((s & ~3) >>> 0);
    frameSizeFlags.push(s & 3);
    frameTypes.push(b[104 + n * 4 + i]!);
    frameOffsets.push(at);
    at += (s & ~3) >>> 0;
  }
  const audio: SmackerAudioTrack[] = [];
  audioRate.forEach((r, track) => {
    if (r === 0) return;
    const f = r >>> 24;
    const codec: SmackerAudioCodec = f & SMK_AUDIO_BINK_RDFT ? 'bink-rdft' : f & SMK_AUDIO_BINK_DCT ? 'bink-dct' : f & SMK_AUDIO_PACKED ? 'dpcm' : 'pcm';
    audio.push({
      track,
      sampleRate: r & 0xffffff,
      bits: f & SMK_AUDIO_16BIT ? 16 : 8,
      channels: f & SMK_AUDIO_STEREO ? 2 : 1,
      codec,
      flags: f,
      maxUnpackedSize: audioSize[track]!,
    });
  });
  const yInterlaced = (flags & SMK_FLAG_Y_INTERLACE) !== 0;
  const yDoubled = (flags & SMK_FLAG_Y_DOUBLE) !== 0;
  return {
    signature: sig,
    version: sig === 'SMK4' ? 4 : 2,
    width,
    height,
    displayHeight: yInterlaced || yDoubled ? height * 2 : height,
    frames,
    frameRate,
    frameDurationUs: smackerFrameDurationUs(frameRate),
    flags,
    ringFrame,
    yInterlaced,
    yDoubled,
    audioSize,
    audioRate,
    audio,
    treesSize,
    treeSizes,
    frameSizes,
    frameSizeFlags,
    frameTypes,
    frameOffsets,
    treesOffset,
    dataOffset: treesOffset + treesSize,
    dataEnd: at,
  };
}

// ---- bit reader -------------------------------------------------------

/** LSB-first bit reader over b[start, end). Reads past the end return 0 bits and are counted by `pos`. */
class Bits {
  pos: number;
  readonly end: number;
  constructor(
    readonly b: Uint8Array,
    readonly start: number,
    end: number,
  ) {
    this.pos = start * 8;
    this.end = end * 8;
  }
  bit(): number {
    const p = this.pos++;
    return p < this.end ? (this.b[p >> 3]! >> (p & 7)) & 1 : 0;
  }
  bits(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) v |= this.bit() << i;
    return v >>> 0;
  }
  /** bits read so far */
  get used(): number {
    return this.pos - this.start * 8;
  }
  get overrun(): boolean {
    return this.pos > this.end;
  }
}

// ---- Huffman trees ----------------------------------------------------

/**
 * Trees are flat arrays in depth-first order: a leaf holds its value (>= 0);
 * a branch holds NODE | the size of its 0-subtree, which follows it, the
 * 1-subtree after that.
 */
const NODE = 0x80000000 | 0;
const MAX_DEPTH = 32;

function walk(t: Int32Array, br: Bits): number {
  let i = 0;
  let v = t[0]!;
  while (v < 0) {
    if (br.bit()) i += v & 0x7fffffff;
    v = t[++i]!;
  }
  return i;
}

/** An 8-bit-leaf tree (the big trees' byte trees, the audio trees): the tree's bits, not its presence or end bit. */
function readByteTree(br: Bits): Int32Array {
  const out: number[] = [];
  let leaves = 0;
  const rec = (depth: number): number => {
    if (depth > MAX_DEPTH) throw new Error('smacker: Huffman tree deeper than 32');
    if (!br.bit()) {
      if (++leaves > 256) throw new Error('smacker: byte tree has more than 256 leaves');
      out.push(br.bits(8));
      return 1;
    }
    const t = out.length;
    out.push(NODE);
    const l = rec(depth + 1);
    out[t] = NODE | l;
    return 1 + l + rec(depth + 1);
  };
  rec(0);
  return Int32Array.from(out);
}

export interface SmackerTreeInfo {
  name: 'MMAP' | 'MCLR' | 'FULL' | 'TYPE';
  present: boolean;
  /** header size, bytes */
  size: number;
  /** entries the size allows: (size + 3) >> 2 */
  capacity: number;
  /** branches and leaves read */
  entries: number;
  leaves: number;
  /** the three escape codes, as read (undefined when absent) */
  escapes: [number, number, number] | null;
  /** how many of the escapes matched a leaf */
  escapesUsed: number;
}

/**
 * A 16-bit "big" tree with its three-entry recently-used cache. Leaves whose
 * value matched one of the header's escape codes are the cache slots: they
 * decode to whatever the cache holds (cleared to 0 at the start of every
 * frame). Every decode that differs from cache[0] pushes it in front.
 */
class BigTree {
  readonly t: Int32Array;
  readonly last: [number, number, number];
  readonly info: SmackerTreeInfo;

  constructor(br: Bits, name: SmackerTreeInfo['name'], size: number) {
    const capacity = (size + 3) >> 2;
    const info: SmackerTreeInfo = { name, present: false, size, capacity, entries: 0, leaves: 0, escapes: null, escapesUsed: 0 };
    this.info = info;
    if (!br.bit()) {
      // absent: every code is 0 and costs no bits
      this.t = new Int32Array(4);
      this.last = [1, 2, 3];
      return;
    }
    info.present = true;
    const sub: (Int32Array | null)[] = [];
    for (let i = 0; i < 2; i++) {
      if (br.bit()) {
        sub.push(readByteTree(br));
        br.bit(); // end of tree
      } else sub.push(null);
    }
    const esc: [number, number, number] = [br.bits(16), br.bits(16), br.bits(16)];
    info.escapes = esc;
    const last: [number, number, number] = [-1, -1, -1];
    const out: number[] = [];
    const leaf = (s: Int32Array | null) => (s ? s[walk(s, br)]! : 0);
    const rec = (depth: number): number => {
      if (depth > MAX_DEPTH) throw new Error(`smacker: ${name} tree deeper than 32`);
      if (!br.bit()) {
        const v = leaf(sub[0]!) | (leaf(sub[1]!) << 8);
        const e = esc.indexOf(v);
        if (e >= 0) last[e] = out.length;
        out.push(e >= 0 ? 0 : v);
        info.leaves++;
        return 1;
      }
      const t = out.length;
      out.push(NODE);
      const l = rec(depth + 1);
      out[t] = NODE | l;
      return 1 + l + rec(depth + 1);
    };
    rec(0);
    br.bit(); // end of tree
    info.entries = out.length;
    info.escapesUsed = last.filter((x) => x >= 0).length;
    for (let i = 0; i < 3; i++) if (last[i]! < 0) last[i] = out.length + i;
    const t = new Int32Array(out.length + 3);
    t.set(out);
    this.t = t;
    this.last = last;
  }

  /** start of a frame: the cache empties */
  reset(): void {
    const t = this.t;
    t[this.last[0]] = 0;
    t[this.last[1]] = 0;
    t[this.last[2]] = 0;
  }

  get(br: Bits): number {
    const t = this.t;
    const v = t[walk(t, br)]!;
    const [a, b, c] = this.last;
    if (v !== t[a]) {
      t[c] = t[b]!;
      t[b] = t[a]!;
      t[a] = v;
    }
    return v;
  }
}

// ---- palette ----------------------------------------------------------

/** 6-bit palette component to 8-bit: (v << 2) | (v >> 4). @portOnly */
export const SMK_PALETTE_SCALE: Uint8Array = Uint8Array.from({ length: 64 }, (_, v) => (v << 2) | (v >> 4));

/**
 * Applies a palette chunk's records (b[at, end), after the length byte) to
 * `pal` (256 * 3, 8-bit). Records rebuild the palette in order:
 *   0x80 | n    keep the next n + 1 entries
 *   0x40 | n, s copy n + 1 entries from the previous palette starting at s
 *   r, g, b     one new entry, 6-bit components (r < 0x40)
 * Returns the bytes read.
 * @portOnly
 */
export function applySmackerPalette(pal: Uint8Array, b: Uint8Array, at: number, end: number): number {
  const old = pal.slice();
  const start = at;
  let n = 0;
  while (n < 256) {
    if (at >= end) throw new Error('smacker: palette chunk ends early');
    const t = b[at++]!;
    if (t & 0x80) {
      n += (t & 0x7f) + 1;
    } else if (t & 0x40) {
      let src = b[at++]!;
      let count = (t & 0x3f) + 1;
      if (src + count > 256) throw new Error('smacker: palette copy past entry 255');
      while (count-- > 0 && n < 256) {
        pal[n * 3] = old[src * 3]!;
        pal[n * 3 + 1] = old[src * 3 + 1]!;
        pal[n * 3 + 2] = old[src * 3 + 2]!;
        n++;
        src++;
      }
    } else {
      pal[n * 3] = SMK_PALETTE_SCALE[t]!;
      pal[n * 3 + 1] = SMK_PALETTE_SCALE[b[at++]! & 0x3f]!;
      pal[n * 3 + 2] = SMK_PALETTE_SCALE[b[at++]! & 0x3f]!;
      n++;
    }
  }
  if (n > 256) throw new Error('smacker: palette skip past entry 255');
  if (at > end) throw new Error('smacker: palette records run past the chunk');
  return at - start;
}

// ---- audio ------------------------------------------------------------

export interface SmackerAudioStats {
  track: number;
  /** chunk bytes after the length word */
  bytes: number;
  /** DPCM: the chunk's own unpacked size; PCM: bytes */
  unpackedSize: number;
  /** DPCM: bits read, including the 32-bit size (0 for PCM) */
  bitsRead: number;
  /** DPCM: the chunk said it holds no data */
  empty: boolean;
}

/**
 * Decodes one audio chunk to interleaved signed 16-bit samples (8-bit
 * sources are unsigned and scaled up).
 *
 * Packed chunks: u32 unpacked size, then bits: 1 data present, 1 stereo,
 * 1 16-bit; a Huffman byte tree per (channel, byte) - each a presence bit,
 * the tree, an end bit; the first sample of each channel, right channel
 * first, as 8 or 16 bits (16-bit: high byte first); then per sample a delta
 * from the channel's previous sample.
 * @portOnly
 */
export function decodeSmackerAudio(t: SmackerAudioTrack, b: Uint8Array, at: number, end: number): { samples: Int16Array; stats: SmackerAudioStats } {
  const bytes = end - at;
  if (t.codec === 'pcm') {
    if (t.bits === 8) {
      const s = new Int16Array(bytes);
      for (let i = 0; i < bytes; i++) s[i] = (b[at + i]! - 128) << 8;
      return { samples: s, stats: { track: t.track, bytes, unpackedSize: bytes, bitsRead: 0, empty: false } };
    }
    const s = new Int16Array(bytes >> 1);
    for (let i = 0; i < s.length; i++) s[i] = b[at + i * 2]! | (b[at + i * 2 + 1]! << 8);
    return { samples: s, stats: { track: t.track, bytes, unpackedSize: bytes, bitsRead: 0, empty: false } };
  }
  if (t.codec !== 'dpcm') {
    // Bink audio inside Smacker: not used by MechWarrior 2
    return { samples: new Int16Array(0), stats: { track: t.track, bytes, unpackedSize: 0, bitsRead: 0, empty: true } };
  }
  if (bytes < 4) throw new Error('smacker: audio chunk too short');
  const br = new Bits(b, at, end);
  const unpacked = br.bits(32);
  const stats: SmackerAudioStats = { track: t.track, bytes, unpackedSize: unpacked, bitsRead: 0, empty: false };
  if (!br.bit()) {
    stats.empty = true;
    stats.bitsRead = br.used;
    return { samples: new Int16Array(0), stats };
  }
  const stereo = br.bit();
  const sixteen = br.bit();
  if (stereo !== (t.channels === 2 ? 1 : 0) || sixteen !== (t.bits === 16 ? 1 : 0)) {
    throw new Error(`smacker: audio chunk says ${stereo ? 'stereo' : 'mono'} ${sixteen ? 16 : 8}-bit, track ${t.track} is ${t.channels}ch ${t.bits}-bit`);
  }
  const trees: Int32Array[] = [];
  for (let i = 0; i < 1 << (stereo + sixteen); i++) {
    br.bit(); // presence
    trees.push(readByteTree(br));
    br.bit(); // end of tree
  }
  const code = (i: number) => {
    const tr = trees[i]!;
    return tr[walk(tr, br)]!;
  };
  const pred = [0, 0];
  if (sixteen) {
    const n = unpacked >> 1;
    const s = new Int16Array(n);
    for (let c = stereo; c >= 0; c--) {
      const hi = br.bits(8);
      pred[c] = (((hi << 8) | br.bits(8)) << 16) >> 16;
    }
    let i = 0;
    for (; i <= stereo && i < n; i++) s[i] = pred[i]!;
    for (; i < n; i++) {
      const c = i & stereo;
      const lo = code(c * 2);
      const d = ((lo | (code(c * 2 + 1) << 8)) << 16) >> 16;
      pred[c] = ((pred[c]! + d) << 16) >> 16;
      s[i] = pred[c]!;
    }
    stats.bitsRead = br.used;
    return { samples: s, stats };
  }
  const n = unpacked;
  const s = new Int16Array(n);
  for (let c = stereo; c >= 0; c--) pred[c] = br.bits(8);
  let i = 0;
  for (; i <= stereo && i < n; i++) s[i] = (pred[i]! - 128) << 8;
  for (; i < n; i++) {
    const c = i & stereo;
    pred[c] = (pred[c]! + ((code(c) << 24) >> 24)) & 0xff;
    s[i] = (pred[c]! - 128) << 8;
  }
  stats.bitsRead = br.used;
  return { samples: s, stats };
}

// ---- frames -----------------------------------------------------------

export interface SmackerFrameStats {
  /** bytes of the palette chunk (0 when none) and how many its records used, length byte included */
  paletteBytes: number;
  paletteUsed: number;
  audio: SmackerAudioStats[];
  /** video bitstream: bytes available and bits read */
  videoBytes: number;
  videoBitsRead: number;
  /** blocks written; runs that would pass the frame's last block are cut short */
  blocks: number;
  /** blocks a run asked for past the frame's last block */
  blocksPastEnd: number;
  /** blocks by kind: mono, full, void, solid */
  blockKinds: [number, number, number, number];
}

export interface SmackerFrame {
  /** frame number (header.frames for the ring frame) */
  index: number;
  /** width * displayHeight palette indices; a copy */
  pixels: Uint8Array;
  /** 256 * 3, 8-bit components; a copy */
  palette: Uint8Array;
  paletteChanged: boolean;
  keyframe: boolean;
  /** per track 0..6, interleaved samples; empty when the frame has none for that track */
  audio: Int16Array[];
  stats: SmackerFrameStats;
}

const RUNS: Int32Array = Int32Array.from({ length: 64 }, (_, i) => (i < 59 ? i + 1 : 128 << (i - 59)));

/**
 * Decodes a Smacker file frame by frame. The frame buffer and palette carry
 * from frame to frame (every frame after the first is a delta); `reset`
 * starts over at frame 0 with both cleared.
 * @portOnly
 */
export class SmackerDecoder {
  readonly header: SmackerHeader;
  readonly trees: SmackerTreeInfo[];
  /** bits the four trees used, against header.treesSize * 8 */
  readonly treeBitsRead: number;
  /** the frame the next decodeNextFrame returns */
  nextFrame = 0;

  private readonly mmap: BigTree;
  private readonly mclr: BigTree;
  private readonly full: BigTree;
  private readonly type: BigTree;
  private readonly buf: Uint8Array;
  private readonly pal = new Uint8Array(768);

  constructor(
    readonly bytes: Uint8Array,
    header: SmackerHeader = parseSmacker(bytes),
  ) {
    this.header = header;
    const br = new Bits(bytes, header.treesOffset, header.treesOffset + header.treesSize);
    const [a, b, c, d] = header.treeSizes;
    this.mmap = new BigTree(br, 'MMAP', a);
    this.mclr = new BigTree(br, 'MCLR', b);
    this.full = new BigTree(br, 'FULL', c);
    this.type = new BigTree(br, 'TYPE', d);
    this.trees = [this.mmap.info, this.mclr.info, this.full.info, this.type.info];
    this.treeBitsRead = br.used;
    if (br.overrun) throw new Error('smacker: Huffman trees run past their data');
    this.buf = new Uint8Array(header.width * header.height);
  }

  /** back to frame 0, frame buffer and palette cleared */
  reset(): void {
    this.nextFrame = 0;
    this.buf.fill(0);
    this.pal.fill(0);
  }

  /** The next frame, or null after the last. */
  decodeNextFrame(): SmackerFrame | null {
    if (this.nextFrame >= this.header.frames) return null;
    return this.decodeFrame(this.nextFrame++);
  }

  /**
   * After the last frame of a movie with a ring frame: the ring frame, the
   * delta from the last frame back to frame 0's picture. Playback continues
   * with frame 1.
   */
  decodeRingFrame(): SmackerFrame {
    if (!this.header.ringFrame) throw new Error('smacker: no ring frame');
    const f = this.decodeFrame(this.header.frames);
    this.nextFrame = 1;
    return f;
  }

  private decodeFrame(index: number): SmackerFrame {
    const h = this.header;
    const b = this.bytes;
    let at = h.frameOffsets[index]!;
    const end = at + h.frameSizes[index]!;
    if (end > b.length) throw new Error(`smacker: frame ${index} runs past the file`);
    let flags = h.frameTypes[index]!;
    const stats: SmackerFrameStats = {
      paletteBytes: 0,
      paletteUsed: 0,
      audio: [],
      videoBytes: 0,
      videoBitsRead: 0,
      blocks: 0,
      blocksPastEnd: 0,
      blockKinds: [0, 0, 0, 0],
    };
    let paletteChanged = false;
    if (flags & 1) {
      const size = b[at]! * 4;
      if (size === 0 || at + size > end) throw new Error(`smacker: frame ${index} palette chunk of ${size} bytes`);
      stats.paletteBytes = size;
      stats.paletteUsed = 1 + applySmackerPalette(this.pal, b, at + 1, at + size);
      at += size;
      paletteChanged = true;
    }
    flags >>= 1;
    const audio: Int16Array[] = [];
    for (let track = 0; track < 7; track++, flags >>= 1) {
      if (!(flags & 1)) {
        audio.push(new Int16Array(0));
        continue;
      }
      const size = b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24);
      if (size < 4 || at + size > end) throw new Error(`smacker: frame ${index} track ${track} audio chunk of ${size} bytes`);
      const t = h.audio.find((x) => x.track === track);
      if (t) {
        const r = decodeSmackerAudio(t, b, at + 4, at + size);
        audio.push(r.samples);
        stats.audio.push(r.stats);
      } else audio.push(new Int16Array(0));
      at += size;
    }
    stats.videoBytes = end - at;
    this.decodeVideo(new Bits(b, at, end), stats);
    return {
      index,
      pixels: this.output(),
      palette: this.pal.slice(),
      paletteChanged,
      keyframe: (h.frameSizeFlags[index]! & 1) !== 0,
      audio,
      stats,
    };
  }

  private decodeVideo(br: Bits, stats: SmackerFrameStats): void {
    const { width: w, height: hgt, version } = this.header;
    const out = this.buf;
    const bw = w >> 2;
    const blocks = bw * (hgt >> 2);
    const { mmap, mclr, full, type } = this;
    mmap.reset();
    mclr.reset();
    full.reset();
    type.reset();
    const kinds = stats.blockKinds;
    let blk = 0;
    while (blk < blocks) {
      const code = type.get(br);
      const kind = code & 3;
      let run = RUNS[(code >> 2) & 0x3f]!;
      if (blk + run > blocks) {
        stats.blocksPastEnd += blk + run - blocks;
        run = blocks - blk;
      }
      kinds[kind] = kinds[kind]! + run;
      switch (kind) {
        case 0: // mono: two colours and a 16-bit map, bit set = high colour
          for (; run > 0; run--, blk++) {
            const clr = mclr.get(br);
            let map = mmap.get(br);
            const hi = clr >> 8;
            const lo = clr & 0xff;
            let p = ((blk / bw) | 0) * w * 4 + (blk % bw) * 4;
            for (let y = 0; y < 4; y++, p += w, map >>= 4) {
              out[p] = map & 1 ? hi : lo;
              out[p + 1] = map & 2 ? hi : lo;
              out[p + 2] = map & 4 ? hi : lo;
              out[p + 3] = map & 8 ? hi : lo;
            }
          }
          break;
        case 1: {
          // full: SMK4 adds two doubled modes, chosen once per run
          const mode = version !== 4 ? 0 : br.bit() ? 1 : br.bit() ? 2 : 0;
          for (; run > 0; run--, blk++) {
            let p = ((blk / bw) | 0) * w * 4 + (blk % bw) * 4;
            if (mode === 0) {
              // per row: the right pair, then the left pair
              for (let y = 0; y < 4; y++, p += w) {
                const r = full.get(br);
                const l = full.get(br);
                out[p] = l & 0xff;
                out[p + 1] = l >> 8;
                out[p + 2] = r & 0xff;
                out[p + 3] = r >> 8;
              }
            } else if (mode === 1) {
              // 2x2 pixels: one code per two rows, low byte left, high byte right
              for (let half = 0; half < 2; half++) {
                const c = full.get(br);
                for (let y = 0; y < 2; y++, p += w) {
                  out[p] = out[p + 1] = c & 0xff;
                  out[p + 2] = out[p + 3] = c >> 8;
                }
              }
            } else {
              // rows doubled: per row pair, the right pair then the left pair
              for (let half = 0; half < 2; half++) {
                const r = full.get(br);
                const l = full.get(br);
                for (let y = 0; y < 2; y++, p += w) {
                  out[p] = l & 0xff;
                  out[p + 1] = l >> 8;
                  out[p + 2] = r & 0xff;
                  out[p + 3] = r >> 8;
                }
              }
            }
          }
          break;
        }
        case 2: // void: unchanged
          blk += run;
          break;
        default: {
          // solid: the type code's high byte
          const c = code >> 8;
          for (; run > 0; run--, blk++) {
            let p = ((blk / bw) | 0) * w * 4 + (blk % bw) * 4;
            for (let y = 0; y < 4; y++, p += w) out[p] = out[p + 1] = out[p + 2] = out[p + 3] = c;
          }
        }
      }
    }
    stats.blocks = blk;
    stats.videoBitsRead = br.used;
  }

  /** the frame buffer at display height: Y-doubled rows repeated, Y-interlaced rows on even lines (odd lines 0) */
  private output(): Uint8Array {
    const { width: w, height: hgt, yDoubled, yInterlaced } = this.header;
    if (!yDoubled && !yInterlaced) return this.buf.slice();
    const o = new Uint8Array(w * hgt * 2);
    for (let y = 0; y < hgt; y++) {
      const row = this.buf.subarray(y * w, y * w + w);
      o.set(row, y * 2 * w);
      if (yDoubled) o.set(row, (y * 2 + 1) * w);
    }
    return o;
  }
}

/** A decoder over a whole Smacker file. @portOnly */
export function openSmacker(bytes: Uint8Array): SmackerDecoder {
  return new SmackerDecoder(bytes);
}
