/**
 * The game's sound effects: the mixer block (SoundMixer, 0x508 bytes at
 * soundMixer) over the Miles digital driver, the per-sound settings, and the
 * calls that start a sound. Read from the disassembly on 2026-09-26 - the
 * decompiled C drops every Miles call's arguments and most of
 * sound_sample_open's returns; the annotations upstream record the details.
 *
 * Channels 0..7 play SFLX sounds streamed through a double buffer: a channel
 * is claimed and its sample initialised by sound_sample_open, and
 * sound_refill_buffers decodes the next chunk into whichever half Miles says
 * is free, once a frame. Miles starts the sample on the first buffer and runs
 * sound_sample_eos when the stream ends. Channels 8..15 belong to the
 * positional emitters (emitter.ts).
 */
import { fixedSin } from '../../core/angle/trig.ts';
import { vecToRangeBearing } from '../../core/math/vec.ts';
import { quirk } from '../../core/provenance.ts';
import { randomRange } from '../../core/random.ts';
import { parseSflxHeader, SflxBuffers, sflxDecodeBlocks } from '../../data/formats/sflx.ts';
import {
  ailAllocateSampleHandle,
  ailEndSample,
  ailInitSample,
  ailInstallDigDriverFile,
  ailLoadSampleBuffer,
  ailRegisterEosCallback,
  ailSampleBufferReady,
  ailSampleUserData,
  ailSetSamplePan,
  ailSetSamplePlaybackRate,
  ailSetSampleType,
  ailSetSampleUserData,
  ailSetSampleVolume,
  type WordRef,
} from '../../engine/miles/ail.ts';
import { clock } from '../../engine/clock.ts';
import { registerGlobals } from '../../engine/globals.ts';
import { imageI32, imageI32s } from '../../engine/image.ts';
import { cacheLoadResource, cacheUnlock } from '../../engine/resources/cache.ts';
import { SoundMixer } from '../../generated/classes.gen.ts';
import { cameraGlobals } from '../camera/viewer.ts';
import { mechs } from '../mech/mechGlobals.ts';

/** soundSettings: 1200 ids x {priority, maxPlaying, rate, playing} shorts */
export const SOUND_SETTINGS_IDS = 0x4b0;
const SOUND_RATE_TABLE = 0x970d0;
const SOUND_SETTINGS_INIT = 0x97e48;

/** A sound's settings row. @portOnly */
export const enum SoundSetting {
  Priority = 0,
  MaxPlaying = 1,
  Rate = 2,
  Playing = 3,
}

/** mw2snd.cfg's 15 dwords as the image holds them (0x97e00..0x97e38) */
function bootSoundConfig(): Int32Array {
  return Int32Array.from(imageI32s(0x97e00, 15, [0x10000, 0x10000, 0x10000, 0x10000, 0xb, 1, 1, 1, 1, 1, 8, 0, 0, 0, 0]));
}

export const sound = registerGlobals(
  'sound',
  {
    /** 0x970f8: the mixer block, null until sound_init (and without a DIG driver) */
    soundMixer: null as SoundMixer | null,
    /** 0x150370: soundSettings, 4 shorts per SNDS id */
    soundSettings: new Int16Array(SOUND_SETTINGS_IDS * 4),
    /**
     * 0x97e00..0x97e38: mw2snd.cfg's dwords - [1] sfxVolumeScale, [2]
     * voiceVolumeScale, [3] cdVolumeScale (16.16), [4] soundFlags (2 speech,
     * 4 XMIDI music, 8 CD music)
     */
    soundConfig: bootSoundConfig(),
    /** 0x15036c: the enemy-lock warning's next check */
    enemyLockWarnTick: 0,
    /** 0x97de0: the voice line's HSAMPLE while one plays (voice.ts) */
    voiceSample: 0,
    /** sflxScratch (0x9750c) and the upsamplers' temporary: one pair, shared by every channel */
    sflxBuffers: new SflxBuffers(),
  },
  () => {
    sound.soundMixer = null;
    sound.soundSettings.fill(0);
    sound.soundConfig = bootSoundConfig();
    sound.enemyLockWarnTick = 0;
    sound.voiceSample = 0;
    sound.sflxBuffers = new SflxBuffers();
  },
);

