/**
 * The browser end of the sound: WebAudio playing what the port's Miles layer
 * mixed (11025 Hz stereo, engine/miles/ail.ts), a stand-in synth for the
 * engine note's MIDI messages, and a CD drive backed by the install's CD
 * image.
 *
 * Nothing here decides anything the game can see. The mixer runs on the
 * game's timer whether or not this plays it; this only schedules each
 * frame's PCM after the last, a little ahead of the audio clock.
 *
 * @portOnly
 */
import { ail, ailMidiListen, DIG_OUTPUT_RATE, digTakeOutput } from '../engine/miles/ail.ts';
import { setCdDrive } from '../engine/miles/cdDrive.ts';
import { BinCdDrive, parseCue, type CueSheet } from './binCdDrive.ts';
import { EngineSynth } from './engineSynth.ts';

/** how far ahead of the audio clock a frame's PCM is queued */
const LEAD = 0.08;
/** a queue further ahead than this (the tab was hidden, the frame rate fell) is dropped and restarted */
const MAX_AHEAD = 0.4;

export class AudioHost {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private nextTime = 0;
  private synth: EngineSynth | null = null;
  private stopMidi: (() => void) | null = null;
  readonly cd: BinCdDrive | null;
  enabled = false;

  constructor(cue: { name: string; text: string } | null) {
    let sheet: CueSheet | null = null;
    if (cue) sheet = parseCue(cue.text);
    this.cd = sheet ? new BinCdDrive(sheet, () => this.context()) : null;
    // the drive is plugged in from the start, as a CD in the drive would be; it only sounds once audio is on
    setCdDrive(this.cd);
  }

  private context(): { ctx: AudioContext; out: AudioNode } | null {
    return this.ctx && this.master && this.enabled ? { ctx: this.ctx, out: this.master } : null;
  }

  /** Must run inside a user gesture the first time (the browser's autoplay rule). */
  enable(): void {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.connect(this.ctx.destination);
      this.synth = new EngineSynth(this.ctx, this.master);
    }
    void this.ctx.resume();
    this.enabled = true;
    ail.outputWanted = true;
    digTakeOutput();
    this.nextTime = 0;
    if (!this.stopMidi && this.synth) {
      const s = this.synth;
      this.stopMidi = ailMidiListen((st, a, b) => s.message(st, a, b));
    }
    this.cd?.audioEnabled();
  }

  disable(): void {
    this.enabled = false;
    ail.outputWanted = false;
    this.stopMidi?.();
    this.stopMidi = null;
    this.synth?.silence();
    this.cd?.audioDisabled();
    void this.ctx?.suspend();
  }

  toggle(): void {
    if (this.enabled) this.disable();
    else this.enable();
  }

  /** After each played frame: queue the PCM the mixer produced for it. */
  pump(): void {
    const ctx = this.ctx;
    if (!this.enabled || !ctx || !this.master) return;
    const pcm = digTakeOutput();
    const frames = pcm.length >> 1;
    if (frames === 0) return;
    const buf = ctx.createBuffer(2, frames, DIG_OUTPUT_RATE);
    const l = buf.getChannelData(0);
    const r = buf.getChannelData(1);
    for (let i = 0; i < frames; i++) {
      l[i] = pcm[i * 2]! / 32768;
      r[i] = pcm[i * 2 + 1]! / 32768;
    }
    const now = ctx.currentTime;
    if (this.nextTime < now + LEAD * 0.5 || this.nextTime > now + MAX_AHEAD) this.nextTime = now + LEAD;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.master);
    src.start(this.nextTime);
    this.nextTime += frames / DIG_OUTPUT_RATE;
  }

  /** Edit mode or a mission change: the game's time stops, and so does what it was playing. */
  pause(): void {
    this.synth?.silence();
    this.nextTime = 0;
  }
}
