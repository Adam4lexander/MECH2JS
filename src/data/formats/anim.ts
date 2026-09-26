/**
 * ANIM resources - the mech walk cycles and the vehicles' motion - as
 * res_load_anim (0x4bc60) reads them. Every one of the 38 ANIM resources in
 * MW2.PRJ fits this layout to the byte (test/golden/anims.test.ts):
 *
 *   +0x00  int N    track count
 *   +0x04  int K    frame count
 *   +0x08  N tracks, each: int slot, int channel, then K ints (one value per
 *          frame). The loader's AnimTrack gets +8 (channel) and a pointer to
 *          the values (+0xc).
 *   then   K AnimFrame records of 8 bytes, shared by all the tracks (every
 *          AnimTrack's +0x10 points at the same table)
 *
 * slot: the loader refuses the whole resource (returns 0) when a slot is
 * above 0x1f, or when slot + anim_track_base() is above 0x77f; it registers
 * the track at animTracks[slot + base]. 0..N-1 in every shipped resource.
 * It also keeps the track indices in a 32-entry stack array, so N > 32 would
 * overrun it; no resource comes close.
 *
 * channel (AnimTrack.channel), established by anim_player_step: 0/1/2
 * translate x/y/z, 3/4/5 rotate pitch/yaw/roll.
 *
 * AnimFrame (mw2_types.h, from anim_player_step): +0 flags, +1 flags2, +2..3
 * not read (0 in all 771 frames), +4 args[4] (signed state numbers).
 *
 * This file is the parse half only: registering tracks in animTracks and the
 * arena copies (tags ANFL / ANTK) are engine work.
 */

export interface AnimTrackRecord {
  /** byte offset of the track within the payload */
  offset: number;
  slot: number;
  /** AnimTrack.channel */
  channel: number;
  /** K values, one per frame */
  values: Int32Array;
}

export interface AnimFrameRecord {
  /** the 8 raw bytes */
  raw: Uint8Array;
  /** AnimFrame.flags, +0 */
  flags: number;
  /** AnimFrame.flags2, +1 */
  flags2: number;
  /** AnimFrame.args, +4..7, each a signed byte */
  args: [number, number, number, number];
}

export interface AnimResource {
  trackCount: number;
  frameCount: number;
  /** true when 8 + N * (8 + 4K) + 8K is exactly the payload length */
  fits: boolean;
  tracks: AnimTrackRecord[];
  /** offset of the frame table */
  framesOffset: number;
  frames: AnimFrameRecord[];
}

export const ANIM_FRAME_SIZE = 8;
/** res_load_anim's slot limit: a slot above this refuses the resource */
export const ANIM_MAX_SLOT = 0x1f;
/** ... and so does slot + anim_track_base() above this */
export const ANIM_MAX_TRACK_INDEX = 0x77f;

const s8 = (b: number): number => (b << 24) >> 24;

/**
 * Parses an ANIM payload. When the layout does not fit the payload exactly,
 * the header is returned with no tracks or frames (the loader itself does
 * not check the length; it would read past the resource).
 *
 * @portOnly the parse half of res_load_anim (0x4bc60); track registration belongs to the engine
 */
export function parseAnim(c: Uint8Array): AnimResource {
  const dv = new DataView(c.buffer, c.byteOffset, c.byteLength);
  const n = dv.getInt32(0, true);
  const k = dv.getInt32(4, true);
  const endTracks = 8 + n * (8 + 4 * k);
  const fits = endTracks + ANIM_FRAME_SIZE * k === c.length;
  const res: AnimResource = { trackCount: n, frameCount: k, fits, tracks: [], framesOffset: endTracks, frames: [] };
  if (!fits) return res;
  let p = 8;
  for (let t = 0; t < n; t++) {
    const values = new Int32Array(k);
    for (let i = 0; i < k; i++) values[i] = dv.getInt32(p + 8 + 4 * i, true);
    res.tracks.push({ offset: p, slot: dv.getInt32(p, true), channel: dv.getInt32(p + 4, true), values });
    p += 8 + 4 * k;
  }
  for (let i = 0; i < k; i++) {
    const raw = c.subarray(p + i * 8, p + i * 8 + 8);
    res.frames.push({ raw, flags: raw[0]!, flags2: raw[1]!, args: [s8(raw[4]!), s8(raw[5]!), s8(raw[6]!), s8(raw[7]!)] });
  }
  return res;
}

/**
 * Whether res_load_anim would register every track given the base
 * anim_track_base() returns, reproducing its two refusals (a signed compare
 * each; a negative slot passes both).
 *
 * @portOnly the loader's validity checks, separated from its registration
 */
export function animLoaderAccepts(a: AnimResource, trackBase: number): boolean {
  for (const t of a.tracks) {
    if (ANIM_MAX_SLOT < t.slot) return false;
    if (ANIM_MAX_TRACK_INDEX < ((t.slot + trackBase) | 0)) return false;
  }
  return true;
}
