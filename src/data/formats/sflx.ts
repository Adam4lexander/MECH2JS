/**
 * SNDS sound resources: the SFLX codec, and the RIFF WAV files that share the
 * resource type.
 *
 * SFLX, as sound_sample_open (0x3ffc0) reads it - it copies the first 14
 * bytes into the channel record, compares the tag and advances the data
 * pointer by 14:
 *
 *   +0x00  'SFLX'   compared; anything else is released and refused
 *   +0x04  uint     NOT READ by the game. On every SFLX record in MW2.PRJ it is
 *                   the payload length - 4 (tools/dump_sounds.py checks it)
 *   +0x08  uint     block count - the channel's remaining-blocks counter
 *   +0x0c  ushort   samples per block (0x80 in every resource)
 *   +0x0e  blocks, each one header byte and a method-dependent body, decoded
 *          by sflx_decode_blocks below
 *
 * sound_refill_buffers decodes min(remaining, 0x2000 / blockLen) blocks per
 * half buffer and stops at remaining == 0, so exactly the header's block count
 * is ever played. Most records carry one further block that is never decoded.
 *
 * The decoder's buffers are globals in the original: sflxScratch (0x9750c,
 * 0x401 bytes) and the upsamplers' temporary at 0x9710c (0x400 bytes, not
 * labelled). They are never cleared, so a block's output can depend on the
 * previous block decoded by ANY channel (method 1 repeats the scratch; the
 * upsamplers read one stored sample past the end). The port passes them in as
 * an SflxBuffers object; engine code keeps one shared instance, as the game
 * does. The predictor is per channel (a pointer argument).
 *
 * RIFF: 28 SNDS records are ordinary RIFF WAVE files, the ambient loops. The
 * game hands them to Miles (AIL_allocate_file_sample) and then overrides their
 * format to mono 8-bit (AIL_set_sample_type(h, 0, 0)) and their rate from
 * soundRateTable - see tools/dump_sounds.py. parseRiffWave only reads their
 * chunk headers.
 */

import { latin1 } from '../../core/binary/ByteReader.ts';
import type { ExeImage } from '../exe/ExeImage.ts';

export const SFLX_HEADER_SIZE = 14;
/** sound_sample_open sizes each half of the Miles double buffer at 0x2000 bytes. */
export const SFLX_BUFFER_BYTES = 0x2000;
/** sflxScratch is 0x401 bytes (0x9750c..0x9790c); the delta table follows at 0x9790d. */
export const SFLX_SCRATCH_SIZE = 0x401;
/** DAT_0009710c, the upsamplers' temporary, 0x400 bytes below sflxScratch. */
export const SFLX_TMP_SIZE = 0x400;

export interface SflxHeader {
  /** +0x04, not read by the game */
  sizeField: number;
  /** +0x08 */
  blocks: number;
  /** +0x0c */
  blockLen: number;
}

/**
 * The 14-byte header, or null when the tag is not 'SFLX' (the game releases
 * the resource and refuses the sound then).
 *
 * @portOnly the parse half of sound_sample_open (0x3ffc0); channel allocation belongs to the audio layer
 */
export function parseSflxHeader(payload: Uint8Array): SflxHeader | null {
  if (payload.length < SFLX_HEADER_SIZE || latin1(payload.subarray(0, 4)) !== 'SFLX') return null;
  const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  return { sizeField: dv.getUint32(4, true), blocks: dv.getUint32(8, true), blockLen: dv.getUint16(0xc, true) };
}

/** The decoder's global buffers (sflxScratch and the upsample temporary). */
export class SflxBuffers {
  /** sflxScratch, 0x9750c */
  readonly scratch = new Uint8Array(SFLX_SCRATCH_SIZE);
  /** DAT_0009710c */
  readonly tmp = new Uint8Array(SFLX_TMP_SIZE);

