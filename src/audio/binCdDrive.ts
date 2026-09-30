/**
 * A CD drive backed by the install's CD image (a BIN/CUE pair, raw 2352-byte
 * sectors): the audio tracks are Redbook - 16-bit little-endian stereo at
 * 44100 Hz - and are read from the BIN by byte range when first played.
 * It answers the game's requests as MSCDEX would (engine/miles/cdDrive.ts):
 * playing until the track runs out, a pause that keeps the position, and a
 * resume from it. Without audio on, a track plays silently and never ends,
 * so the game never sees the music stop.
 *
 * @portOnly
 */
import type { CdDrive } from '../engine/miles/cdDrive.ts';

import { parseCue, type CueSheet, type CueTrack } from '../data/formats/cue.ts';

export { parseCue, type CueSheet, type CueTrack };

export class BinCdDrive implements CdDrive {
  private state = 2;
  private track = -1;
  private volume = 255;
  private decoded = new Map<number, Promise<AudioBuffer | null>>();
  private source: AudioBufferSourceNode | null = null;
  private gain: GainNode | null = null;
  /** position within the track, seconds, when not sounding */
  private offset = 0;
  /** audio-clock time the current source started at the track's 0 */
  private startedAt = 0;
  private generation = 0;

  constructor(
    readonly sheet: CueSheet,
    /** bytes [start, end) of the BIN, end null for the rest of it */
    private readonly readBin: (start: number, end: number | null) => Promise<Uint8Array>,
    private readonly audio: () => { ctx: AudioContext; out: AudioNode } | null,
  ) {}

  trackRange() {
    const n = this.sheet.tracks.map((t) => t.number);
    return { first: Math.min(...n), last: Math.max(...n) };
  }

  status(): number {
    return this.state;
  }

  setVolume(v: number): void {
    this.volume = v;
    if (this.gain) this.gain.gain.value = v / 255;
  }

  play(track: number): void {
    this.halt();
    this.track = track;
    this.offset = 0;
    this.state = 3;
    this.sound();
  }

  pause(): void {
    if (this.state !== 3) return;
    this.capture();
    this.halt();
    this.state = 4;
  }

  resume(): void {
    if (this.state !== 4) return;
    this.state = 3;
    this.sound();
  }

  stop(): void {
    this.halt();
    this.state = 2;
    this.offset = 0;
  }

  /** audio came on: a track that should be playing starts sounding (from its start - the drive kept no clock while muted) */
  audioEnabled(): void {
    if (this.state === 3 && !this.source) this.sound();
  }

  audioDisabled(): void {
    if (this.state === 3) this.capture();
    this.halt();
  }

  private capture(): void {
    const a = this.audio();
    if (a && this.source) this.offset = Math.max(0, a.ctx.currentTime - this.startedAt);
  }

  private halt(): void {
    this.generation++;
    if (this.source) {
      this.source.onended = null;
      try {
        this.source.stop();
      } catch {
        /* never started */
      }
      this.source.disconnect();
      this.source = null;
    }
  }

  private load(t: CueTrack): Promise<AudioBuffer | null> {
    let p = this.decoded.get(t.number);
    if (!p) {
      p = (async () => {
        const a = this.audio();
        if (!a) return null;
        const bin = await this.readBin(t.start, t.end).catch(() => null);
        if (!bin) return null;
        const bytes = new Int16Array(bin.buffer, bin.byteOffset, bin.byteLength >> 1);
        const frames = bytes.length >> 1;
        const buf = a.ctx.createBuffer(2, frames, 44100);
        const l = buf.getChannelData(0);
        const rr = buf.getChannelData(1);
        for (let i = 0; i < frames; i++) {
          l[i] = bytes[i * 2]! / 32768;
          rr[i] = bytes[i * 2 + 1]! / 32768;
        }
        return buf;
      })();
      p.catch(() => this.decoded.delete(t.number));
      this.decoded.set(t.number, p);
    }
    return p;
  }

  private sound(): void {
    const a = this.audio();
    const t = this.sheet.tracks.find((x) => x.number === this.track);
    if (!a || !t || !t.audio) return;
    const gen = ++this.generation;
    void this.load(t).then((buf) => {
      if (gen !== this.generation || this.state !== 3 || !buf) return;
      const now = this.audio();
      if (!now) return;
      if (!this.gain) {
        this.gain = now.ctx.createGain();
        this.gain.connect(now.out);
      }
      this.gain.gain.value = this.volume / 255;
      const src = now.ctx.createBufferSource();
      src.buffer = buf;
      src.connect(this.gain);
      const from = Math.min(this.offset, buf.duration);
      this.startedAt = now.ctx.currentTime - from;
      src.onended = () => {
        if (this.source === src && this.state === 3) {
          this.source = null;
          this.state = 2;
          this.offset = 0;
        }
      };
      src.start(0, from);
      this.source = src;
    });
  }
}
