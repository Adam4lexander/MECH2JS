/**
 * The Miles Sound System (AIL 3.03), the part of it MW2 calls: digital
 * samples on the DIG driver and channel messages on the MDI driver.
 *
 * Miles is library code linked into MW2.EXE (0x5c510..0x7d9a0), and the port
 * does not port it line by line. What it keeps is the behaviour the game can
 * see, read from Miles' own code in the EXE (2026-09-26):
 *
 *   - AIL_init_sample (0x7a2f0): status 2 DONE, both buffers empty, current
 *     buffer 1, last-switched 0, last-ready -2, loop count 1, format 0,
 *     11025 Hz, the default volume, pan 0x40.
 *   - AIL_sample_buffer_ready (0x7a810): -2 -> answers 0 (and makes buffer 0
 *     the current one), -1 -> answers 1, then answers the other buffer each
 *     time the mixer has switched since the last answer, else -1.
 *   - AIL_load_sample_buffer (0x7a790): stores the buffer, marks it done when
 *     its length is 0, and starts a sample that is not playing.
 *   - AIL_end_sample (0x7a5e0): a sample that is neither FREE (1) nor DONE (2)
 *     becomes DONE and its end-of-sample callback RUNS.
 *   - Volume and pan (0x79110): each clamped to 0..0x7f; a volume v scales by
 *     (v ? v + 1 : 0) / 128, and a stereo driver scales the left channel by
 *     panTable[0x7f - pan] / 128 and the right by panTable[pan] / 128, where
 *     panTable (0xa42e0) is 2 * i up to 62 and 128 from 63: centre is full
 *     volume on both sides, and a side falls off linearly beyond it.
 *
 * The mixer itself - resampling, summing, clipping and the DMA timing - is
 * the port's, and each choice is marked where it is made. It runs on the
 * timer: ailTimerService() is the interrupt Miles owns, which calls the
 * game's 182 Hz routine and services the driver, so end-of-sample callbacks
 * happen between frames and a run is as replayable as the rest of the sim.
 * The mixed PCM goes to whoever takes it (the host's audio output); nothing
 * about the game depends on that.
 */
import { divergence, unestablished } from '../../core/provenance.ts';
import { parseRiffWave } from '../../data/formats/sflx.ts';
import { registerGlobals } from '../globals.ts';
import { timerInterrupt } from '../timer.ts';

/** DIG_HARDWARE_SAMPLE_RATE: sound_init's AIL_set_preference(1, 0x2b11) */
export const DIG_OUTPUT_RATE = 11025;
/** the timer rate audio_timer_init programs (engine/timer.ts) */
const TIMER_HZ = 182;
/**
 * Sample handles the DIG driver can hand out. sound_init allocates 8 and the
 * emitters up to 8 more (channels 8..15). Miles' own limit (DIG_MIXER_CHANNELS)
 * is not set by the game and its default was not read; 16 is what the game
 * can ask for.
 */
export const AIL_SAMPLE_POOL = 16;

export const SMP_FREE = 1;
export const SMP_DONE = 2;
export const SMP_PLAYING = 4;
export const SMP_STOPPED = 8;

/** A word the game hands Miles a pointer to (user data 0). @portOnly */
export interface WordRef {
  get(): number;
  set(v: number): void;
}

/** A buffer the game loads: the bytes and where in them it starts. @portOnly */
export interface SampleBuffer {
  bytes: Uint8Array;
  offset: number;
}

/** One Miles SAMPLE (the fields at +4..+0x44 the code above reads). @portOnly */
export interface AilSample {
  handle: number;
  /** +4: 1 FREE, 2 DONE, 4 PLAYING, 8 STOPPED */
  status: number;
  /** +8, +0x10, +0x18, +0x20: the two buffers' start, length, position, done flag */
  start: [SampleBuffer | null, SampleBuffer | null];
  len: [number, number];
  pos: [number, number];
  done: [number, number];
  /** +0x24: the buffer the mixer plays */
  current: number;
  /** +0x28: the buffer the mixer last switched to */
  switched: number;
  /** +0x2c: the buffer AIL_sample_buffer_ready last answered (-2, -1 at the start) */
  lastReady: number;
  /** +0x30: plays left, 0 for ever */
  loopCount: number;
  /** +0x34: 0 mono 8-bit */
  format: number;
  /** +0x3c */
  rate: number;
  /** +0x40 */
  volume: number;
  /** +0x44 */
  pan: number;
  /** the source position's fraction, 16.16 (the port's resampler) */
  frac: number;
  /** a file sample (AIL_allocate_file_sample): its data, played from buffer 0 */
  file: boolean;
  userData: unknown[];
  eos: ((handle: number) => void) | null;
}

