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
 * Frame timing is the shell's timer_read (the library calls it too), or -
 * for a movie whose sound is playing - the sound itself (smackWait).
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
  /** when frame 0 last went up (timer_read): frame n is due frameMs * n after it */
  startedAt = 0;
  readonly frameMs: number;
  /** the sound tracks SmackOpen was asked for (bit i: track i), which SmackDoFrame plays */
  readonly tracks: number;
  /** each track's whole sound, decoded the first time frame 0 plays */
  readonly trackPcm = new Map<number, Int16Array>();

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
  if (f.index === 0) s.startedAt = timerRead();
}

/**
 * The sound of the tracks the movie was opened with. At frame 0 - the
 * movie starting, or a looping animation going back to its start - each
 * track goes to the host whole, as one continuous buffer (decoded ahead,
 * no video decoded): per-frame pieces were each resampled on their own
 * and scheduled one by one, which clicked at the joins and gapped when the
 * page stalled. The host keeps it running until the movie is closed or
 * restarts.
 *
 * @portOnly the library's sound output, through the host
 */
function smackFrameSound(s: Smack, f: SmackerFrame): void {
  const out = hardware.pcmOut;
  if (!out || s.tracks === 0 || f.index !== 0) return;
  for (let track = 0; track < 7; track++) {
    if ((s.tracks & (1 << track)) === 0) continue;
    const t = s.decoder.header.audio.find((x) => x.track === track);
    if (!t) continue;
    let pcm = s.trackPcm.get(track);
    if (!pcm) {
      pcm = s.decoder.decodeAudioTrack(track);
      s.trackPcm.set(track, pcm);
    }
    if (pcm.length > 0) out(pcm, t.sampleRate, t.channels, s, true);
  }
}

/** @portOnly SmackNextFrame (0x4da48) */
export function smackNextFrame(s: Smack): void {
  s.frameNum = Math.min(s.frameNum + 1, s.frames - 1);
}

/**
 * @portOnly SmackWait (0x4e8e0): nonzero while the frame after the one last
 * decoded is not yet due (the shell asks both before and after
 * SmackNextFrame). Frame n is due frameMs * n into the movie, counted from
 * frame 0 - not from when the last frame went up, which let every late
 * frame push the rest back (the host's clock only moves once a display
 * frame, so at 60 Hz nearly every frame was late: mintro ran 87 s to its
 * sound's 77.5). While the movie's sound is playing, "into the movie" is
 * how far the sound has played, so the picture keeps to what is heard;
 * otherwise the shell's timer since frame 0.
 */
export function smackWait(s: Smack): number {
  const next = s.lastFrame ? s.lastFrame.index + 1 : 0;
  const into = hardware.pcmClock?.(s) ?? timerRead() - s.startedAt;
  return into < next * s.frameMs ? 1 : 0;
}

/**
 * @portOnly SmackGoto (0x4e564). The shell loops an animation with
 * SmackGoto(smk, 1) after counting its first frame as 1, so the argument is
 * read as 1-based here.
 */
export function smackGoto(s: Smack, frame: number): void {
  s.frameNum = Math.max(0, frame - 1);
}

/** @portOnly SmackClose (0x4d364): its sound stops */
export function smackClose(s: Smack): void {
  hardware.pcmStop?.(s);
  // the decoder holds only the file's bytes
}
