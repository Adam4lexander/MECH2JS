/**
 * The shell's full-screen movies (decompiled/mw2shell/src/movies/movies.c):
 * mintro at start-up, the landing movies before a Clan hall, the endings.
 * While one plays Smacker has the display: the mouse and the video driver
 * are shut down around it.
 */
import { SHELL_LABEL } from '../../generated/shell/labels.gen.ts';
import { dosFileLoadAsync } from '../../engine/dosFiles.ts';
import { VfxWindow, vfxWindowAllocate } from '../../engine/vfx/vfx.ts';
import { mem } from '../memory.ts';
import { shell } from '../state.ts';
import { awaitHost, WAIT, type Blocking } from '../host/blocking.ts';
import { getch, hardware, kbhit } from '../host/hardware.ts';
import { videoDriverResume, videoDriverSuspend } from '../video/driver.ts';
import { smackClose, smackDoFrame, smackNextFrame, smackOpen, smackToBuffer, smackWait, type Smack } from '../video/smack.ts';
import { Mouse, mouseInit, mouseShutdown } from '../ui/mouse.ts';
import { anims } from './anims.ts';

/** 'smk\<name>.smk', or on the CD's path when an open is to try it. */
function moviePath(name: string, cd: boolean): string {
  const prefix = mem().cstr(SHELL_LABEL.cdPath);
  return cd && prefix.length !== 0 ? `${prefix}smk\\${name}.smk` : `smk\\${name}.smk`;
}

/** Plays a decoded frame's sound on the host's card. */
function frameSound(s: Smack): void {
  const f = s.lastFrame;
  const out = hardware.pcmOut;
  if (!f || !out) return;
  const t = s.decoder.header.audio[0];
  const pcm = f.audio[0];
  if (t && pcm && pcm.length > 0) out(pcm, t.sampleRate, t.channels);
}

/**
 * (name, ...): plays smk\<name>.smk full screen - from the hard disk, or
 * failing that the CD; returns 0 when it cannot be opened (or movies are
 * off). The mouse and video driver are shut down around it. Each frame's
 * palette goes up when it changes; the frame is shown for its time; the
 * left button or a key ends it early (the key is eaten). Afterwards the
 * driver comes back with its palette forgotten, and a new mouse object.
 *
 * @mw2shell movie_play 0x00038c70
 * @fidelity exact
 * @divergence Smacker's full-screen output is the host's movie surface (hardware.movie), scaled to the display
 */
export function* moviePlay(name: string): Blocking<number> {
  if (mem().i32(SHELL_LABEL.moviesEnabled) === 0) return 1;
  let s = smackOpen(yield* awaitHost(dosFileLoadAsync(moviePath(name, anims.tryCd !== 0))));
  anims.tryCd = 0;
  if (!s) {
    s = smackOpen(yield* awaitHost(dosFileLoadAsync(moviePath(name, true))));
    if (!s) return 0;
  }
  const d = shell.videoDriver;
  if (d) {
    if (shell.shellMouse) mouseShutdown(shell.shellMouse);
    videoDriverSuspend(d);
  }
  // SmackToScreen: the movie owns the display
  const surface = new VfxWindow();
  vfxWindowAllocate(surface, s.width, s.height);
  smackToBuffer(s, surface, 0, 0);
  hardware.movie = { width: s.width, height: s.height, pixels: surface.buffer, version: 0 };
  let frame = 1;
  for (;;) {
    smackDoFrame(s);
    if (s.newPalette !== 0) {
      hardware.dac.set(s.palette);
      hardware.dacVersion++;
    }
    hardware.movie.version++;
    frameSound(s);
    if (frame === s.frames) break;
    smackNextFrame(s);
    while (smackWait(s) !== 0) yield WAIT;
    if ((hardware.mouseButtons & 1) !== 0) break;
    if (kbhit()) {
      getch();
      break;
    }
    frame++;
  }
  smackClose(s);
  hardware.movie = null;
  if (d) {
    videoDriverResume(d);
    shell.shellMouse = mouseInit(new Mouse(), d, shell.uiFont, shell.cursorShapes);
  }
  return 1;
}