/** soundSettings[id][field], as the short the game reads (any id; out of range reads 0). @portOnly */
export function soundSetting(id: number, field: SoundSetting): number {
  if (id === -1 && field === SoundSetting.Playing) return enemyLockWarnHigh();
  return id >= 0 && id < SOUND_SETTINGS_IDS ? sound.soundSettings[id * 4 + field]! : 0;
}

/**
 * soundSettings[-1].playing is the short at 0x15036e - the high half of
 * enemyLockWarnTick, which sits just below the table.
 */
function enemyLockWarnHigh(): number {
  return (sound.enemyLockWarnTick >> 16) << 16 >> 16;
}

export const sfxVolumeScale = (): number => sound.soundConfig[1]!;
export const voiceVolumeScale = (): number => sound.soundConfig[2]!;
export const cdVolumeScale = (): number => sound.soundConfig[3]!;
export const soundFlags = (): number => sound.soundConfig[4]!;

/** a * b in 16.16 with the round-half-up of shrd + adc (b a 16.16 scale). */
function mulRound16(a: number, b: number): number {
  const p = BigInt(a | 0) * BigInt(b | 0);
  return Number(BigInt.asIntN(32, (p >> 16n) + ((p >> 15n) & 1n)));
}

/**
 * Fills soundSettings with 0xff (every field -1) and copies in the 144
 * {id, priority, maxPlaying, rate} records, zeroing each one's play count.
 *
 * @mw2 sound_settings_init 0x000441b0
 * @fidelity exact
 */
export function soundSettingsInit(): void {
  const t = sound.soundSettings;
  t.fill(-1);
  const recs = imageI32s(SOUND_SETTINGS_INIT, 0x90 * 2, []);
  for (let i = 0; i < 0x90; i++) {
    const lo = recs[i * 2] ?? 0;
    const hi = recs[i * 2 + 1] ?? 0;
    const id = (lo << 16) >> 16;
    if (0 < id && id < SOUND_SETTINGS_IDS) {
      t[id * 4] = lo >> 16;
      t[id * 4 + 1] = (hi << 16) >> 16;
      t[id * 4 + 2] = hi >> 16;
      t[id * 4 + 3] = 0;
    }
  }
}

/**
 * sound_open_driver_ini(0): the DIG driver dig.ini names.
 *
 * @mw2 sound_install_dig_driver 0x00044020
 * @fidelity partial
 * @divergence no dig.ini is read: the port's Miles layer has its one driver
 */
export function soundInstallDigDriver(): number {
  return ailInstallDigDriverFile();
}

/**
 * Brings up the mixer: the block, the DIG driver, and n (at most 16) sample
 * handles with a 0x4000-byte double buffer each. Returns 1, -1 when already
 * up, -4 without a driver.
 *
 * @mw2 sound_init 0x000405c0
 * @fidelity exact
 */
export function soundInit(n: number): number {
  if (sound.soundMixer) return -1;
  const m = new SoundMixer();
  sound.soundMixer = m;
  // five AIL_set_preference calls: 1 (DIG_HARDWARE_SAMPLE_RATE) 11025, 8 0, 7 1, 3 (latency) 40, 0x11 0 - the port's driver is fixed
  m.digDriver = soundInstallDigDriver();
  if (m.digDriver === 0) {
    sound.soundMixer = null;
    return -4;
  }
  m.channelCount = n >>> 0 < 0x11 ? n : 0x10;
  for (let ch = 0; ch >>> 0 < m.channelCount >>> 0; ch++) {
    const h = ailAllocateSampleHandle();
    m.sampleHandles[ch] = h;
    if (h === 0) {
      m.channelCount = ch;
      break;
    }
    m.halfBuffers[ch * 2] = { bytes: new Uint8Array(0x4000), offset: 0 };
  }
  for (let ch = 0; ch >>> 0 < m.channelCount >>> 0; ch++) {
    m.inUse[ch] = 0;
    m.startTick[ch] = -1;
    m.bearing[ch] = 0;
    m.pan[ch] = 0x40;
  }
  return 1;
}

/**
 * Ends every playing channel and frees the buffers and the block.
 *
 * @mw2 sound_shutdown 0x00040740
 * @fidelity exact
 */