function newSample(handle: number): AilSample {
  return {
    handle,
    status: SMP_FREE,
    start: [null, null],
    len: [0, 0],
    pos: [0, 0],
    done: [0, 0],
    current: 1,
    switched: 0,
    lastReady: -2,
    loopCount: 1,
    format: 0,
    rate: DIG_OUTPUT_RATE,
    volume: 0,
    pan: 0x40,
    frac: 0,
    file: false,
    userData: new Array<unknown>(8).fill(0),
    eos: null,
  };
}

/** A listener for the MDI driver's channel messages (the host's synth). @portOnly */
export type MidiListener = (status: number, data1: number, data2: number) => void;

export const ail = registerGlobals(
  'ail',
  {
    /** a DIG driver is installed (the port always has one; the host decides whether it is heard) */
    digInstalled: 1,
    /** an MDI driver is installed */
    mdiInstalled: 1,
    samples: Array.from({ length: AIL_SAMPLE_POOL }, (_, i) => newSample(i + 1)),
    /** output frames owed for the timer interrupts so far, 16.16 */
    frameDebt: 0,
    /** mixed stereo PCM not yet taken: interleaved L, R */
    out: [] as number[],
    /** the host's taking; while false the mix is computed and discarded */
    outputWanted: false,
    /** the MDI driver's locked channels, 1-based */
    midiLocked: new Uint8Array(17),
    midiListeners: [] as MidiListener[],
  },
  () => {
    ail.digInstalled = 1;
    ail.mdiInstalled = 1;
    for (let i = 0; i < AIL_SAMPLE_POOL; i++) ail.samples[i] = newSample(i + 1);
    ail.frameDebt = 0;
    ail.out.length = 0;
    ail.midiLocked.fill(0);
  },
);

/** The sample for a handle, or null for 0 / a stale handle. @portOnly */
export function ailSample(h: number): AilSample | null {
  return h > 0 && h <= AIL_SAMPLE_POOL ? ail.samples[h - 1]! : null;
}

/** 0xa42e0: Miles' pan scale, 2 * i to 62, then 128. */
function panScale(i: number): number {
  return i < 63 ? i * 2 : 128;
}

// --- DIG: sample handles ----------------------------------------------------

/**
 * @mw2 AIL_install_DIG_driver_file 0x0005dc10
 * @fidelity stub
 * @divergence no driver file is read: the port's mixer is the driver, and it is always there
 */
export function ailInstallDigDriverFile(): number {
  return ail.digInstalled;
}

/**
 * @mw2 AIL_install_MDI_driver_file 0x0005f890
 * @fidelity stub
 * @divergence no driver file is read: the channel messages go to the host's synth
 */
export function ailInstallMdiDriverFile(): number {
  return ail.mdiInstalled;
}

/**
 * @mw2 AIL_allocate_sample_handle 0x0005dd90
 * @fidelity partial
 * @divergence the pool is AIL_SAMPLE_POOL handles (see there)
 */
export function ailAllocateSampleHandle(): number {
  for (const s of ail.samples) {
    if (s.status === SMP_FREE) {
      Object.assign(s, newSample(s.handle));
      s.status = SMP_DONE;
      return s.handle;
    }
  }
  return 0;
}

/**
 * @mw2 AIL_release_sample_handle 0x0005dfa0
 * @fidelity partial
 */
export function ailReleaseSampleHandle(h: number): void {
  const s = ailSample(h);
  if (s) s.status = SMP_FREE;
}

/**
 * The defaults of 0x7a2f0 (see the file note).
 *
 * @mw2 AIL_init_sample 0x0005e020
 * @fidelity partial
 * @divergence the default volume (DIG_DEFAULT_VOLUME, 0x1595e4) was not read; the game sets every volume before it is heard, so 0x7f stands in
 */
export function ailInitSample(h: number): void {
  const s = ailSample(h);
  if (!s) return;
  s.status = SMP_DONE;
  s.start = [null, null];
  s.len = [0, 0];
  s.pos = [0, 0];
  s.done = [0, 0];
  s.current = 1;
  s.switched = 0;
  s.lastReady = -2;
  s.loopCount = 1;
  s.format = 0;
  s.rate = DIG_OUTPUT_RATE;
  s.volume = 0x7f;
  s.pan = 0x40;
  s.frac = 0;
  s.file = false;
  s.eos = null;
}

