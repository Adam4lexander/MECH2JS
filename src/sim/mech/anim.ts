/**
 * Animation resources: the ANIM chunk's loader and the animTracks registry
 * anim_player_step (a TSK anim task) plays tracks from.
 *
 * An ANIM resource is N tracks of K values plus one K-frame table all its
 * tracks share (data/formats/anim.ts has the layout). res_load_anim registers
 * track t at animTracks[t.slot + animTrackBase]; anim_ensure_loaded picks the
 * base and keeps a 60-entry cache of loaded animations with the base each got.
 *
 * QUIRK (label note on animTrackHighest): the next ANIM's base is one past the
 * highest track a TASK has referenced, not one past the tracks the previous
 * ANIM loaded, and while no task has run the base stays 0 - so every ANIM
 * loaded before the first anim task overlays the ones before it.
 */
import { AnimFrame, AnimTrack } from '../../generated/classes.gen.ts';
import { LABEL } from '../../generated/labels.gen.ts';
import { divergence, quirk } from '../../core/provenance.ts';
import type { StreamRef } from '../../data/bwd/stream.ts';
import { ANIM_FRAME_SIZE, ANIM_MAX_SLOT, ANIM_MAX_TRACK_INDEX } from '../../data/formats/anim.ts';
import { registerGlobals } from '../../engine/globals.ts';
import { imageI32 } from '../../engine/image.ts';
import { loadResourceRef } from '../../engine/resources/preload.ts';

export const ANIM_TRACK_COUNT = 0x780;
export const ANIM_CACHE_SIZE = 0x3c;

/**
 * An AnimTrack as res_load_anim fills it. `values` holds the track's K
 * values; `frames` points at the first entry of the shared frame table, as
 * the C pointer does, and `frameTable` is the whole table.
 *
 * @portOnly the generated AnimTrack types values as unknown and frames as a single AnimFrame
 */
export class AnimTrackLive extends AnimTrack {
  frameTable: AnimFrame[] = [];
}

/** One animCache pair: the id as the ANIM chunk gave it, and the base its tracks were registered at. @portOnly */
export interface AnimCacheEntry {
  id: number;
  base: number;
}

function bootAnim() {
  return {
    /** 0xd5498: AnimTrack pointers, one per registered track */
    animTracks: new Array<AnimTrackLive | null>(ANIM_TRACK_COUNT).fill(null),
    /** 0xd52b8: interleaved {id, base} pairs, 60 at most */
    animCache: Array.from({ length: ANIM_CACHE_SIZE }, (): AnimCacheEntry => ({ id: 0, base: 0 })),
    /** 0x95a58: filled animCache pairs */
    animCacheCount: imageI32(LABEL.animCacheCount, 0),
    /** 0x95a54: the animTracks slot the current ANIM's track 0 sits at */
    animTrackBase: imageI32(LABEL.animTrackBase, 0),
    /** 0x95a50: the highest animTracks slot an anim task has referenced (raised by anim_player_step only) */
    animTrackHighest: imageI32(LABEL.animTrackHighest, 0),
  };
}

export const anim = registerGlobals('anim', bootAnim(), () => {
  Object.assign(anim, bootAnim());
});

/**
 * The ANIM chunk handler: loads an animation unless animCache already holds
 * its id, and sets animTrackBase for it either way. Returns -1 on a cache hit,
 * res_load_anim's 0/1 on a load, and 0 when the cache is full (the
 * interpreter reports 0 as system_error 0x4f).
 *
 * The cache key is the chunk's id BEFORE resolution, so ANIM chunks that name
 * their resource (id -1) all share one entry.
 *
 * @mw2 anim_ensure_loaded 0x0001b1c0
 * @fidelity exact
 */