export function soundShutdown(): void {
  const m = sound.soundMixer;
  if (!m) return;
  for (let ch = 0; ch >>> 0 < m.channelCount >>> 0; ch++) {
    if (m.inUse[ch] !== 0) {
      ailEndSample(m.sampleHandles[ch]!);
      m.inUse[ch] = 0;
    }
  }
  sound.soundMixer = null;
}

/** the channel's own inUse word, as sound_sample_open's default user data 0 */
function inUseRef(m: SoundMixer, ch: number): WordRef {
  return { get: () => m.inUse[ch]!, set: (v) => (m.inUse[ch] = v) };
}

/** user data 0: -1 (the channel's inUse word), 0 (leave it) or a word */
export type UserWord = WordRef | -1 | 0;

/**
 * Claims a channel for SNDS `id` - or for a caller's buffer, when `buffer` is
 * given - loads the SFLX header and initialises the channel's Miles sample.
 * The rules (see the upstream annotation): a named channel must be free; a
 * scan otherwise takes the first free channel, skipping reserved (0x100)
 * ones - refusing outright when this request is reserved too - refusing a
 * 0x400 duplicate, ending a 0x200 duplicate, and failing that stealing the
 * LAST busy channel whose priority byte is below the whole flags word.
 * Returns the channel, or -10 (maxPlaying reached, or a 0x400 duplicate), -9,
 * -8 (no channel), -7 (not SFLX), -6 (no sound).
 *
 * @mw2 sound_sample_open 0x0003ffc0
 * @fidelity exact
 */
export function soundSampleOpen(soundId: number, buffer: Uint8Array | null, flags: number, channel: number, user: UserWord): number {
  const m = sound.soundMixer!;
  let id = soundId;
  if (buffer) id = -1;
  flags &= 0xffff;
  if (0 < id) {
    const playing = soundSetting(id, SoundSetting.Playing);
    const max = soundSetting(id, SoundSetting.MaxPlaying);
    if (playing !== -1 && max !== -1 && playing >= max) return -10;
  } else if (!buffer) return -6;
  let free = -1;
  const named = (channel << 16) >> 16;
  if (named !== -1) {
    if (m.inUse[named] !== 0) return -8;
    free = named;
  }
  let steal = -1;
  if (free === -1) {
    for (let ch = 0; ch >>> 0 < m.channelCount >>> 0 && free === -1; ch++) {
      const f = m.flags[ch]! & 0xffff;
      if ((f & 0xff00) !== 0) {
        if ((f & 0x100) !== 0) {
          if ((flags & 0x100) !== 0) return -9;
          continue;
        }
        if ((f & 0x400) !== 0 && (flags & 0x400) !== 0 && id === m.soundId[ch]) return -10;
        if ((f & 0x200) !== 0 && (flags & 0x200) !== 0 && id === m.soundId[ch]) {
          ailEndSample(m.sampleHandles[ch]!);
          m.inUse[ch] = 0;
          m.flags[ch] = 0;
        }
      }
      if (m.inUse[ch] === 0) free = ch;
      else if ((m.flags[ch]! & 0xff) < flags) steal = ch;
    }
    if (free === -1) {
      if (steal === -1) return -8;
      ailEndSample(m.sampleHandles[steal]!);
      free = steal;
      m.inUse[steal] = 0;
    }
  }
  const ch = free;
  if (buffer) m.data[ch] = { bytes: buffer, offset: 0 };
  else {
    const res = cacheLoadResource(id, 'SNDS');
    m.data[ch] = res ? { bytes: res, offset: 0 } : null;
    if (!res) return -6;
  }
  const d = m.data[ch]!;
  m.headers.set(d.bytes.subarray(d.offset, d.offset + 14), ch * 14);
  d.offset += 14;
  const hdr = parseSflxHeader(m.headers.subarray(ch * 14, ch * 14 + 14));
  if (!hdr) {
    if (!buffer) cacheUnlock(id, 'SNDS');
    m.data[ch] = null;
    return -7;
  }
  m.flags[ch] = flags;
  m.soundId[ch] = id;
  m.blocksLeft[ch] = hdr.blocks;
  m.blockLen[ch] = hdr.blockLen;
  m.blocksPerHalf[ch] = Math.floor(0x2000 / hdr.blockLen);
  m.halfBytes[ch] = Math.imul(hdr.blockLen, m.blocksPerHalf[ch]!);
  const mem = m.halfBuffers[ch * 2]!;
  m.halfBuffers[ch * 2 + 1] = { bytes: mem.bytes, offset: mem.offset + m.halfBytes[ch]! };
  m.chunkBlocks[ch] = m.blocksPerHalf[ch]! >>> 0 > m.blocksLeft[ch]! >>> 0 ? m.blocksLeft[ch]! : m.blocksPerHalf[ch]!;
  m.predictor[ch] = 0;
  const h = m.sampleHandles[ch]!;
  ailInitSample(h);
  const u = user === -1 ? inUseRef(m, ch) : user;
  if (u !== 0) ailSetSampleUserData(h, 0, u);
  ailSetSampleUserData(h, 1, id);
  ailSetSampleUserData(h, 2, ch);
  ailSetSampleUserData(h, 3, 0);
  ailSetSampleUserData(h, 4, buffer);
  ailRegisterEosCallback(h, soundSampleEos);
  if (0 < id && soundSetting(id, SoundSetting.Playing) !== -1) sound.soundSettings[id * 4 + SoundSetting.Playing]! += 1;
  return ch;
}