/**
 * A sample for a whole file image: a RIFF WAVE's data plays from buffer 0,
 * at its own rate, once.
 *
 * @mw2 AIL_allocate_file_sample 0x0005de90
 * @fidelity partial
 * @divergence only RIFF WAVE is read; any other image (Miles also took VOC) gets no sample, which was not checked against Miles
 */
export function ailAllocateFileSample(image: Uint8Array | null): number {
  const w = image ? parseRiffWave(image) : null;
  if (!w) {
    // a null image comes from an emitter whose sound name did not resolve (AMY_SCN1's 'irongate'); what Miles did with it was not read
    unestablished(image ? 'AIL_allocate_file_sample: not a RIFF WAVE image; no sample' : 'AIL_allocate_file_sample: no file image (an unresolved sound); no sample', 'AIL_allocate_file_sample');
    return 0;
  }
  const h = ailAllocateSampleHandle();
  const s = ailSample(h);
  if (!s) return 0;
  ailInitSample(h);
  s.file = true;
  s.start[0] = { bytes: w.data, offset: 0 };
  s.len[0] = w.data.length;
  s.rate = w.rate;
  s.format = (w.bitsPerSample === 16 ? 1 : 0) | (w.channels === 2 ? 2 : 0);
  return h;
}

/**
 * @mw2 AIL_set_sample_type 0x0005e240
 * @fidelity partial
 */
export function ailSetSampleType(h: number, format: number, _flags: number): void {
  const s = ailSample(h);
  if (s) s.format = format;
}

/**
 * @mw2 AIL_set_sample_playback_rate 0x0005e4d0
 * @fidelity partial
 */
export function ailSetSamplePlaybackRate(h: number, rate: number): void {
  const s = ailSample(h);
  if (s) s.rate = rate | 0;
}

/**
 * @mw2 AIL_set_sample_volume 0x0005e550
 * @fidelity partial
 */
export function ailSetSampleVolume(h: number, volume: number): void {
  const s = ailSample(h);
  if (s) s.volume = Math.min(0x7f, Math.max(0, volume | 0));
}

/**
 * @mw2 AIL_set_sample_pan 0x0005e5d0
 * @fidelity partial
 */
export function ailSetSamplePan(h: number, pan: number): void {
  const s = ailSample(h);
  if (s) s.pan = Math.min(0x7f, Math.max(0, pan | 0));
}

/**
 * @mw2 AIL_set_sample_loop_count 0x0005e650
 * @fidelity partial
 */
export function ailSetSampleLoopCount(h: number, n: number): void {
  const s = ailSample(h);
  if (s) s.loopCount = n | 0;
}

/**
 * @mw2 AIL_set_sample_user_data 0x0005f500
 * @fidelity partial
 */
export function ailSetSampleUserData(h: number, index: number, value: unknown): void {
  const s = ailSample(h);
  if (s) s.userData[index & 7] = value;
}

/**
 * @mw2 AIL_sample_user_data 0x0005f590
 * @fidelity partial
 */
export function ailSampleUserData(h: number, index: number): unknown {
  const s = ailSample(h);
  return s ? s.userData[index & 7] : 0;
}

/**
 * @mw2 AIL_register_EOS_callback 0x0005f300
 * @fidelity partial
 */
export function ailRegisterEosCallback(h: number, cb: ((handle: number) => void) | null): void {
  const s = ailSample(h);
  if (s) s.eos = cb;
}

/**
 * Plays a (file) sample from its start.
 *
 * @mw2 AIL_start_sample 0x0005e2d0
 * @fidelity partial
 */
export function ailStartSample(h: number): void {
  const s = ailSample(h);
  if (!s || s.status === SMP_FREE) return;
  s.pos = [0, 0];
  s.frac = 0;
  s.current = 0;
  s.status = SMP_PLAYING;
}

/**
 * @mw2 AIL_stop_sample 0x0005e350
 * @fidelity partial
 */
export function ailStopSample(h: number): void {
  const s = ailSample(h);
  if (s && s.status === SMP_PLAYING) s.status = SMP_STOPPED;
}

/**
 * @mw2 AIL_resume_sample 0x0005e3d0
 * @fidelity partial
 */
