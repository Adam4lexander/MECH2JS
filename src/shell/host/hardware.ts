/**
 * The PC under MW2SHELL.EXE, as the port gives it to the shell: the VGA
 * screen and DAC the video driver blits and uploads to, the int 33h mouse,
 * the BIOS keyboard buffer getch reads, and the 250 Hz timer behind
 * timer_read. The host (src/app/shell) feeds input in and presents the
 * screen; the shell's ported code only sees these, as it only saw the
 * hardware.
 *
 * None of this is a program's state: it survives the shell "process"
 * restarting (MECH2 relaunching it with 'sim') as the machine does.
 *
 * @portOnly the hardware the shell's drivers talk to
 */
import type { MidiOut } from '../../engine/miles/xmidiSequencer.ts';

export const SCREEN_W = 640;
export const SCREEN_H = 480;

export const hardware = {
  /** the visible screen: what the driver has blitted, palette indices */
  screen: new Uint8Array(SCREEN_W * SCREEN_H),
  /** bumped on every blit, so the host knows to repaint */
  screenVersion: 0,
  /** the DAC: 256 x RGB, 6-bit components as the driver uploads them */
  dac: new Uint8Array(768),
  dacVersion: 0,
  /** the mouse pointer: its shapes, which one, and whether the driver shows it */
  cursor: null as { shapes: Uint8Array; shape: number } | null,
  cursorShown: false,

  // ---- int 33h: the mouse driver's state, in screen pixels
  mouseX: 320,
  mouseY: 240,
  /** bit 0 left, bit 1 right, bit 2 middle - the int 33h button word */
  mouseButtons: 0,

  // ---- the BIOS keyboard buffer getch reads: ASCII, or 0 then the scan code
  keys: [] as number[],

  // ---- the timer: milliseconds, advanced by the host
  timeMs: 0,

  // ---- a full-screen movie: Smacker drives the display itself while one plays
  movie: null as { width: number; height: number; pixels: Uint8Array; version: number } | null,
  /** the sound card: a movie's audio as it is decoded (the host plays it) */
  pcmOut: null as ((samples: Int16Array, rate: number, channels: number) => void) | null,
  /** the sound card's digital side, as Miles drives it; null for no card (every sample call is then a no-op, as without a driver) */
  digital: null as DigitalCard | null,
  /** the MIDI side: a General MIDI synth (the MDI driver's output); null for none */
  midi: null as MidiOut | null,
  /** the MDI driver MDI.INI names: the port's synth is General MIDI, as a Roland MPU-401 card would be */
  midiDriverName: 'MPU401.MDI',
};

/** @portOnly a Miles sample handle on the host's card: a RIFF WAV */
export interface SampleVoice {
  setVolume(v: number): void;
  /** 0 plays for ever */
  setLoopCount(n: number): void;
  start(): void;
  stop(): void;
  /** Miles' SMP_DONE: not playing */
  done(): boolean;
  release(): void;
}

/** @portOnly the digital driver: AIL_allocate_sample_handle + AIL_set_sample_file */
export interface DigitalCard {
  sample(wav: Uint8Array): SampleVoice | null;
}

/** @portOnly a mouse move the host reports, clamped to the screen as the driver's range (set by shell_input_sub_01be20) clamps it */
export function hwMouseMove(x: number, y: number): void {
  hardware.mouseX = Math.max(0, Math.min(SCREEN_W - 1, Math.round(x)));
  hardware.mouseY = Math.max(0, Math.min(SCREEN_H - 1, Math.round(y)));
}

/** @portOnly the int 33h button word */
export function hwMouseButtons(buttons: number): void {
  hardware.mouseButtons = buttons & 7;
}

/** @portOnly a key the BIOS would put in its buffer: `ascii`, or 0 then `scan` for an extended key */
export function hwKey(ascii: number, scan: number): void {
  if (ascii !== 0) hardware.keys.push(ascii & 0xff);
  else hardware.keys.push(0, scan & 0xff);
  // the BIOS buffer holds 15 keys; the port keeps a few more pairs rather than beep
  if (hardware.keys.length > 64) hardware.keys.splice(0, hardware.keys.length - 64);
}

/** kbhit(): a key is waiting. @portOnly the C runtime over the BIOS buffer */
export function kbhit(): boolean {
  return hardware.keys.length > 0;
}

/** getch(): the next byte of the buffer (0 before an extended key's scan code), or 0 when empty. @portOnly */
export function getch(): number {
  return hardware.keys.shift() ?? 0;
}

/** @portOnly the host advancing the timer (the 250 Hz tick counter times 4) */
export function hwAdvanceTime(ms: number): void {
  hardware.timeMs += ms;
}
