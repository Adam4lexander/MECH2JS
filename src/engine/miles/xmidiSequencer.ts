/**
 * The Miles (AIL 3) XMIDI sequencer: what plays the front end's music.
 *
 * Miles is library code linked into MW2SHELL.EXE, and the port does not port
 * it function by function. This follows Miles' documented sequence API
 * (AIL_init_sequence, AIL_start_sequence, AIL_stop_sequence,
 * AIL_resume_sequence, AIL_end_sequence, AIL_set_sequence_volume,
 * AIL_set_sequence_tempo, AIL_set_sequence_loop_count, AIL_branch_index)
 * and, where the shell's copy of Miles was read (2026-09-28), its code:
 *
 *   - the serve loop, 0x5e740 (not in functions.csv: it is reached only as
 *     the timer callback miles_init_midi passes to AIL_register_timer, and
 *     was read from the disassembly). Each call is one 1/120 s service.
 *     Per PLAYING sequence: a service count; tempo accumulator += tempo
 *     percent, and while it holds 100 one XMIDI tick runs: the note-off queue
 *     (32 slots, each counted down, off at <= 0), then the interval count is
 *     decremented and, at <= 0, events are read up to the next interval byte
 *     (stored whole: one byte per wait). End of sequence: a loop count of 0
 *     or one that is still > 0 after its decrement rewinds to the start (and
 *     reading stops until the next service); otherwise the sequence is
 *     stopped, becomes DONE and its end-of-sequence callback runs. After the
 *     ticks: the volume and tempo ramps (volume re-sent every 8th service).
 *   - the channel message path, miles_drivers_sub_05de50: the shadow of each
 *     channel's state; cc 6 sent after cc 100 = 0, cc 101 = 0, cc 38 = 0
 *     (the data entry is always pitch-bend range); cc 7 scaled by the
 *     sequence volume, (volume * v) / 127 clamped to 0..127; XMIDI's cc 109
 *     (branch), 110/111 (channel lock / protect), 116 FOR (first free of 4
 *     slots: count and the FOR event's own position), 117 NEXT (< 64 ignored;
 *     the innermost loop: a count of 0 loops for ever, otherwise decremented
 *     and the loop ends at 0), 118 (beat count reset) and 119 (trigger
 *     callback) are consumed; the rest reach the driver.
 *   - after a channel event the serve loop steps by the size of the event
 *     at the (possibly jumped) position - so a NEXT resumes just after its
 *     FOR, and a branch skips the event its RBRN entry points at.
 *   - start (miles_drivers_sub_05fc40): stop, reset (0x5e630: loop count 1,
 *     FOR slots, note queue, shadows, channel map), PLAYING from EVNT + 8.
 *     So a loop count set before start is lost - the shell sets it again
 *     after AIL_start_sequence (music_start).
 *   - stop (0x5fc80): PLAYING -> STOPPED; every queued note off; then per
 *     channel cc 64 = 0 where sustain was >= 64 and cc 112 = 0 where voice
 *     protect was >= 64. It does not send All Notes Off: Miles releases
 *     exactly the notes the sequence started.
 *   - resume (0x5fd50): STOPPED -> PLAYING after re-sending each channel's
 *     shadowed state (0x5e420).
 *   - end (0x5fde0): stop, then DONE (no callback).
 *   - set volume (0x5fe90) / tempo (0x5fe20): the target; a time of 0 sets
 *     it at once, else a step of ms * 1000 / |current - target| microseconds;
 *     setting the volume re-sends cc 7 at once (at the current, not the
 *     target, volume).
 *
 * Not reproduced (none of it is used by MW2's songs, listing/xmidi.txt):
 * channel locking (cc 110/111 and AIL_lock_channel - the port's MIDI device
 * belongs to the one sequence), the indirect controller array (cc 115) and
 * the callback prefix (cc 108), timbre installation (a GM synth has every
 * patch), and the note-count bookkeeping the driver keeps for its own
 * channel allocation.
 *
 * Advanced by serviceTicks(n): the host (or the port's timer) calls it once
 * per 1/120 s. No DOM; it emits to a MidiOut.
 *
 * @portOnly Miles' sequencer (library, not a game function); follows Miles' documented semantics and the shell's copy of its code named above
 */