export function ailResumeSample(h: number): void {
  const s = ailSample(h);
  if (s && s.status === SMP_STOPPED) s.status = SMP_PLAYING;
}

/**
 * 0x7a5e0: a sample neither FREE nor DONE becomes DONE and its end-of-sample
 * callback runs - so ending a playing sample does what reaching its end does.
 *
 * @mw2 AIL_end_sample 0x0005e450
 * @fidelity partial
 */
export function ailEndSample(h: number): void {
  const s = ailSample(h);
  if (!s || s.status === SMP_FREE || s.status === SMP_DONE) return;
  s.status = SMP_DONE;
  s.eos?.(s.handle);
}

/**
 * 0x7a810, exactly (see the file note).
 *
 * @mw2 AIL_sample_buffer_ready 0x0005edf0
 * @fidelity exact
 */
export function ailSampleBufferReady(h: number): number {
  const s = ailSample(h);
  if (!s) return -1;
  if (s.lastReady === -2) {
    s.current = 0;
    s.lastReady = -1;
    return 0;
  }
  if (s.lastReady === -1) {
    s.lastReady = s.switched;
    return 1;
  }
  if (s.lastReady === s.switched) return -1;
  s.lastReady = s.switched;
  return s.switched ^ 1;
}

/**
 * 0x7a790: position 0, done = (len == 0), and a sample that is not playing
 * starts. (A 0-length buffer starts nothing: it only marks the end.)
 *
 * @mw2 AIL_load_sample_buffer 0x0005eef0
 * @fidelity exact
 */
export function ailLoadSampleBuffer(h: number, n: number, buf: SampleBuffer | null, len: number): void {
  const s = ailSample(h);
  if (!s) return;
  const i = n & 1;
  s.pos[i] = 0;
  s.done[i] = len === 0 ? 1 : 0;
  s.len[i] = len;
  s.start[i] = buf;
  if (len !== 0 && s.status !== SMP_PLAYING) s.status = SMP_PLAYING;
}

// --- DIG: the mixer ----------------------------------------------------------

/**
 * Plays `frames` output frames of one sample into mix (interleaved stereo).
 * Point sampling at rate / 11025 per output frame (the port's resampler);
 * the end of a buffer switches to the other one, and an empty or done one
 * ends the sample (DONE, callback). Mono 8-bit only: MW2 sets format 0 on
 * every sample before it plays, the RIFF loops included.
 */
function mixSample(s: AilSample, mix: Int32Array, frames: number): void {
  if (s.format !== 0) {
    unestablished(`AIL mixer: sample format ${s.format} is not mixed (MW2 only plays format 0)`, 'AIL_set_sample_type');
    return;
  }
  const step = Math.floor((s.rate * 0x10000) / DIG_OUTPUT_RATE);
  const v = s.volume ? s.volume + 1 : 0;
  const pl = panScale(0x7f - s.pan);
  const pr = panScale(s.pan);
  let f = 0;
  while (f < frames && s.status === SMP_PLAYING) {
    const c = (s.current & 1) as 0 | 1;
    const b = s.start[c];
    if (!b || s.pos[c] >= s.len[c]) {
      if (!nextBuffer(s)) return;
      continue;
    }
    const x = (((b.bytes[b.offset + s.pos[c]] ?? 0x80) ^ 0x80) << 24) >> 24;
    const scaled = ((x * 256 * v) >> 7) | 0;
    mix[f * 2]! += (scaled * pl) >> 7;
    mix[f * 2 + 1]! += (scaled * pr) >> 7;
    s.frac += step;
    s.pos[c] += s.frac >>> 16;
    s.frac &= 0xffff;
    f++;
  }
}

/** The end of the current buffer: the other one, a loop, or the end. */
function nextBuffer(s: AilSample): boolean {
  if (s.file) {
    if (s.len[0] !== 0 && (s.loopCount === 0 || --s.loopCount > 0)) {
      s.pos[0] = 0;
      return true;
    }
    s.status = SMP_DONE;
    s.eos?.(s.handle);
    return false;
  }
  const c = (s.current & 1) as 0 | 1;
  s.len[c] = 0;
  const n = (c ^ 1) as 0 | 1;
  s.current = n;
  s.switched = n;
  if (s.done[n] || s.len[n] === 0 || !s.start[n]) {
    // Miles ends a double-buffered sample on its 0-length buffer; one the game failed to refill in time
    // (starved) ends it too here - what Miles does then was not read
    if (!s.done[n]) unestablished('AIL mixer: a double-buffered sample starved; the port ends it', 'AIL_load_sample_buffer');
    s.status = SMP_DONE;
    s.eos?.(s.handle);
    return false;
  }
  s.pos[n] = 0;
  return true;
}

