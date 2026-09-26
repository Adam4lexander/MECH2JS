/**
 * The positional sound emitters task_object_sound attaches to mission
 * objects: a RIFF WAV loop (the 28 RIFF SNDS records) played as a Miles file
 * sample on one of the mixer channels 8..15, which sound_init never gives a
 * handle - the emitters claim them directly.
 *
 * The offset an emitter measures is viewer - source; sound_play_at's callers
 * differ (the mech and damage sounds pass source - viewer, weapon fire and
 * effect_spawn viewer - source), so one of the two groups is panned mirrored.
 * Which was intended is not established; the port keeps each as it is.
 */
import { fixedSin } from '../../core/angle/trig.ts';
import { vecToRangeBearing } from '../../core/math/vec.ts';
import { randomRange } from '../../core/random.ts';
import {
  ailAllocateFileSample,
  ailEndSample,
  ailReleaseSampleHandle,
  ailSetSampleLoopCount,
  ailSetSamplePan,
  ailSetSamplePlaybackRate,
  ailSetSampleType,
  ailSetSampleVolume,
  ailStartSample,
} from '../../engine/miles/ail.ts';
import { imageI32 } from '../../engine/image.ts';
import { cacheLoadResource, cacheUnlock } from '../../engine/resources/cache.ts';
import { sceneNodeGetWorldPos } from '../../engine/scene/sceneGraph.ts';
import type { SceneNode, WorldObject } from '../../generated/classes.gen.ts';
import { cameraGlobals } from '../camera/viewer.ts';
import { sfxVolumeScale, sound } from './mixer.ts';

/**
 * The 0x1e-byte state task_object_sound builds: [0] cutoff range (cm), [1]
 * mixer channel (8..15, -1 none), [2] the loaded SNDS resource, [3] object
 * slot, [4] its node, [5] gate, [6] first-call skip, +0x1c the SNDS id.
 *
 * @portOnly the emitter record as named fields
 */
export interface SoundEmitter {
  cutoff: number;
  channel: number;
  resource: Uint8Array | null;
  slot: { get(): WorldObject | null } | null;
  node: SceneNode | null;
  gate: number;
  skipFirst: number;
  soundId: number;
}

/**
 * One tick: past its cutoff it stops; otherwise it takes the first free
 * channel of 8..15, loads the SNDS resource and allocates a looping file
 * sample (flags 0x1000), then sets pan from the bearing, volume
 * (100 * (1 - (d / 500 m)^2)) * sfxVolumeScale / 4 - stopping at zero - and a
 * random rate from soundRateTable every tick, and starts the sample when it
 * is new or its channel was stopped.
 *
 * @mw2 sound_emitter_update 0x00040df0
 * @fidelity exact
 */
export function soundEmitterUpdate(e: SoundEmitter): void {
  const m = sound.soundMixer;
  if (!m) return;
  if (e.skipFirst !== 0) {
    e.skipFirst = 0;
    return;
  }
  let fresh = false;
  const [x, y, z] = sceneNodeGetWorldPos(e.node!);
  const v = cameraGlobals.viewerPosition!;
  const rb = vecToRangeBearing((v.posX - x) | 0, (v.posY - y) | 0, (v.posZ - z) | 0);
  const d = rb.slantRange;
  if (e.cutoff < d) {
    soundEmitterStop(e);
    return;
  }
  if (e.channel === -1) {
    for (let ch = 8; ch < 0x10; ch++) {
      if (m.inUse[ch] === 0) {
        e.channel = ch;
        break;
      }
    }
    if (e.channel === -1) return;
    if (!e.resource) e.resource = cacheLoadResource(e.soundId, 'SNDS');
    const h = ailAllocateFileSample(e.resource);
    if (h === 0) {
      cacheUnlock(e.soundId, 'SNDS');
      e.channel = -1;
      e.resource = null;
      return;
    }
    m.sampleHandles[e.channel] = h;
    m.soundId[e.channel] = e.soundId;
    m.flags[e.channel] = 0x1000;
    ailSetSampleType(h, 0, 0);
    ailSetSampleLoopCount(h, 0);
    fresh = true;
  }
  const h = m.sampleHandles[e.channel]!;
  let vol = 0;
  if (d <= 0xc350) {
    const q = (d / 100) | 0;
    vol = (100 - (((q * q * 100) / 250000) | 0)) | 0;
  }
  if (vol <= 0) {
    soundEmitterStop(e);
    return;
  }
  const p = BigInt(vol) * BigInt(sfxVolumeScale());
  const volume = Number(BigInt.asIntN(32, (p >> 16n) + ((p >> 15n) & 1n))) >> 2;
  let pan = ((fixedSin((v.yaw - rb.azimuth) | 0) >> 0x17) + 0x40) | 0;
  if (pan < 0xf) pan = 0xf;
  else if (0x6f < pan) pan = 0x6f;
  ailSetSamplePan(h, pan);
  ailSetSampleVolume(h, volume);
  ailSetSamplePlaybackRate(h, imageI32(0x970d0 + randomRange(10) * 4, 11025));
  if (fresh || m.inUse[e.channel] === 0) {
    ailStartSample(h);
    m.inUse[e.channel] = 1;
  }
}

/**
 * Ends an emitter's sample when it has one loaded: clears its channel,
 * ends and releases the sample, unlocks the resource.
 *
 * @mw2 sound_emitter_stop 0x00041070
 * @fidelity exact
 */
export function soundEmitterStop(e: SoundEmitter): void {
  const m = sound.soundMixer;
  if (!e.resource || !m) return;
  const h = m.sampleHandles[e.channel]!;
  m.sampleHandles[e.channel] = 0;
  m.inUse[e.channel] = 0;
  m.soundId[e.channel] = 0;
  e.channel = -1;
  ailEndSample(h);
  ailReleaseSampleHandle(h);
  cacheUnlock(e.soundId, 'SNDS');
  e.resource = null;
}
