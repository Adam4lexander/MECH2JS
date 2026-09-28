/**
 * The shell's sound samples: a DATABASE.MW2 RIFF WAV on a Miles sample
 * handle, with a volume (0..127), a loop count and a volume ramp
 * (decompiled/mw2shell/src/sound/shell_sound.c). Without a digital driver
 * there is no handle and every call does nothing, as in the original.
 */
import { hardware, type SampleVoice } from '../host/hardware.ts';
import { WAIT, type Blocking } from '../host/blocking.ts';

/** @portOnly the sound system main builds (sound_system_init): +4 is the digital driver */
export interface SoundSystem {
  digital: boolean;
}

/** @portOnly a sample, 0x2c bytes */
export class Sample {
  /** +0x00 */
  system: SoundSystem | null = null;
  /** +0x04 / +0x08 */
  data: Uint8Array | null = null;
  size = 0;
  /** +0x0c the Miles handle, null without a driver */
  handle: SampleVoice | null = null;
  /** +0x10 */
  volume = 5;
  /** +0x14 */
  loopCount = 1;
  /** +0x18 / +0x1c / +0x20 / +0x24 / +0x28 the ramp: period, countdown, steps left, start, target */
  rampPeriod = -1;
  rampCountdown = -1;
  rampSteps = -1;
  rampStart = 5;
  rampTarget = 5;
}

const clampVolume = (v: number) => (v < 0x80 ? (v < 0 ? 0 : v) : 0x7f);

/**
 * (sample, system, wav, size): volume 5, loop count 1; with a digital
 * driver, a handle playing the WAV.
 *
 * @mw2shell sound_sample_create 0x0003a340
 * @fidelity exact
 */
export function soundSampleCreate(s: Sample, system: SoundSystem, wav: Uint8Array | null, size: number): Sample {
  s.handle = null;
  s.volume = 5;
  s.loopCount = 1;
  s.rampCountdown = -1;
  s.rampPeriod = -1;
  s.rampSteps = -1;
  s.system = system;
  s.data = wav;
  s.size = size;
  s.rampStart = s.volume;
  s.rampTarget = s.volume;
  if (system.digital && wav) s.handle = hardware.digital?.sample(wav) ?? null;
  return s;
}

/**
 * Stops it and releases the handle.
 *
 * @mw2shell sound_sample_destroy 0x0003a400
 * @fidelity exact
 */
export function soundSampleDestroy(s: Sample): Sample {
  if (s.handle) {
    s.handle.stop();
    s.data = null;
    s.handle.release();
  }
  return s;
}

/**
 * Loop count 0: for ever.
 *
 * @mw2shell sound_sample_set_looping 0x0003a530
 * @fidelity exact
 */
export function soundSampleSetLooping(s: Sample): void {
  if (s.handle) {
    s.loopCount = 0;
    s.handle.setLoopCount(0);
  }
}

/**
 * Applies the loop count and the (clamped) volume, and starts it.
 *
 * @mw2shell sound_sample_play 0x0003a560
 * @fidelity exact
 */
export function soundSamplePlay(s: Sample): void {
  if (!s.handle) return;
  s.handle.setLoopCount(s.loopCount);
  s.volume = clampVolume(s.volume);
  s.handle.setVolume(s.volume);
  s.handle.start();
}

/**
 * Stops it.
 *
 * @mw2shell sound_sample_stop 0x0003a690
 * @fidelity exact
 */
export function soundSampleStop(s: Sample): void {
  s.handle?.stop();
}

/**
 * Sets the volume, clamped to 0..127.
 *
 * @mw2shell sound_sample_set_volume 0x0003a6e0
 * @fidelity exact
 */
export function soundSampleSetVolume(s: Sample, v: number): void {
  if (!s.handle) return;
  s.volume = clampVolume(v);
  s.handle.setVolume(s.volume);
}

/**
 * (sample, period, steps, start, target): a volume ramp; the start volume
 * is applied now.
 *
 * @mw2shell sound_sample_ramp 0x0003a440
 * @fidelity exact
 */
export function soundSampleRamp(s: Sample, period: number, steps: number, start: number, target: number): void {
  s.rampPeriod = period;
  s.rampCountdown = period;
  s.rampSteps = steps;
  s.rampStart = start;
  s.rampTarget = target;
  if (s.handle) {
    s.volume = clampVolume(s.rampStart);
    s.handle.setVolume(s.volume);
  }
}

/**
 * One tick of the ramp (one pass of the title's loop): when the countdown
 * runs out and steps remain, the volume moves one unit toward the target.
 *
 * @mw2shell sound_sample_ramp_step 0x0003a4a0
 * @fidelity exact
 */
export function soundSampleRampStep(s: Sample): void {
  s.rampCountdown = (s.rampCountdown - 1) | 0;
  if (s.rampCountdown !== 0 || s.rampSteps === 0) return;
  s.rampSteps = (s.rampSteps - 1) | 0;
  if (s.rampSteps <= 0) return;
  s.rampCountdown = s.rampPeriod;
  if (s.volume === s.rampTarget) return;
  s.volume += s.volume < s.rampTarget ? 1 : -1;
  if (s.handle) {
    s.volume = clampVolume(s.volume);
    s.handle.setVolume(s.volume);
  }
}

/**
 * Plays it like sound_sample_play, then waits until no sample is playing
 * (at once without a digital driver).
 *
 * @mw2shell sound_sample_play_wait 0x0003a5e0
 * @fidelity exact
 */
export function* soundSamplePlayWait(s: Sample): Blocking<void> {
  if (!s.handle) return;
  soundSamplePlay(s);
  while (s.system?.digital && (hardware.digital?.activeCount() ?? 0) !== 0) yield WAIT;
}