  /**
   * Both buffers are zero in the image at load (BSS). tools/dump_sounds.py
   * starts every sound from a scratch of 0x80s instead; pass fill = 0x80 to
   * reproduce its WAVs.
   */
  constructor(fill = 0) {
    if (fill) this.scratch.fill(fill);
  }
}

function srcByte(src: Uint8Array, p: number): number {
  const b = src[p];
  if (b === undefined) throw new RangeError(`sflx: read at ${p} past the end of the data (${src.length})`);
  return b;
}

/**
 * Upsamples the first blockLen / 2 bytes of the scratch buffer to blockLen, in
 * place, through the temporary: out[2k] = in[k], out[2k+1] = (in[k] +
 * in[k+1]) >> 1. The last step reads in[blockLen / 2], one past the stored
 * samples - whatever the previous block left there.
 *
 * @mw2 sflx_upsample_x2 0x00041aeb
 * @fidelity exact
 */
export function sflxUpsampleX2(buf: SflxBuffers, blockLen: number): void {
  const s = buf.scratch;
  const t = buf.tmp;
  let i = 0;
  do {
    const a = s[i >>> 1]!;
    t[i] = a;
    t[i + 1] = (a + s[(i >>> 1) + 1]!) >>> 1;
    i += 2;
  } while (i >>> 0 < (blockLen - 1) >>> 0);
  let n = blockLen;
  let k = 0;
  do {
    s[k] = t[k]!;
    k++;
    n = (n - 1) | 0;
  } while (n !== 0);
}

/**
 * As sflxUpsampleX2 but x4: a, (m + a) >> 1, m, (m + b) >> 1 with m = (a + b)
 * >> 1, a and b consecutive stored samples.
 *
 * @mw2 sflx_upsample_x4 0x00041a93
 * @fidelity exact
 */
export function sflxUpsampleX4(buf: SflxBuffers, blockLen: number): void {
  const s = buf.scratch;
  const t = buf.tmp;
  let i = 0;
  do {
    const j = i >>> 2;
    const a = s[j]!;
    const b = s[j + 1]!;
    t[i] = a;
    const m = (b + a) >>> 1;
    t[i + 2] = m;
    t[i + 1] = (m + a) >>> 1;
    t[i + 3] = (m + b) >>> 1;
    i += 4;
  } while (i >>> 0 < (blockLen - 1) >>> 0);
  let n = blockLen;
  let k = 0;
  do {
    s[k] = t[k]!;
    k++;
    n = (n - 1) | 0;
  } while (n !== 0);
}

/** Result of sflxDecodeBlocks: the advanced source offset, or null (the original's 0) on an unknown method. */
export type SflxDecodeResult = number | null;

/**
 * Decodes `blocks` SFLX blocks from src[srcPos] into dst[dstPos], blockLen
 * unsigned 8-bit samples each. Per block a header byte: the low nibble is the
 * METHOD, the top two bits a SHRINK (1 = half the samples stored, 2 = a
 * quarter, upsampled afterwards).
 *   0  silence: n stored samples of 0x80, predictor 0
 *   1  nothing decoded: the scratch still holds the previous block
 *   2  two deltas, then 1-bit codes, 8 per byte, LSB first
 *   3  four deltas, 2-bit codes, 4 per byte
 *   4  sixteen deltas, 4-bit codes, 2 per byte, low nibble first
 *   5  raw samples; the predictor becomes last - 0x80
 *   other  returns 0 (null here)
 * A delta byte b is zero-extended and means 2 * b - 0x80. Each code adds its
 * delta to the predictor, clamped to -127..127; the sample is predictor +
 * 0x80. Codes are decoded in whole bytes (a do-while), as the original does.
 * blocks must be at least 1: the original's do-while would run 2^32 times on 0
 * (its one caller never passes 0).
 *
 * @mw2 sflx_decode_blocks 0x00041854
 * @fidelity exact
 * @divergence a read past the end of src throws; the original reads whatever memory follows the resource
 */