import { quirk, unestablished } from '../../core/provenance.ts';
import { META_END_OF_TRACK, META_TEMPO, META_TIME_SIGNATURE, xmidiReadVlq, type XmidiSequence } from '../../data/formats/xmidi.ts';

/** A MIDI output device: what a Miles MDI driver talks to. Channels 0..15. @portOnly */
export interface MidiOut {
  noteOn(ch: number, key: number, vel: number): void;
  noteOff(ch: number, key: number): void;
  controlChange(ch: number, cc: number, value: number): void;
  programChange(ch: number, program: number): void;
  /** value14: 0..16383, 8192 centre */
  pitchBend(ch: number, value14: number): void;
  allNotesOff(): void;
  /** optional: messages MW2's songs never carry */
  polyPressure?(ch: number, key: number, value: number): void;
  channelPressure?(ch: number, value: number): void;
  /** a system exclusive message, status byte first */
  sysex?(bytes: Uint8Array): void;
}

export const SEQ_FREE = 1;
export const SEQ_DONE = 2;
export const SEQ_PLAYING = 4;
export const SEQ_STOPPED = 8;

/**
 * MDI_SERVICE_RATE: services per second. The value (DAT_000a889c, a Miles
 * preference set at run time) was not read; 120 is Miles' documented
 * default and XMIDI's native tick rate.
 */
export const MDI_SERVICE_RATE = 120;
/** the driver's microseconds per service (miles_init_midi: 1000000 / rate) */
const SERVICE_US = Math.trunc(1000000 / MDI_SERVICE_RATE);
/** MDI_DEFAULT_VOLUME (DAT_000a88a4, not read): Miles' documented default */
export const MDI_DEFAULT_VOLUME = 127;
/** MDI_ALLOW_LOOP_BRANCHING (DAT_000a88ac, not read): Miles' documented default, no */
const MDI_ALLOW_LOOP_BRANCHING = false;
const FOR_NEST = 4;
const NOTE_QUEUE = 32;

// the per-channel shadow (0x5dc90), in its order: sequence + 0xd0 + k * 0x40
const SH_PROGRAM = 0;
const SH_PITCH_LSB = 1;
const SH_PITCH_MSB = 2;
const SH_LOCK = 3; // cc 110
const SH_LOCK_PROTECT = 4; // cc 111
const SH_VOICE_PROTECT = 5; // cc 112
const SH_BANK = 6; // cc 114
const SH_ICA = 7; // cc 115 (and the pending indirect value)
const SH_TRIGGER = 8; // cc 119
const SH_CC1 = 9;
const SH_CC7 = 10;
const SH_CC10 = 11;
const SH_CC11 = 12;
const SH_CC64 = 13;
const SH_CC91 = 14;
const SH_CC93 = 15;
const SH_CC6 = 16;
const SHADOW_KINDS = 17;

/** controller -> shadow slot, for the controllers 0x5dc90 keeps */
const CC_SHADOW: Readonly<Record<number, number>> = {
  1: SH_CC1,
  6: SH_CC6,
  7: SH_CC7,
  10: SH_CC10,
  11: SH_CC11,
  64: SH_CC64,
  91: SH_CC91,
  93: SH_CC93,
  110: SH_LOCK,
  111: SH_LOCK_PROTECT,
  112: SH_VOICE_PROTECT,
  114: SH_BANK,
  115: SH_ICA,
  119: SH_TRIGGER,
};

/** the size of a channel message by its status (the serve loop's step) */
function channelMessageSize(status: number): number {
  switch (status & 0xf0) {
    case 0x80:
    case 0x90:
    case 0xa0:
    case 0xb0:
    case 0xe0:
      return 3;
    case 0xc0:
    case 0xd0:
      return 2;
  }
  return 0;
}