/**
 * The DIG driver's service: mixes `frames` frames of every playing sample.
 * Summing in 32 bits and clipping to 16 is the port's choice - Miles' output
 * stage (and whether the card was run 8- or 16-bit, mono or stereo) is the
 * driver's and was not read.
 *
 * @portOnly the Miles mixer (not ported; see the file note)
 */
export function digService(frames: number): void {
  if (frames <= 0) return;
  const mix = new Int32Array(frames * 2);
  for (const s of ail.samples) if (s.status === SMP_PLAYING) mixSample(s, mix, frames);
  if (!ail.outputWanted) return;
  for (let i = 0; i < mix.length; i++) ail.out.push(Math.max(-0x8000, Math.min(0x7fff, mix[i]!)));
  // a host that stops taking (a hidden tab) does not grow the queue without bound
  const cap = DIG_OUTPUT_RATE * 2;
  if (ail.out.length > cap) ail.out.splice(0, ail.out.length - cap);
}

/**
 * The PIT interrupt Miles owns. audio_timer_init registered the game's 182 Hz
 * routine with it (AIL_register_timer), and the same interrupt drives the
 * digital driver - so one call is one 1/182 s: the game's timer routine,
 * then 11025 / 182 frames of mixing.
 *
 * @portOnly Miles' timer dispatch (library, no game function)
 */
export function ailTimerService(): void {
  timerInterrupt();
  ail.frameDebt += (DIG_OUTPUT_RATE * 0x10000) / TIMER_HZ;
  const frames = Math.floor(ail.frameDebt / 0x10000);
  ail.frameDebt -= frames * 0x10000;
  digService(frames);
}

/** The host takes the PCM mixed so far (interleaved stereo int16 at 11025 Hz). @portOnly */
export function digTakeOutput(): Int16Array {
  const r = Int16Array.from(ail.out);
  ail.out.length = 0;
  return r;
}

// --- MDI: channel messages ------------------------------------------------------

/**
 * @mw2 AIL_install_timbre 0x000606e0
 * @fidelity stub
 * @divergence there is no timbre bank: the synth is the host's, and the install always succeeds
 */
export function ailInstallTimbre(_bank: number, _patch: number): number {
  return 1;
}

/**
 * @mw2 AIL_protect_timbre 0x000607f0
 * @fidelity stub
 * @divergence nothing to protect (no timbre cache)
 */
export function ailProtectTimbre(_bank: number, _patch: number): void {}

/**
 * Locks a MIDI channel for the caller, returning it 1-based (0 for none).
 *
 * @mw2 AIL_lock_channel 0x000614c0
 * @fidelity partial
 * @divergence Miles' choice among free channels was not read: the port takes the highest free one, never the percussion channel 10
 */
export function ailLockChannel(): number {
  for (let ch = 16; ch >= 1; ch--) {
    if (ch === 10 || ail.midiLocked[ch]) continue;
    ail.midiLocked[ch] = 1;
    return ch;
  }
  return 0;
}

/**
 * @mw2 AIL_release_channel 0x000615c0
 * @fidelity partial
 */
export function ailReleaseChannel(ch: number): void {
  if (ch >= 1 && ch <= 16) ail.midiLocked[ch] = 0;
}

/**
 * @mw2 AIL_send_channel_voice_message 0x000617d0
 * @fidelity partial
 * @divergence the message goes to the host's listeners instead of a MIDI device
 */
export function ailSendChannelVoiceMessage(status: number, data1: number, data2: number): void {
  for (const l of ail.midiListeners) l(status & 0xff, data1 & 0x7f, data2 & 0x7f);
}

/** The host listens to the MIDI channel messages. @portOnly */
export function ailMidiListen(l: MidiListener): () => void {
  ail.midiListeners.push(l);
  return () => {
    const i = ail.midiListeners.indexOf(l);
    if (i >= 0) ail.midiListeners.splice(i, 1);
  };
}

/** Once: the host has no audio device; the mix runs and is discarded. @portOnly */
export function ailNoOutput(): void {
  divergence('AIL: no audio output attached; the mix is computed and discarded', 'ail');
}