export function sflxDecodeBlocks(
  src: Uint8Array,
  srcPos: number,
  dst: Uint8Array,
  dstPos: number,
  blocks: number,
  blockLen: number,
  predictor: { value: number },
  buf: SflxBuffers,
): SflxDecodeResult {
  const s = buf.scratch;
  // DAT_0009790d: the delta table, dwords, just past sflxScratch
  const deltas = new Int32Array(16);
  let out = dstPos;
  let p = srcPos;
  do {
    const head = srcByte(src, p);
    const shrink = head >>> 6;
    let n = shrink === 1 ? blockLen >>> 1 : shrink === 2 ? blockLen >>> 2 : blockLen;
    const method = head & 0xf;
    p = p + 1;
    let pred = predictor.value;
    if (method === 0) {
      for (let i = 0; n !== 0; n--) s[i++] = 0x80;
      pred = 0;
    } else if (method !== 1) {
      if (method === 2 || method === 3 || method === 4) {
        const bits = method === 2 ? 1 : method === 3 ? 2 : 4;
        const count = 1 << bits;
        const mask = count - 1;
        const per = 8 / bits;
        for (let k = 0; k < count; k++) deltas[k] = (srcByte(src, p++) * 2 - 0x80) | 0;
        let i = 0;
        do {
          let b = srcByte(src, p++);
          for (let k = per; k !== 0; k--) {
            const code = b & mask;
            b >>>= bits;
            pred = (deltas[code]! + pred) | 0;
            if (pred < 0x80) {
              if (pred < -0x7f) pred = -0x7f;
            } else pred = 0x7f;
            s[i] = (pred - 0x80) & 0xff;
            i = (i + 1) >>> 0;
          }
        } while (i >>> 0 < n >>> 0);
      } else if (method === 5) {
        let i = 0;
        let last: number;
        do {
          last = i;
          s[i] = srcByte(src, p++);
          n = (n - 1) >>> 0;
          i++;
        } while (n !== 0);
        pred = s[last]! - 0x80;
      } else {
        return null;
      }
    }
    if (shrink === 1) sflxUpsampleX2(buf, blockLen);
    else if (shrink === 2) sflxUpsampleX4(buf, blockLen);
    predictor.value = pred;
    for (let k = 0; k < blockLen; k++) dst[out++] = s[k]!;
    blocks = (blocks - 1) | 0;
  } while (blocks !== 0);
  return p;
}

export interface SflxBlockStats {
  /** header-byte method (low nibble) per block, in order */
  methods: number[];
  /** header-byte shrink (top two bits) per block */
  shrinks: number[];
}

export interface SflxSound {
  header: SflxHeader;
  /** exactly header.blocks * blockLen unsigned 8-bit samples */
  pcm: Uint8Array;
  /** payload offset just past the last counted block */
  end: number;
  /** set when a counted block has an unknown method (or the data ran out): decoding stopped there */
  error: string | null;
  /** blocks decoded into pcm before any error */
  decodedBlocks: number;
  stats: SflxBlockStats;
}

/**
 * Decodes a whole SFLX sound the way the refill loop does - all of its counted
 * blocks, a fresh predictor of 0, the buffers as given - one block per call so
 * that each block's method can be recorded (the result is the same as one call
 * for all of them: the state carries through `buf` and the predictor).
 *
 * @portOnly the loop of sound_refill_buffers (0x407b0) without the Miles buffers
 */
export function decodeSflx(payload: Uint8Array, buf: SflxBuffers = new SflxBuffers()): SflxSound | null {
  const header = parseSflxHeader(payload);
  if (!header) return null;
  const { blocks, blockLen } = header;
  const pcm = new Uint8Array(blocks * blockLen);
  const predictor = { value: 0 };
  const stats: SflxBlockStats = { methods: [], shrinks: [] };
  let p = SFLX_HEADER_SIZE;
  let error: string | null = null;
  let decodedBlocks = 0;
  for (let b = 0; b < blocks; b++) {
    if (p >= payload.length) {
      error = 'ran out of data';
      break;
    }
    const head = payload[p]!;
    stats.methods.push(head & 0xf);
    stats.shrinks.push(head >>> 6);
    const next = sflxDecodeBlocks(payload, p, pcm, b * blockLen, 1, blockLen, predictor, buf);
    if (next === null) {
      error = `method ${head & 0xf}`;
      break;
    }
    p = next;
    decodedBlocks++;
  }
  return { header, pcm, end: p, error, decodedBlocks, stats };
}

