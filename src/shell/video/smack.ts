/**
 * The RAD Smacker library calls the shell makes (smacker/, 0x4bc70..: not
 * read - the library is decompiled assembly, and the port decodes with its
 * own reader, data/formats/smacker.ts). What the shell relies on is only the
 * calls' behaviour, which is RAD's documented API:
 *
 *   SmackOpen (0x4cb08)      open a file; the Smack's width, height and frame
 *                            count at +4, +8, +0xc, NewPalette at +0x68
 *   SmackToBuffer (0x4e060)  where SmackDoFrame puts the pixels
 *   SmackDoFrame (0x4d7ac)   decode the current frame into that buffer
 *   SmackNextFrame (0x4da48) advance to the next frame
 *   SmackWait (0x4e8e0)      nonzero while the current frame's time is not up
 *   SmackGoto (0x4e564)      jump to a frame
 *   SmackClose (0x4d364)
 *   SmackColorRemap (0x4e214) copy the movie's palette out
 *
 * Frame timing is the shell's timer_read (the library calls it too).
 */
import { SmackerDecoder, parseSmacker, type SmackerFrame } from '../../data/formats/smacker.ts';
import type { VfxWindow } from '../../engine/vfx/vfx.ts';
import { hardware } from '../host/hardware.ts';
import { timerRead } from '../host/timer.ts';

/** SmackOpen's sound-track bits: SMACKTRACK1..7, 0x200 << track (main's smackerOpenFlags is all seven, 0xfe00) */
export const SMACK_TRACKS = 0xfe00;

/** @portOnly an open Smacker movie, as the shell uses one */
export class Smack {
  readonly decoder: SmackerDecoder;
  readonly width: number;
  readonly height: number;
  readonly frames: number;
  /** the frame SmackDoFrame decodes, 0-based */
  frameNum = 0;
  /** +0x68: a new palette came with the last frame */
  newPalette = 0;
  /** the palette, 6-bit as the DAC wants it */
  readonly palette = new Uint8Array(768);
  /** SmackToBuffer's target: a window and the position in it */
  target: { win: VfxWindow; x: number; y: number } | null = null;
  /** the last frame decoded (its sound, for the host) */
  lastFrame: SmackerFrame | null = null;
  /** when the current frame went up (timer_read) */
  shownAt = 0;
  readonly frameMs: number;
  /** the sound tracks SmackOpen was asked for (bit i: track i), which SmackDoFrame plays */
  readonly tracks: number;

  constructor(bytes: Uint8Array, flags: number) {
    this.tracks = (flags & SMACK_TRACKS) >>> 9;
    const h = parseSmacker(bytes);
    this.decoder = new SmackerDecoder(bytes, h);
    this.width = h.width;
    this.height = h.displayHeight;
    this.frames = h.frames;
    this.frameMs = h.frameDurationUs / 1000;
  }
}

/**
 * SmackOpen over a file's bytes with its open flags - the sound tracks
 * among them (SMACK_TRACKS) are played as frames are decoded; null when it
 * is not a Smacker file.
 *
 * @portOnly RAD's SmackOpen (0x4cb08), over the port's decoder
 */
export function smackOpen(bytes: Uint8Array | null, flags: number): Smack | null {
  if (!bytes) return null;
  try {
    return new Smack(bytes, flags);
  } catch {
    return null;
  }
}

/** @portOnly SmackToBuffer (0x4e060): frames go to (x, y) of `win` */
export function smackToBuffer(s: Smack, win: VfxWindow, x: number, y: number): void {
  s.target = { win, x, y };
}

/**
 * @portOnly SmackDoFrame (0x4d7ac): decodes the current frame into the
 * buffer, and - as the library does through Miles for a movie opened with
 * sound tracks - sends the frame's sound on those tracks to the host
 * (`sound` false decodes silently: a frame decoded only for its palette).
 */
export function smackDoFrame(s: Smack, sound = true): void {
  if (s.decoder.nextFrame !== s.frameNum) {
    s.decoder.reset();
    while (s.decoder.nextFrame < s.frameNum) s.decoder.decodeNextFrame();
  }
  const f = s.decoder.decodeNextFrame();
  if (!f) return;
  s.lastFrame = f;
  if (sound) smackFrameSound(s, f);
  s.newPalette = f.paletteChanged || s.frameNum === 0 ? 1 : 0;
  // the decoder's palette is 8-bit ((v << 2) | (v >> 4)): back to the DAC's 6
  for (let i = 0; i < 768; i++) s.palette[i] = f.palette[i]! >> 2;
  const t = s.target;
  if (t) {
    const pitch = t.win.xMax + 1;
    for (let row = 0; row < s.height; row++) {
      const Y = t.y + row;
      if (Y < 0 || Y > t.win.yMax) continue;
      for (let col = 0; col < s.width; col++) {
        const X = t.x + col;
        if (X >= 0 && X <= t.win.xMax) t.win.buffer[Y * pitch + X] = f.pixels[row * s.width + col]!;
      }
    }
  }
  s.shownAt = timerRead();
}

/** A decoded frame's sound on the tracks the movie was opened with, to the host's PCM output. @portOnly */
function smackFrameSound(s: Smack, f: SmackerFrame): void {
  const out = hardware.pcmOut;
  if (!out || s.tracks === 0) return;
  for (let i = 0; i < 7; i++) {
    if ((s.tracks & (1 << i)) === 0) continue;
    const t = s.decoder.header.audio[i];
    const pcm = f.audio[i];
    if (t && pcm && pcm.length > 0) out(pcm, t.sampleRate, t.channels);
  }
}

/** @portOnly SmackNextFrame (0x4da48) */
export function smackNextFrame(s: Smack): void {
  s.frameNum = Math.min(s.frameNum + 1, s.frames - 1);
}

/** @portOnly SmackWait (0x4e8e0): nonzero while the current frame is still due to be up */
export function smackWait(s: Smack): number {
  return timerRead() - s.shownAt < s.frameMs ? 1 : 0;
}

/**
 * @portOnly SmackGoto (0x4e564). The shell loops an animation with
 * SmackGoto(smk, 1) after counting its first frame as 1, so the argument is
 * read as 1-based here.
 */
export function smackGoto(s: Smack, frame: number): void {
  s.frameNum = Math.max(0, frame - 1);
}

/** @portOnly SmackClose (0x4d364) */
export function smackClose(_s: Smack): void {
  // the decoder holds only the file's bytes
}