/**
 * The end-of-sample callback (see the upstream name note): frees the channel,
 * or reopens it with a chained id - a voice line's body after its prefix.
 *
 * @mw2 sound_sample_eos 0x00040460
 * @fidelity exact
 */
export function soundSampleEos(h: number): void {
  const m = sound.soundMixer!;
  const id = ailSampleUserData(h, 1) as number;
  const ch = ailSampleUserData(h, 2) as number;
  let next = ailSampleUserData(h, 3) as number;
  m.inUse[ch] = 0;
  if (id === -1) {
    // the playing count of id -1 is the short below soundSettings: enemyLockWarnTick's high half
    if (0 < enemyLockWarnHigh()) {
      quirk('sound_sample_eos: a caller-buffer sound (id -1) decrements the high half of enemyLockWarnTick', 'sound_sample_eos');
      sound.enemyLockWarnTick = (sound.enemyLockWarnTick - 0x10000) | 0;
    }
  } else if (0 < soundSetting(id, SoundSetting.Playing)) sound.soundSettings[id * 4 + SoundSetting.Playing]! -= 1;
  if (id !== 0 && 0 < id) cacheUnlock(id, 'SNDS');
  // user data 4, a caller buffer, is freed: nothing to do in JS
  if (next !== 0) {
    if (next !== -1) {
      const r = soundSampleOpen(next, null, m.flags[ch]!, ch, 0);
      if (r < 0) {
        cacheUnlock(next, 'SNDS');
        next = 0;
      } else {
        ailSetSampleUserData(h, 1, next);
        ailSetSampleUserData(h, 3, (m.flags[ch]! & 0x1000) !== 0 ? next : -1);
        m.inUse[ch] = 1;
      }
    } else next = 0;
  }
  if (next === 0) {
    m.soundId[ch] = 0;
    m.flags[ch] = 0;
    (ailSampleUserData(h, 0) as WordRef).set(0);
  }
}

/**
 * Per frame, every playing SFLX channel whose start tick has come and whose
 * sample has a free half buffer: pan (from the bearing when pan is -1) and
 * volume, then the next min(remaining, chunk) blocks decoded into the half -
 * or, with none left, a 0-length buffer that ends the stream.
 *
 * @mw2 sound_refill_buffers 0x000407b0
 * @fidelity exact
 */