/** One Miles SEQUENCE. @portOnly (see the file note) */
export class XmidiSequencer {
  /** +4: 1 FREE, 2 DONE, 4 PLAYING, 8 STOPPED */
  status = SEQ_FREE;
  /** the end-of-sequence callback (+0x24) */
  onEos: ((seq: XmidiSequencer) => void) | null = null;
  /** the cc 119 trigger callback (+0x20): (sequence, channel, value) */
  onTrigger: ((seq: XmidiSequencer, ch: number, value: number) => void) | null = null;

  private seq: XmidiSequence | null = null;
  private evnt: Uint8Array = new Uint8Array(0);
  /** +0x14, as an offset into the EVNT data */
  private ptr = 0;
  /** +0x2c */
  private interval = 0;
  /** +0x28: plays left, 0 for ever */
  private loops = 1;
  /** +0x30 */
  private serviceCount = 0;
  /** +0x34.. +0x40: volume, target, accumulator, step (microseconds) */
  private vol = MDI_DEFAULT_VOLUME;
  private volTarget = MDI_DEFAULT_VOLUME;
  private volAccum = 0;
  private volStep = 0;
  /** +0x44.. +0x54: tempo percent, target, accumulator, step, tick accumulator */
  private tempo = 100;
  private tempoTarget = 100;
  private tempoRampAccum = 0;
  private tempoStep = 0;
  private tempoAccum = 0;
  /** +0x58.. +0x6c: beat, measure, beats per measure, beat increment, beat fraction, tempo * 16 */
  private beat = 0;
  private measure = -1;
  private beatsPerMeasure = 4;
  private beatInc = 0;
  private beatFrac = 0;
  private tempoUs16 = 8000000;
  /** +0x70 / +0x80: FOR loop positions and counts (-1 free) */
  private readonly forPtr = new Int32Array(FOR_NEST);
  private readonly forCount = new Int32Array(FOR_NEST).fill(-1);
  /** +0x90: logical -> physical channel */
  private readonly chanMap = new Int32Array(16);
  /** +0xd0: the shadow, [kind * 16 + ch], -1 unset */
  private readonly shadow = new Int32Array(SHADOW_KINDS * 16).fill(-1);
  /** +0x510.. : the note-off queue */
  private noteCount = 0;
  private readonly noteChan = new Int32Array(NOTE_QUEUE).fill(-1);
  private readonly noteNum = new Int32Array(NOTE_QUEUE);
  private readonly noteTime = new Int32Array(NOTE_QUEUE);

  constructor(readonly out: MidiOut) {}

  /** 0x5e630: the state a start begins from. */
  private reset(): void {
    for (let i = 0; i < 16; i++) this.chanMap[i] = i;
    this.shadow.fill(-1);
    this.forCount.fill(-1);
    this.noteChan.fill(-1);
    this.noteCount = 0;
    this.interval = 0;
    this.beat = 0;
    this.measure = -1;
    this.beatFrac = 0;
    this.beatInc = 0;
    this.beatsPerMeasure = 4;
    this.tempoUs16 = 8000000;
    this.serviceCount = 0;
    this.loops = 1;
  }

  /**
   * AIL_init_sequence (miles_parse_xmidi 0x5f890): DONE, loop count 1, the
   * default volume, tempo 100 %, positioned at the start. False (and the
   * handle left as it was) for a missing sequence.
   */
  init(seq: XmidiSequence | null): boolean {
    if (!seq) return false;
    if (this.status === SEQ_PLAYING) this.stop();
    this.seq = seq;
    this.evnt = seq.evnt;
    this.status = SEQ_DONE;
    this.onEos = null;
    this.onTrigger = null;
    this.reset();
    this.vol = this.volTarget = MDI_DEFAULT_VOLUME;
    this.volAccum = this.volStep = 0;
    this.tempo = this.tempoTarget = 100;
    this.tempoRampAccum = this.tempoStep = 0;
    this.tempoAccum = 0;
    this.ptr = 0;
    return true;
  }