export function animEnsureLoaded(ref: StreamRef): number {
  const a = anim;
  const id = ref.id;
  let i = 0;
  while (i < a.animCacheCount && id !== a.animCache[i]!.id) i++;
  if (i < a.animCacheCount) {
    if (id === -1) quirk('anim_ensure_loaded: a named ANIM (id -1) hits the cache entry of the first named ANIM');
    a.animTrackBase = a.animCache[i]!.base;
    return -1;
  }
  if (a.animCacheCount >= ANIM_CACHE_SIZE) return 0;
  if (a.animTrackHighest > 0) a.animTrackBase = (a.animTrackHighest + 1) | 0;
  const r = resLoadAnim(ref);
  const e = a.animCache[a.animCacheCount]!;
  e.base = a.animTrackBase;
  e.id = id;
  a.animCacheCount++;
  return r;
}

/**
 * @mw2 anim_track_base 0x0001b250
 * @fidelity exact
 */
export function animTrackBase(): number {
  return anim.animTrackBase;
}

/**
 * Loads an ANIM resource (TABL 2 resolves a name; '.3di' is the loose-file
 * extension) and registers each track at animTracks[slot + animTrackBase],
 * then points every track at the shared frame table. Returns 1, or 0 when the
 * resource is missing or a track's slot is above 0x1f or lands above 0x77f -
 * a refusal part-way leaves the tracks registered so far in place, with no
 * frame table.
 *
 * AnimTrack.field_0x0 is set when the reference's id is -1 after the load,
 * which (resource_load_ref writing the resolved id back) is only when the
 * resource came from a loose file.
 *
 * @mw2 res_load_anim 0x0004bc60
 * @fidelity exact
 * @divergence the 'Couldn't load ID %s Type %s' line appended to symlog.txt is not written; the static-arena copies (ANFL, ANTK) are JS objects
 */
export function resLoadAnim(ref: StreamRef): number {
  const { data } = loadResourceRef(ref, 'ANIM', '.3di', 2);
  if (!data) {
    divergence(`res_load_anim: couldn't load ${ref.name} (symlog.txt not written)`);
    return 0;
  }
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const inside = (o: number, n: number): boolean => o >= 0 && o + n <= data.length;
  if (!inside(0, 8)) {
    divergence('res_load_anim: resource shorter than its header; the original reads past it');
    return 0;
  }
  const trackCount = dv.getInt32(0, true);
  const frameCount = dv.getInt32(4, true);
  const base = animTrackBase();
  const registered: number[] = [];
  let p = 8;
  for (let t = 0; t < trackCount; t++) {
    if (!inside(p, 8 + 4 * Math.max(0, frameCount))) {
      divergence('res_load_anim: track past the end of the resource; the original reads past it');
      return 0;
    }
    const channel = dv.getInt32(p + 4, true);
    const slot = dv.getInt32(p, true);
    if (ANIM_MAX_SLOT < slot) return 0;
    const index = (slot + base) | 0;
    if (ANIM_MAX_TRACK_INDEX < index) return 0;
    const values = new Int32Array(Math.max(0, frameCount));
    for (let k = 0; k < frameCount; k++) values[k] = dv.getInt32(p + 8 + 4 * k, true);
    p += 8 + 4 * Math.max(0, frameCount);
    if (index < 0) {
      divergence('res_load_anim: negative track index writes before animTracks in the original; skipped');
      continue;
    }
    const tr = new AnimTrackLive();
    anim.animTracks[index] = tr;
    tr.values = values;
    tr.channel = channel;
    tr.frameCount = frameCount;
    tr.field_0x0 = ref.id === -1 ? 1 : 0;
    registered.push(index);
  }
  const table: AnimFrame[] = [];
  for (let k = 0; k < frameCount; k++) {
    const o = p + k * ANIM_FRAME_SIZE;
    if (!inside(o, ANIM_FRAME_SIZE)) break;
    const f = new AnimFrame();
    f.flags = data[o]!;
    f.flags2 = data[o + 1]!;
    // char args[4], signed: kept as four chars, charCodeAt(i) << 24 >> 24 is args[i]
    f.args = String.fromCharCode(data[o + 4]!, data[o + 5]!, data[o + 6]!, data[o + 7]!);
    table.push(f);
  }
  for (const index of registered) {
    const tr = anim.animTracks[index]!;
    tr.frameTable = table;
    tr.frames = table[0] ?? null;
  }
  return 1;
}
