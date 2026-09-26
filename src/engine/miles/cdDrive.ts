/**
 * The CD-ROM drive, as the game's CD audio routines see it through MSCDEX
 * (cd_ioctl_input and the device requests at 0x42580..0x43650). The game
 * asks four things of it: the audio status, the disc's track range, play a
 * track, stop (the first stop request on a playing drive PAUSES it - MSCDEX's
 * rule, which cd_pause_toggle relies on) and resume. The port puts a drive
 * interface where those requests went; the host provides one when it has the
 * disc's audio (the install's CD image), and with none the game finds no
 * drive, as a machine without a CD would.
 */
import { registerGlobals } from '../globals.ts';

/** What a drive does with the requests. @portOnly */
export interface CdDrive {
  /** the disc's first and last track numbers (Redbook, data track included) */
  trackRange(): { first: number; last: number } | null;
  play(track: number): void;
  pause(): void;
  resume(): void;
  stop(): void;
  /** 2 stopped, 3 playing, 4 paused; 1 drive not ready */
  status(): number;
  /** 0..255, the MSCDEX audio channel volume */
  setVolume(v: number): void;
}

export const cdDrive = registerGlobals('cdDrive', { drive: null as CdDrive | null }, () => {
  /* the drive is hardware: it stays across mission loads */
});

/** The host plugs a drive in (or takes it out). @portOnly */
export function setCdDrive(d: CdDrive | null): void {
  cdDrive.drive = d;
}

/**
 * A drive with no audio behind it: it keeps the state machine (stopped,
 * playing, paused), and a track plays until the host - or a test - says it
 * ended. @portOnly
 */
export class SilentCdDrive implements CdDrive {
  state = 2;
  track = -1;
  volume = 255;
  constructor(private readonly range: { first: number; last: number }) {}
  trackRange() {
    return this.range;
  }
  play(track: number) {
    this.track = track;
    this.state = 3;
  }
  pause() {
    if (this.state === 3) this.state = 4;
  }
  resume() {
    if (this.state === 4) this.state = 3;
  }
  stop() {
    this.state = 2;
  }
  status() {
    return this.state;
  }
  setVolume(v: number) {
    this.volume = v;
  }
  /** the track ran out */
  end() {
    if (this.state === 3) this.state = 2;
  }
}