  /** AIL_release_sequence_handle: FREE (a playing sequence is stopped first). */
  release(): void {
    if (this.status === SEQ_PLAYING) this.stop();
    this.status = SEQ_FREE;
    this.seq = null;
    this.evnt = new Uint8Array(0);
  }

  /** AIL_start_sequence (0x5fc40): from the top, loop count back to 1. */
  start(): void {
    if (this.status === SEQ_FREE || !this.seq) return;
    this.stop();
    this.reset();
    this.status = SEQ_PLAYING;
    this.ptr = 0;
  }

  /** AIL_stop_sequence (0x5fc80): a pause - resume() carries on from here. */
  stop(): void {
    if (this.status !== SEQ_PLAYING) return;
    this.status = SEQ_STOPPED;
    this.flushNotes();
    for (let ch = 0; ch < 16; ch++) {
      const phys = this.chanMap[ch]!;
      if (this.sh(SH_CC64, ch) >= 0x40) this.out.controlChange(phys, 64, 0);
      if (this.sh(SH_VOICE_PROTECT, ch) >= 0x40) this.out.controlChange(phys, 112, 0);
    }
  }

  /** The same as stop(): Miles' pause is AIL_stop_sequence. */
  pause(): void {
    this.stop();
  }

  /** AIL_resume_sequence (0x5fd50): each channel's state again, then PLAYING. */
  resume(): void {
    if (this.status !== SEQ_STOPPED) return;
    for (let ch = 0; ch < 16; ch++) this.restoreChannel(ch);
    this.status = SEQ_PLAYING;
  }

  /** AIL_end_sequence (0x5fde0): stopped and DONE, without the end-of-sequence callback. */
  end(): void {
    if (this.status === SEQ_FREE) return;
    this.stop();
    this.status = SEQ_DONE;
  }

  /** AIL_set_sequence_loop_count: plays left, 0 for ever. */
  setLoopCount(n: number): void {
    this.loops = n | 0;
  }

  get loopCount(): number {
    return this.loops;
  }

  /** AIL_set_sequence_volume (0x5fe90). No clamp: the shell asks for 250. */
  setVolume(volume: number, ms = 0): void {
    this.volTarget = volume | 0;
    if (this.vol === this.volTarget) return;
    if (ms === 0) this.vol = this.volTarget;
    else {
      this.volAccum = 0;
      this.volStep = Math.trunc((ms * 1000) / Math.abs(this.vol - this.volTarget));
    }
    this.resendVolumes();
  }

  /** The current (ramping) volume. */
  get volume(): number {
    return this.vol;
  }

  /** AIL_set_sequence_tempo (0x5fe20): percent of normal speed. */
  setTempo(percent: number, ms = 0): void {
    this.tempoTarget = percent | 0;
    if (this.tempo === this.tempoTarget) return;
    if (ms === 0) this.tempo = this.tempoTarget;
    else {
      this.tempoRampAccum = 0;
      this.tempoStep = Math.trunc((ms * 1000) / Math.abs(this.tempo - this.tempoTarget));
    }
  }

  get tempoPercent(): number {
    return this.tempo;
  }

  /**
   * AIL_branch_index (0x60230): jumps to the RBRN entry with this marker id;
   * nothing when there is none.
   */
  branchIndex(marker: number): void {
    const b = this.seq?.branches.find((x) => x.id === (marker & 0xffff));
    if (!b) return;
    this.interval = 0;
    this.ptr = b.offset;
    if (!MDI_ALLOW_LOOP_BRANCHING) this.forCount.fill(-1);
  }

  /** AIL_sequence_position's beat and measure. */
  position(): { beat: number; measure: number } {
    return { beat: this.beat, measure: this.measure };
  }

  /** How many notes the sequence has sounding (its note-off queue). */
  get activeNotes(): number {
    return this.noteCount;
  }

