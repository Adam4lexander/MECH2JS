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
import { getch, hardware, kbhit, SCREEN_H, SCREEN_W } from '../host/hardware.ts';
import { videoDriverMarkDirty, videoDriverResume, videoDriverSuspend } from '../video/driver.ts';
import { smackClose, smackDoFrame, smackGoto, smackNextFrame, smackOpen, smackToBuffer, smackWait, type Smack } from '../video/smack.ts';
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

/**
 * Plays smk\<name>.smk over the current screen: straight to the display
 * and the DAC (the register's 640x480 transitions), the video driver left
 * as it is - the screen shows the movie's last frame until the shell draws
 * over it. Nothing ends it early.
 *
 * @mw2shell movie_play_inline 0x00038e80
 * @fidelity exact
 */
export function* moviePlayInline(name: string): Blocking<void> {
  if (mem().i32(SHELL_LABEL.moviesEnabled) === 0) return;
  let s = smackOpen(yield* awaitHost(dosFileLoadAsync(moviePath(name, anims.tryCd !== 0))));
  anims.tryCd = 0;
  if (!s) {
    s = smackOpen(yield* awaitHost(dosFileLoadAsync(moviePath(name, true))));
    if (!s) return;
  }
  // shell_input_sub_01afa0 / _01af70 hide and show the pointer around it
  hardware.cursorShown = false;
  const screen = new VfxWindow();
  vfxWindowAllocate(screen, SCREEN_W, SCREEN_H);
  screen.buffer = hardware.screen;
  smackToBuffer(s, screen, 0, 0);
  let frame = 1;
  for (;;) {
    smackDoFrame(s);
    if (s.newPalette !== 0) {
      hardware.dac.set(s.palette);
      hardware.dacVersion++;
    }
    hardware.screenVersion++;
    frameSound(s);
    if (frame === s.frames) break;
    smackNextFrame(s);
    while (smackWait(s) !== 0) yield WAIT;
    frame++;
  }
  smackClose(s);
  hardware.cursorShown = true;
}

/** @portOnly a movie_open_background movie: {handle, x, y, width, height, frame} */
export class BackgroundMovie {
  smk: Smack | null = null;
  x = 0;
  y = 0;
  width = 0;
  height = 0;
  frame = 1;
}

/**
 * (movie, name, x, y): opens smk\<name>.smk and decodes its first frame
 * into the screen at (x, y) - the amwlogo1 loop behind the menu's
 * sub-screens.
 *
 * @mw2shell movie_open_background 0x00039000
 * @fidelity exact
 */
export function* movieOpenBackground(m: BackgroundMovie, name: string, x: number, y: number): Blocking<BackgroundMovie> {
  const s = smackOpen(yield* awaitHost(dosFileLoadAsync(moviePath(name, false)))) ?? smackOpen(yield* awaitHost(dosFileLoadAsync(moviePath(name, true))));
  m.smk = s;
  m.x = x;
  m.y = y;
  m.frame = 1;
  if (!s) return m;
  m.width = s.width;
  m.height = s.height;
  const d = shell.videoDriver!;
  smackToBuffer(s, d.screen, x, y);
  smackDoFrame(s);
  return m;
}

/**
 * When the next frame is due: advance (back to frame 1 after the last),
 * decode it into the screen and mark its rectangle dirty.
 *
 * @mw2shell movie_background_step 0x000391e0
 * @fidelity exact
 */
export function movieBackgroundStep(m: BackgroundMovie): void {
  const s = m.smk;
  if (!s || smackWait(s) !== 0) return;
  m.frame++;
  if (s.frames < m.frame) {
    m.frame = 1;
    smackGoto(s, m.frame);
  } else smackNextFrame(s);
  smackDoFrame(s);
  videoDriverMarkDirty(shell.videoDriver!, m.x, m.y, m.width, m.height);
}

/**
 * @mw2shell movie_background_close 0x00039140
 * @fidelity exact
 */
export function movieBackgroundClose(m: BackgroundMovie): BackgroundMovie {
  if (m.smk) smackClose(m.smk);
  return m;
}
