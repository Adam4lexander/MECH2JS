/**
 * The shell's sound system and music (decompiled/mw2shell/src/movies/
 * movies.c, sound/shell_sound.c): Miles with an MDI driver for the XMIDI
 * songs in DATABASE.MW2 and a digital driver for the samples. The port's
 * Miles sequencer (engine/miles/xmidiSequencer.ts) plays the songs into the
 * host's General MIDI synth; the host services it at Miles' 120 Hz.
 */
import { SHELL_LABEL } from '../../generated/shell/labels.gen.ts';
import { xmidiParse } from '../../data/formats/xmidi.ts';
import { XmidiSequencer, ServiceClock, SEQ_PLAYING } from '../../engine/miles/xmidiSequencer.ts';
import { registerGlobals } from '../../engine/globals.ts';
import { mem } from '../memory.ts';
import { hardware } from '../host/hardware.ts';
import type { SoundSystem } from './samples.ts';

/** @portOnly the 0xc-byte sound system: +0 MDI driver, +4 digital driver, +8 the current song */
export interface ShellSoundSystem extends SoundSystem {
  midi: boolean;
  current: Song | null;
}

/** @portOnly a song, 0x18 bytes */
export class Song {
  system: ShellSoundSystem | null = null;
  /** +4 the sequence handle */
  seq: XmidiSequencer | null = null;
  data: Uint8Array | null = null;
  size = 0;
  /** +0x10 */
  volume = 0;
  /** +0x14 */
  loopCount = 0;
}

export const miles = registerGlobals(
  'miles',
  {
    /** the sequence handles Miles is serving */
    sequences: [] as XmidiSequencer[],
    clock: new ServiceClock(),
  },
  () => {
    for (const s of miles.sequences) s.release();
    miles.sequences = [];
    miles.clock = new ServiceClock();
  },
  'mw2shell',
);

/**
 * AIL_startup; the MDI driver only when midiEnabled; the digital driver
 * when digital sound or movie sound is enabled (a failure clears
 * movieSoundEnabled), kept only when digital sound is.
 *
 * @mw2shell sound_system_init 0x0003a200
 * @fidelity exact
 * @divergence the drivers are the host's synth and card (hardware.midi, hardware.digital), not MDI.INI / DIG.INI
 */
export function soundSystemInit(): ShellSoundSystem {
  const m = mem();
  const sys: ShellSoundSystem = { midi: false, digital: false, current: null };
  if (m.i32(SHELL_LABEL.midiEnabled) !== 0) sys.midi = hardware.midi !== null;
  if (m.i32(SHELL_LABEL.digitalSoundEnabled) !== 0 || m.i32(SHELL_LABEL.movieSoundEnabled) !== 0) sys.digital = hardware.digital !== null;
  if (!sys.digital) m.setI32(SHELL_LABEL.movieSoundEnabled, 0);
  if (m.i32(SHELL_LABEL.digitalSoundEnabled) === 0) sys.digital = false;
  return sys;
}

/**
 * (song, system, xmidi, size): with a MIDI driver, a sequence handle on the
 * data, loop count 0 (for ever) and volume 250.
 *
 * @mw2shell music_create 0x00039ff0
 * @fidelity exact
 */
export function musicCreate(song: Song, system: ShellSoundSystem, xmidi: Uint8Array | null, size: number): Song {
  song.seq = null;
  song.system = system;
  song.data = xmidi;
  song.size = size;
  if (system.midi && hardware.midi && xmidi) {
    const seq = new XmidiSequencer(hardware.midi);
    seq.init(xmidiParse(xmidi)?.sequences[0] ?? null);
    song.seq = seq;
    miles.sequences.push(seq);
    song.loopCount = 0;
    seq.setLoopCount(0);
    song.volume = 0xfa;
    seq.setVolume(song.volume);
  }
  return song;
}

/**
 * Stops it, clears the system's current song, releases the handle.
 *
 * @mw2shell music_destroy 0x0003a0d0
 * @fidelity exact
 */
export function musicDestroy(song: Song): Song {
  if (song.seq) {
    song.seq.stop();
    if (song.system) song.system.current = null;
    song.seq.release();
    miles.sequences = miles.sequences.filter((s) => s !== song.seq);
    song.data = null;
  }
  return song;
}

/**
 * Starts it, sets the loop count again (starting resets it), and makes it
 * the system's current song.
 *
 * @mw2shell music_start 0x0003a110
 * @fidelity exact
 */
export function musicStart(song: Song): void {
  if (!song.seq) return;
  song.seq.start();
  song.seq.setLoopCount(song.loopCount);
  if (song.system) song.system.current = song;
}

/**
 * False without a MIDI driver, else whether any sequence is playing.
 *
 * @mw2shell music_is_playing 0x0003a1a0
 * @fidelity exact
 */
export function musicIsPlaying(song: Song): boolean {
  if (!song.system?.midi) return false;
  return miles.sequences.some((s) => s.status === SEQ_PLAYING);
}

/**
 * Re-applies the current song's volume (the options slider drags it).
 *
 * @mw2shell music_apply_volume 0x0003a7b0
 * @fidelity exact
 */
export function musicApplyVolume(system: ShellSoundSystem): void {
  const song = system.current;
  if (song?.seq) song.seq.setVolume(song.volume);
}

/** @portOnly Miles' timer: the host calls it with real elapsed time; every sequence is serviced at 120 Hz */
export function milesService(ms: number): void {
  const n = miles.clock.take(ms);
  for (let i = 0; i < n; i++) for (const s of miles.sequences) s.serviceTicks(1);
}