  /** Runs n services of the Miles timer (1/120 s each). */
  serviceTicks(n: number): void {
    for (let i = 0; i < n; i++) this.service();
  }

  // --- the serve loop (0x5e740) -------------------------------------------------------

  private service(): void {
    if (this.status !== SEQ_PLAYING) return;
    this.serviceCount++;
    this.tempoAccum += this.tempo;
    let eot = false;
    const e = this.evnt;
    while (this.tempoAccum >= 100) {
      this.tempoAccum -= 100;
      if (this.noteCount > 0) {
        for (let i = 0; i < NOTE_QUEUE; i++) {
          if (this.noteChan[i] === -1) continue;
          if (--this.noteTime[i]! > 0) continue;
          this.send(0x80 | this.noteChan[i]!, this.noteNum[i]!, 0, false);
          this.noteChan[i] = -1;
          if (--this.noteCount === 0) break;
        }
      }
      if (--this.interval <= 0) {
        for (;;) {
          const b = e[this.ptr];
          if (b === undefined) {
            // Miles would read past the chunk; every sequence ends with 0xFF 0x2F
            unestablished('XMIDI serve: the EVNT data ended without an end-of-sequence event; the port ends the sequence', 'xmidi serve');
            this.end();
            return;
          }
          if (b < 0x80 || eot) {
            if (!eot) {
              this.interval = b;
              this.ptr++;
            }
            break;
          }
          if (b === 0xff) {
            const type = e[this.ptr + 1]!;
            const len = xmidiReadVlq(e, this.ptr + 2);
            this.ptr = len.next;
            const data = this.ptr;
            if (type === META_END_OF_TRACK) {
              eot = true;
              if (this.loops !== 0 && --this.loops === 0) {
                this.stop();
                this.status = SEQ_DONE;
                this.onEos?.(this);
              } else {
                this.beat = 0;
                this.measure = -1;
                this.beatFrac = 0;
                this.ptr = 0;
              }
            } else if (type === META_TEMPO) {
              this.tempoUs16 = ((e[data]! << 16) | (e[data + 1]! << 8) | e[data + 2]!) * 16;
            } else if (type === META_TIME_SIGNATURE) {
              this.beatsPerMeasure = e[data]!;
              const d = e[data + 1]! - 2;
              const inc = Math.trunc(16000000 / MDI_SERVICE_RATE);
              this.beatInc = d < 0 ? inc >> -d : inc << d;
              this.beatFrac = 0;
              this.beat = 0;
              this.measure++;
              this.beatFrac -= this.beatInc;
            }
            this.ptr += len.value;
            continue;
          }
          if (b === 0xf0 || b === 0xf7) {
            const len = xmidiReadVlq(e, this.ptr + 1);
            if (this.out.sysex) {
              const msg = new Uint8Array(1 + len.value);
              msg[0] = b;
              msg.set(e.subarray(len.next, len.next + len.value), 1);
              this.out.sysex(msg);
            }
            this.ptr = len.next + len.value;
            continue;
          }
          const ch = b & 15;
          this.send(b, e[this.ptr + 1]!, e[this.ptr + 2]!, true);
          if ((b & 0xf0) === 0x90) {
            const slot = this.noteChan.indexOf(-1);
            if (slot < 0) {
              // "Internal note queue overflow": the note has sounded; the sequence stops and is DONE
              quirk('XMIDI serve: a 33rd pending note overflows the note queue; the sequence stops (Miles 0x5ec1d)', 'xmidi serve');
              this.stop();
              this.status = SEQ_DONE;
              return;
            }
            this.noteCount++;
            this.noteChan[slot] = ch;
            this.noteNum[slot] = e[this.ptr + 1]!;
            const dur = xmidiReadVlq(e, this.ptr + 3);
            this.ptr = dur.next;
            this.noteTime[slot] = dur.value;
          } else {
            // the step is the size of the event now at ptr: after a NEXT that is the FOR event
            this.ptr += channelMessageSize(e[this.ptr] ?? 0);
          }
        }
      }
      if (eot) continue;
      this.beatFrac += this.beatInc;
      if (this.beatFrac >= this.tempoUs16) {
        this.beatFrac -= this.tempoUs16;
        if (++this.beat >= this.beatsPerMeasure) {
          this.beat = 0;
          this.measure++;
        }
      }
    }
    if (eot) return;
    if (this.vol !== this.volTarget) {
      this.volAccum += SERVICE_US;
      while (this.volAccum >= this.volStep) {
        this.volAccum -= this.volStep;
        this.vol += this.volTarget > this.vol ? 1 : -1;
        if (this.vol === this.volTarget) break;
      }
      if ((this.serviceCount & 7) === 0) this.resendVolumes();
    }
    if (this.tempo !== this.tempoTarget) {
      this.tempoRampAccum += SERVICE_US;
      while (this.tempoRampAccum >= this.tempoStep) {
        this.tempoRampAccum -= this.tempoStep;
        this.tempo += this.tempoTarget > this.tempo ? 1 : -1;
        if (this.tempo === this.tempoTarget) break;
      }
    }
  }

