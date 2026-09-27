/**
 * The shell's globals that point at heap objects main builds - the video
 * driver, the mouse, the open archive, the font holders, the input object -
 * as references (the port's heap objects are JS objects). Everything else
 * the shell keeps in its data segment is in shell/memory.ts at its own
 * address. Reset when the shell process starts; main fills them.
 */
import { registerGlobals } from '../engine/globals.ts';
import type { MPackDb } from '../data/formats/mpack.ts';
import type { VideoDriver } from './video/driver.ts';
import type { Mouse } from './ui/mouse.ts';
import type { FontHolder } from './ui/labels.ts';
import type { KeyInput } from './ui/keys.ts';
import type { Sample } from './sound/samples.ts';
import type { ShellSoundSystem, Song } from './sound/music.ts';

export const shell = registerGlobals(
  'main',
  {
    /** 0x91168 */
    videoDriver: null as VideoDriver | null,
    /** 0x91164 */
    shellMouse: null as Mouse | null,
    /** 0x9118c: DATABASE.MW2 */
    database: null as MPackDb | null,
    /** 0x91158: the key slot input_poll_key fills */
    keyInput: null as KeyInput | null,
    /** 0x91160: DATABASE item 0x19, the pointer's shapes */
    cursorShapes: null as Uint8Array | null,
    /** 0x9116c.. the font holders main builds from DATABASE items 26, 27, 28, 30, 31, 32 */
    uiFont: null as FontHolder | null,
    font32: null as FontHolder | null,
    font27: null as FontHolder | null,
    font28: null as FontHolder | null,
    font30: null as FontHolder | null,
    font31: null as FontHolder | null,
    archiveFont: null as FontHolder | null,
    pageFont: null as FontHolder | null,
    /** 0x9115c */
    soundSystem: null as ShellSoundSystem | null,
    /** 0x91690.. DATABASE items 77 (looping), 101, 102, 103 */
    sound77: null as Sample | null,
    sound101: null as Sample | null,
    sound102: null as Sample | null,
    sound103: null as Sample | null,
    /** 0xa6380: the song playing, and its DATABASE item (0xa6384) */
    currentMusic: null as Song | null,
  },
  () => {
    for (const k of Object.keys(shell) as Array<keyof typeof shell>) (shell as Record<string, unknown>)[k] = null;
  },
  'mw2shell',
);

/** @portOnly main's video driver; fails before main has built it */
export function driver(): VideoDriver {
  if (!shell.videoDriver) throw new Error('the shell has no video driver yet');
  return shell.videoDriver;
}

/** @portOnly main's mouse */
export function mouse(): Mouse {
  if (!shell.shellMouse) throw new Error('the shell has no mouse yet');
  return shell.shellMouse;
}

/** @portOnly main's DATABASE.MW2 */
export function database(): MPackDb {
  if (!shell.database) throw new Error('DATABASE.MW2 is not open');
  return shell.database;
}