export function soundRefillBuffers(): void {
  const m = sound.soundMixer;
  if (!m) return;
  for (let ch = 0; ch >>> 0 < m.channelCount >>> 0; ch++) {
    if (m.inUse[ch] === 0 || !m.data[ch] || clock.simTick < m.startTick[ch]!) continue;
    const h = m.sampleHandles[ch]!;
    const n = ailSampleBufferReady(h);
    if (n === -1) continue;
    ailSetSamplePan(h, m.pan[ch] === -1 ? soundPanFromBearing(m.bearing[ch]!) : m.pan[ch]!);
    ailSetSampleVolume(h, m.volume[ch]!);
    const half = m.halfBuffers[ch * 2 + n]!;
    let len = 0;
    if (m.blocksLeft[ch] !== 0) {
      const d = m.data[ch]!;
      const pred = { value: m.predictor[ch]! };
      const last = m.chunkBlocks[ch]! >>> 0 >= m.blocksLeft[ch]! >>> 0;
      const blocks = last ? m.blocksLeft[ch]! : m.chunkBlocks[ch]!;
      const p = sflxDecodeBlocks(d.bytes, d.offset, half.bytes, half.offset, blocks, m.blockLen[ch]!, pred, sound.sflxBuffers);
      m.predictor[ch] = pred.value;
      m.data[ch] = p === null ? null : { bytes: d.bytes, offset: p };
      if (last) {
        len = Math.imul(m.blockLen[ch]!, m.blocksLeft[ch]!);
        m.blocksLeft[ch] = 0;
      } else {
        m.blocksLeft[ch] = (m.blocksLeft[ch]! - m.chunkBlocks[ch]!) | 0;
        len = m.halfBytes[ch]!;
      }
    }
    ailLoadSampleBuffer(h, n, half, len);
  }
}

/**
 * Starts a sound on a channel from sound_sample_open, at the sound's own rate
 * (11025 for every sound), with its start tick pushed on by `delay` when that
 * is more than tickDelta. Stores pan, bearing and volume * scale. The rate
 * argument is never read.
 *
 * @mw2 sound_channel_start 0x000409b0
 * @fidelity exact
 */
export function soundChannelStart(
  delay: number,
  bearing: number,
  soundId: number,
  buffer: Uint8Array | null,
  volume: number,
  scale: number,
  pan: number,
  _rate: number,
  user: UserWord,
  flags: number,
): number {
  const m = sound.soundMixer;
  if (!m) return -2;
  if (volume === 0) return -0xb; // cmp 0 / ja: a negative volume passes
  let f = (flags & 0xff00) | 0x32;
  if (soundId < 1) {
    if (!buffer) return -6;
  } else if (soundSetting(soundId, SoundSetting.Priority) !== -1) f = (flags & 0xff00) | (soundSetting(soundId, SoundSetting.Priority) & 0xffff);
  const ch = soundSampleOpen(soundId, buffer, f & 0xffff, -1, user);
  if (ch < 0) return ch;
  const h = m.sampleHandles[ch]!;
  ailSetSampleType(h, 0, 0);
  const rate = 0 < soundId && soundSetting(soundId, SoundSetting.Rate) !== -1 ? soundSetting(soundId, SoundSetting.Rate) : imageI32(SOUND_RATE_TABLE + 5 * 4, 11025);
  ailSetSamplePlaybackRate(h, rate);
  m.startTick[ch] = clock.simTick;
  if (clock.tickDelta < delay) m.startTick[ch] = (m.startTick[ch]! + delay) | 0;
  m.pan[ch] = pan;
  m.bearing[ch] = bearing;
  m.inUse[ch] = 1;
  m.volume[ch] = mulRound16(volume, scale);
  return ch;
}

/**
 * The one-shot play call: SNDS id, volume (scaled by sfxVolumeScale), pan
 * (0x40 centre) and flags (only the high byte survives). rateIndex selects a
 * soundRateTable entry that sound_channel_start never reads.
 *
 * @mw2 sound_play 0x00040c50
 * @fidelity exact
 */
export function soundPlay(id: number, volume: number, pan: number, rateIndex: number, flags: number): void {
  soundChannelStart(0, 0, id, null, volume, sfxVolumeScale(), pan, imageI32(SOUND_RATE_TABLE + rateIndex * 4, 0), -1, flags);
}

/**
 * A one-shot at a given rate argument (never read) with flags 0x450 - the
 * PAUSE key's two sounds.
 *
 * @mw2 sound_sfx_sub_040b50 0x00040b50
 * @fidelity exact
 */
export function soundSfxSub040b50(id: number, volume: number, pan: number, rate: number): void {
  soundChannelStart(0, 0, id, null, volume, sfxVolumeScale(), pan, rate, -1, 0x450);
}

/**
 * Always 0 in this build.
 *
 * @mw2 sound_seq_sub_041560 0x00041560
 * @fidelity exact
 */
export function soundSeqSub041560(): number {
  return 0;
}

/**
 * One of the ten rates at random - consuming a random number, whatever the
 * caller does with it.
 *
 * @mw2 sound_random_rate 0x00040d50
 * @fidelity exact
 */