  // --- the channel message path (0x5de50) ------------------------------------------------

  private sh(kind: number, ch: number): number {
    return this.shadow[kind * 16 + ch]!;
  }

  /** 0x5dc90: the shadow of a program, pitch bend or kept controller. */
  private remember(status: number, d1: number, d2: number): void {
    const ch = status & 15;
    switch (status & 0xf0) {
      case 0xc0:
        this.shadow[SH_PROGRAM * 16 + ch] = d1 & 0xff;
        return;
      case 0xe0:
        this.shadow[SH_PITCH_LSB * 16 + ch] = d1 & 0xff;
        this.shadow[SH_PITCH_MSB * 16 + ch] = d2 & 0xff;
        return;
      case 0xb0: {
        const k = CC_SHADOW[d1];
        if (k !== undefined) this.shadow[k * 16 + ch] = d2 & 0xff;
      }
    }
  }

  /**
   * One channel message from the sequence (fromSeq) or from Miles itself:
   * the shadow, the XMIDI controllers, then the device.
   */
  private send(status: number, d1: number, d2: number, fromSeq: boolean): void {
    const ch = status & 15;
    const hi = status & 0xf0;
    if (hi === 0xb0 || hi === 0xc0 || hi === 0xe0) this.remember(status, d1, d2);
    if (hi === 0xb0) {
      if (fromSeq && this.sh(SH_ICA, ch) !== -1 && d1 !== 115) {
        unestablished('XMIDI: an indirect controller (cc 115) value is pending; the port has no controller array and sends the value as it is', 'xmidi cc 115');
        this.shadow[SH_ICA * 16 + ch] = -1;
      }
      switch (d1) {
        case 6:
          // the data entry is taken as pitch-bend range: RPN 0, LSB 0, first
          this.send(0xb0 | ch, 100, 0, false);
          this.send(0xb0 | ch, 101, 0, false);
          this.send(0xb0 | ch, 38, 0, false);
          break;
        case 7:
          d2 = Math.min(0x7f, Math.max(0, Math.trunc((this.vol * d2) / 0x7f)));
          break;
        case 108:
          unestablished('XMIDI: callback prefix (cc 108) with no callback; passed to the device', 'xmidi cc 108');
          break;
        case 109:
          this.branchIndex(d2);
          return;
        case 110:
        case 111:
          unestablished(`XMIDI: channel lock controller ${d1} is not reproduced (the port's device has no other users)`, 'xmidi channel lock');
          return;
        case 116: {
          const i = this.forCount.indexOf(-1);
          if (i < 0) return;
          this.forCount[i] = d2;
          this.forPtr[i] = this.ptr;
          return;
        }
        case 117: {
          if (d2 < 0x40) return;
          let i = FOR_NEST - 1;
          while (i >= 0 && this.forCount[i] === -1) i--;
          if (i < 0) return;
          if (this.forCount[i] !== 0 && --this.forCount[i]! === 0) {
            this.forCount[i] = -1;
            return;
          }
          this.ptr = this.forPtr[i]!;
          return;
        }
        case 118:
          this.beat = 0;
          this.beatFrac = 0;
          this.measure = 0;
          this.beatFrac -= this.beatInc;
          return;
        case 119:
          this.onTrigger?.(this, ch, d2);
          return;
      }
    }
    this.toDevice(hi | this.chanMap[ch]!, d1 & 0x7f, d2 & 0x7f);
  }