export interface RiffChunk {
  id: string;
  /** payload offset of the chunk's data */
  offset: number;
  length: number;
}

export interface RiffWave {
  chunks: RiffChunk[];
  formatTag: number;
  channels: number;
  rate: number;
  bitsPerSample: number;
  /** the 'data' chunk */
  data: Uint8Array;
}

/**
 * Reads the chunk headers of a RIFF WAVE payload (the SNDS ambient loops):
 * the first 'fmt ' and 'data' chunks win. Null if it is not RIFF/WAVE with
 * both.
 *
 * @portOnly the game hands these files to Miles' own loader (AIL_allocate_file_sample)
 */
export function parseRiffWave(payload: Uint8Array): RiffWave | null {
  if (payload.length < 12 || latin1(payload.subarray(0, 4)) !== 'RIFF' || latin1(payload.subarray(8, 12)) !== 'WAVE') return null;
  const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const chunks: RiffChunk[] = [];
  let pos = 12;
  while (pos + 8 <= payload.length) {
    const id = latin1(payload.subarray(pos, pos + 4));
    const length = dv.getUint32(pos + 4, true);
    chunks.push({ id, offset: pos + 8, length });
    pos += 8 + length + (length & 1);
  }
  const fmt = chunks.find((c) => c.id === 'fmt ');
  const dat = chunks.find((c) => c.id === 'data');
  if (!fmt || !dat) return null;
  return {
    chunks,
    formatTag: dv.getUint16(fmt.offset, true),
    channels: dv.getUint16(fmt.offset + 2, true),
    rate: dv.getUint32(fmt.offset + 4, true),
    bitsPerSample: dv.getUint16(fmt.offset + 14, true),
    data: payload.subarray(dat.offset, dat.offset + dat.length),
  };
}

// --- static tables in MW2.EXE the sound listing needs --------------------

export const SOUND_SETTINGS_INIT = 0x97e48;
export const SOUND_SETTINGS_INIT_COUNT = 0x90;
export const SOUND_RATE_TABLE = 0x970d0;
/** sound_channel_start's default priority when a sound has no record */
export const SOUND_DEFAULT_PRIORITY = 0x32;

export interface SoundSettingsRecord {
  id: number;
  priority: number;
  maxPlaying: number;
  /** -1 = soundRateTable[5] */
  rate: number;
}

/**
 * The 144 static {id, priority, maxPlaying, rate} short records that
 * sound_settings_init copies into soundSettings by id (0 < id < 0x4b0, later
 * records win).
 *
 * @mw2data soundSettingsInit 0x00097e48
 * @fidelity exact
 */
export function readSoundSettingsInit(exe: ExeImage): SoundSettingsRecord[] {
  const out: SoundSettingsRecord[] = [];
  for (let i = 0; i < SOUND_SETTINGS_INIT_COUNT; i++) {
    const a = SOUND_SETTINGS_INIT + i * 8;
    out.push({ id: exe.i16(a), priority: exe.i16(a + 2), maxPlaying: exe.i16(a + 4), rate: exe.i16(a + 6) });
  }
  return out;
}

/**
 * The ten playback rates in Hz; entry 5 (0x970e4) is the one-shot default.
 *
 * @mw2data soundRateTable 0x000970d0
 * @fidelity exact
 */
export function readSoundRateTable(exe: ExeImage): number[] {
  return Array.from({ length: 10 }, (_, i) => exe.i32(SOUND_RATE_TABLE + i * 4));
}
