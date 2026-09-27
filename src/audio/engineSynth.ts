/**
 * A STAND-IN for the engine note. The game sends MIDI channel messages
 * (engine_note_start / _update / _stop / _mute, sim/sound/engineNote.ts) to
 * a MIDI driver whose program 3 made the actual sound - an FM patch on the
 * Sound Blaster driver the install names, which the port does not emulate.
 * This plays the same note, pitch bend and volume on two detuned sawtooth
 * oscillators through a low-pass filter: the pitch and level follow the
 * game exactly; the timbre is invented.
 *
 * It is NOT routed to the front end's General MIDI synth (audio/gmSynth.ts):
 * on a GM card program 3 is a honky-tonk piano, so a GM engine hum would be
 * faithful to that hardware and wrong for the game, whose sound is the FM
 * driver's own patch. Decided 2026-09-28 while porting the shell's music.
 *
 * @portOnly
 */

/** the MIDI driver's default pitch-bend range, in semitones (Miles' default; not read) */
const BEND_RANGE = 2;

export class EngineSynth {
  private oscs: OscillatorNode[] = [];
  private gain: GainNode;
  private note = -1;
  private bend = 0x2000;
  private volume = 100;

  constructor(
    private readonly ctx: AudioContext,
    out: AudioNode,
  ) {
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 500;
    this.gain = ctx.createGain();
    this.gain.gain.value = 0;
    filter.connect(this.gain);
    this.gain.connect(out);
    for (const detune of [-6, 6]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.detune.value = detune;
      o.connect(filter);
      o.start();
      this.oscs.push(o);
    }
  }

  private update(): void {
    const t = this.ctx.currentTime;
    if (this.note < 0) {
      this.gain.gain.setTargetAtTime(0, t, 0.05);
      return;
    }
    const semis = this.note - 69 + ((this.bend - 0x2000) / 0x2000) * BEND_RANGE;
    const f = 440 * Math.pow(2, semis / 12);
    for (const o of this.oscs) o.frequency.setTargetAtTime(f, t, 0.03);
    this.gain.gain.setTargetAtTime((this.volume / 127) * 0.12, t, 0.05);
  }

  message(status: number, a: number, b: number): void {
    switch (status & 0xf0) {
      case 0x90:
        this.note = b === 0 ? -1 : a;
        break;
      case 0x80:
        if (a === this.note) this.note = -1;
        break;
      case 0xe0:
        this.bend = a | (b << 7);
        break;
      case 0xb0:
        if (a === 7) this.volume = b;
        break;
      default:
        return;
    }
    this.update();
  }

  /** Mutes until the next message (the game's time stopped); the note itself is kept. */
  silence(): void {
    this.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.02);
  }
}