  private toDevice(status: number, d1: number, d2: number): void {
    const ch = status & 15;
    switch (status & 0xf0) {
      case 0x80:
        this.out.noteOff(ch, d1);
        return;
      case 0x90:
        this.out.noteOn(ch, d1, d2);
        return;
      case 0xa0:
        this.out.polyPressure?.(ch, d1, d2);
        return;
      case 0xb0:
        this.out.controlChange(ch, d1, d2);
        return;
      case 0xc0:
        this.out.programChange(ch, d1);
        return;
      case 0xd0:
        this.out.channelPressure?.(ch, d1);
        return;
      case 0xe0:
        this.out.pitchBend(ch, d1 | (d2 << 7));
    }
  }

  /** 0x5e2a0: every queued note off. */
  private flushNotes(): void {
    for (let i = 0; i < NOTE_QUEUE; i++) {
      if (this.noteChan[i] === -1) continue;
      this.send(0x80 | this.noteChan[i]!, this.noteNum[i]!, 0, false);
      this.noteChan[i] = -1;
    }
    this.noteCount = 0;
  }

  /** 0x5e700: cc 7 again on every channel that has one, at the current volume. */
  private resendVolumes(): void {
    for (let ch = 0; ch < 16; ch++) {
      const v = this.sh(SH_CC7, ch);
      if (v !== -1) this.send(0xb0 | ch, 7, v, false);
    }
  }

  /** 0x5e420: a channel's shadowed state, in Miles' order. */
  private restoreChannel(ch: number): void {
    const cc = (kind: number, n: number) => {
      const v = this.sh(kind, ch);
      if (v !== -1) this.send(0xb0 | ch, n, v, false);
    };
    cc(SH_BANK, 114);
    const prog = this.sh(SH_PROGRAM, ch);
    if (prog !== -1) this.send(0xc0 | ch, prog, 0, false);
    if (this.sh(SH_PITCH_MSB, ch) !== -1) this.send(0xe0 | ch, Math.max(0, this.sh(SH_PITCH_LSB, ch)), this.sh(SH_PITCH_MSB, ch), false);
    cc(SH_LOCK_PROTECT, 111);
    cc(SH_VOICE_PROTECT, 112);
    cc(SH_CC1, 1);
    cc(SH_CC7, 7);
    cc(SH_CC10, 10);
    cc(SH_CC11, 11);
    cc(SH_CC64, 64);
    cc(SH_CC91, 91);
    cc(SH_CC93, 93);
    cc(SH_CC6, 6);
  }
}

/**
 * Turns elapsed host time into whole Miles services, keeping the remainder.
 * The shell's timer drives Miles at MDI_SERVICE_RATE; a host that runs at
 * its own frame rate calls take(ms) and passes the result to serviceTicks.
 *
 * @portOnly host pacing
 */
export class ServiceClock {
  private us = 0;
  take(ms: number): number {
    this.us += ms * 1000;
    const n = Math.floor(this.us / (1000000 / MDI_SERVICE_RATE));
    this.us -= n * (1000000 / MDI_SERVICE_RATE);
    // a long stall (a hidden tab) does not replay minutes of music in one call
    if (n > MDI_SERVICE_RATE) return MDI_SERVICE_RATE;
    return n;
  }
  reset(): void {
    this.us = 0;
  }
}