export function soundRandomRate(): number {
  return imageI32(SOUND_RATE_TABLE + randomRange(10) * 4, 11025);
}

/**
 * sound_channel_start with a start delay and a bearing, scaled by
 * sfxVolumeScale; the random rate it passes is never read.
 *
 * @mw2 sound_play_delayed 0x00040c90
 * @fidelity exact
 */
export function soundPlayDelayed(delay: number, bearing: number, id: number, volume: number, pan: number, flags: number): void {
  if (soundSeqSub041560() < 1) {
    const rate = soundRandomRate();
    soundChannelStart(delay, bearing, id, null, volume, sfxVolumeScale(), pan, rate, -1, flags);
  }
}

/**
 * A one-shot 3D sound: volume 100 * (1 - (d / 500 m)^2), halved when asked,
 * delayed d * 360 / 65536 ticks (sound at 331 m/s), panned from the bearing
 * at every refill. Returns d.
 *
 * @mw2 sound_play_positional 0x00040bc0
 * @fidelity exact
 */
export function soundPlayPositional(dx: number, dy: number, dz: number, id: number, halveVolume: number): number {
  const rb = vecToRangeBearing(dx, dy, dz);
  const d = rb.slantRange;
  let vol = 0;
  if (d < 0xc351) {
    const q = (d / 100) | 0;
    vol = (100 - (((q * q * 100) / 250000) | 0)) | 0;
  }
  if (0 < vol) {
    if (halveVolume !== 0) vol >>= 1;
    soundPlayDelayed(mulRound16(d, imageI32(0x957ac, 360)), rb.azimuth, id, vol, -1, 0x32);
  }
  return d;
}

/**
 * Plays a sound at an offset from the listener (callers difference against
 * viewerPosition); halveVolume halves it.
 *
 * @mw2 sound_play_at 0x00040cf0
 * @fidelity exact
 */
export function soundPlayAt(dx: number, dy: number, dz: number, id: number, halveVolume: number): number {
  return soundPlayPositional(dx, dy, dz, id, halveVolume);
}

/**
 * Miles pan from a source azimuth: sin(viewer yaw - azimuth) >> 0x17 + 0x40,
 * clamped to 0x0f..0x6f.
 *
 * @mw2 sound_pan_from_bearing 0x00040d10
 * @fidelity exact
 */
export function soundPanFromBearing(azimuth: number): number {
  const v = cameraGlobals.viewerPosition!;
  const p = ((fixedSin((v.yaw - azimuth) | 0) >> 0x17) + 0x40) | 0;
  if (p < 0xf) return 0xf;
  return 0x6f < p ? 0x6f : p;
}

/**
 * Ends every in-use channel of all 16, except the voice line's unless `all`.
 *
 * @mw2 sound_stop_channels 0x00040d70
 * @fidelity exact
 */
export function soundStopChannels(all: number): void {
  const m = sound.soundMixer;
  if (!m) return;
  for (let ch = 0; ch < 0x10; ch++) {
    if (m.inUse[ch] !== 0 && (sound.voiceSample !== m.sampleHandles[ch] || all !== 0)) {
      ailEndSample(m.sampleHandles[ch]!);
      m.inUse[ch] = 0;
    }
  }
}

/**
 * main's per-frame sound step: the refill, then every 0x38e ticks the
 * enemy-lock warning (SNDS 0x100) when another mech in aiState 2 or 3 has
 * the player as its secondary target within 0x249f0 cm.
 *
 * @mw2 sound_frame_update 0x00043e50
 * @fidelity exact
 */
export function soundFrameUpdate(): void {
  soundRefillBuffers();
  if (sound.enemyLockWarnTick <= clock.simTick) {
    sound.enemyLockWarnTick = (clock.simTick + 0x38e) | 0;
    if ((mechs.mechTable[mechs.playerMechIndex]!.flags & 0x16) !== 0) return;
    for (let i = 0; i < mechs.mechCount; i++) {
      const e = mechs.mechTable[i]!;
      if (mechs.playerMechIndex !== e.index && (e.targetSecondary & 0xff) === mechs.playerMechIndex && (e.aiState === 2 || e.aiState === 3) && e.targetSlantRange < 0x249f1) {
        soundPlay(0x100, 100, 0x40, 5, 0x32);
        return;
      }
    }
  }
}
