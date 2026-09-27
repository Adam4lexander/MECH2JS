/**
 * The shell's screen animations: 32 slots (animSlots, 0xa679c, 0x3c each),
 * each a VFX shape table (smk\<name>.shp) or a Smacker movie
 * (smk\<name>.smk) at a place on the screen, stepped once a pass by
 * anim_update_all between the two label lists. The files are looked for on
 * the hard disk first, then on the CD. decompiled/mw2shell/src/movies/
 * movies.c; every call is listed in listing/screen_anims.txt.
 *
 * Slot flags: 0x80000000 active, 0x40000000 free on the next pass,
 * 0x20000000 follow the mouse, 0x10000000 take the movie's palette, 0x100
 * changed (draw unconditionally), 0x80 anchored bottom-centre, 0x40 open
 * the movie with Smacker flag 0x20, 0x20 hidden, 0x10 drawn, 8 loop, 4
 * hold the last frame, 2 decode a movie into the background, 1 stopped.
 */
import { SHELL_LABEL } from '../../generated/shell/labels.gen.ts';
import { VfxWindow, vfxShapeBounds, vfxShapeCount, vfxWindowAllocate } from '../../engine/vfx/vfx.ts';
import { dosFileLoadAsync } from '../../engine/dosFiles.ts';
import { mem } from '../memory.ts';
import { driver, shell } from '../state.ts';
import { awaitHost, type Blocking } from '../host/blocking.ts';
import { timerRead } from '../host/timer.ts';
import { registerGlobals } from '../../engine/globals.ts';
import { videoDriverErase, videoDriverPut, videoDriverPutIfDirty, videoDriverShape, videoDriverShapeIfDirty } from '../video/driver.ts';
import { labelsRedraw } from '../ui/labels.ts';
import { mouseUpdate } from '../ui/mouse.ts';
import { smackClose, smackDoFrame, smackGoto, smackNextFrame, smackOpen, smackToBuffer, smackWait, type Smack } from '../video/smack.ts';

/** @portOnly an AnimSlot (0x3c bytes) as a live object */
export class AnimSlot {
  /** +0x00 */
  smk: Smack | null = null;
  /** +0x04 */
  shapes: Uint8Array | null = null;
  /** +0x08 a movie's own frame buffer, width x height */
  frameBuffer: VfxWindow | null = null;
  /** +0x0c */
  flags = 0;
  x = 0;
  y = 0;
  width = 0;
  height = 0;
  prevX = 0;
  prevY = 0;
  prevFrame = 0;
  frame = 0;
  frameCount = 0;
  /** +0x34 1000 / rate */
  frameInterval = 0;
  /** +0x38 timer_read() when the next shape is due */
  nextFrameTime = 0;
}

export const anims = registerGlobals(
  'anims',
  {
    /** 0xa679c */
    animSlots: Array.from({ length: 32 }, () => new AnimSlot()),
    /** 0xa6798: the next open tries the CD's path first */
    tryCd: 0,
  },
  () => {
    anims.animSlots = Array.from({ length: 32 }, () => new AnimSlot());
    anims.tryCd = 0;
  },
  'mw2shell',
);

const ACTIVE = 0x80000000 | 0;

/** 'smk\<name>.<ext>', or '<cdPath>smk\<name>.<ext>' when the CD is to be tried and there is one. */
function animPath(name: string, ext: string): string {
  const cd = mem().cstr(SHELL_LABEL.cdPath);
  const onCd = anims.tryCd !== 0 && cd.length !== 0;
  anims.tryCd = 0;
  return onCd ? `${cd}smk\\${name}.${ext}` : `smk\\${name}.${ext}`;
}

/**
 * Opens <name>.smk into the slot: its size and frame count from the
 * header, the palette taken into the driver with flag 0x10000000, the
 * bottom-centre anchor with 0x80, and a frame buffer of its own unless
 * flag 2 (which decodes it straight into the background window, from which
 * erasing copies it to the screen). 0 when it will not open.
 *
 * @mw2shell anim_open_smk 0x00039780
 * @fidelity exact
 */
export function* animOpenSmk(slot: AnimSlot, name: string): Blocking<number> {
  const path = animPath(name, 'smk');
  const smk = smackOpen(yield* awaitHost(dosFileLoadAsync(path)));
  slot.smk = smk;
  if (!smk) return 0;
  const d = driver();
  if ((slot.flags & 0x10000000) !== 0) {
    // SmackColorRemap into the driver's palette: the first frame's, once decoded
    smackDoFrame(smk);
    d.palette.set(smk.palette);
    smk.frameNum = 0;
  }
  slot.width = smk.width;
  slot.height = smk.height;
  if ((slot.flags & 0x80) !== 0) {
    slot.x -= (slot.width / 2) | 0;
    slot.y -= slot.height;
  }
  slot.frame = 0;
  slot.frameCount = smk.frames;
  slot.prevFrame = slot.frame;
  if ((slot.flags & 2) === 0) {
    const buf = new VfxWindow();
    vfxWindowAllocate(buf, slot.width, slot.height);
    slot.frameBuffer = buf;
    smackToBuffer(smk, buf, 0, 0);
  } else {
    // straight into the BACKGROUND at (x, y), pitch 640: erasing the slot's rectangle then carries each frame to the screen
    slot.frameBuffer = null;
    smackToBuffer(smk, d.background, slot.x, slot.y);
  }
  return 1;
}

/**
 * Loads <name>.shp as a VFX shape table into the slot: its size from shape
 * 0's bounds, the shape count as its frames. 0 when the file is missing.
 *
 * @mw2shell anim_open_shp 0x000398d0
 * @fidelity exact
 */
export function* animOpenShp(slot: AnimSlot, name: string): Blocking<number> {
  const path = animPath(name, 'shp');
  const shapes = yield* awaitHost(dosFileLoadAsync(path));
  slot.shapes = shapes;
  if (!shapes) return 0;
  const b = vfxShapeBounds(shapes, 0);
  slot.width = (b >> 16) + 1;
  slot.height = (b & 0xffff) + 1;
  if ((slot.flags & 0x80) !== 0) {
    slot.x -= (slot.width / 2) | 0;
    slot.y -= slot.height;
  }
  slot.frame = 0;
  slot.frameBuffer = null;
  slot.nextFrameTime = 0;
  slot.frameCount = vfxShapeCount(shapes);
  slot.prevFrame = slot.frame;
  return 1;
}

/** The open sequence anim_start and anim_start_free share: .shp, .smk, then both from the CD. */
function* animOpen(slot: AnimSlot, name: string): Blocking<boolean> {
  if (yield* animOpenShp(slot, name)) return true;
  if (yield* animOpenSmk(slot, name)) return true;
  anims.tryCd = 1;
  if (yield* animOpenShp(slot, name)) return true;
  anims.tryCd = 1;
  return (yield* animOpenSmk(slot, name)) !== 0;
}

/** Stops an active slot first, restoring what it covered when it was drawn. */
function animReplace(i: number): void {
  const s = anims.animSlots[i]!;
  if ((s.flags & ACTIVE) !== 0) {
    if ((s.flags & 0x10) !== 0) videoDriverErase(driver(), s.prevX, s.prevY, s.width, s.height);
    animFree(i);
  }
}

/**
 * (slot, name, x, y, flags, rate): starts an animation in a slot (0..31),
 * stopping what was there; frameInterval = 1000 / rate (rate 0 means 10).
 * Returns the slot, or -1.
 *
 * @mw2shell anim_start 0x000399b0
 * @fidelity exact
 */
export function* animStart(i: number, name: string, x: number, y: number, flags: number, rate: number): Blocking<number> {
  flags &= ~0x10000000;
  if (i < 0 || i > 0x1f) return -1;
  animReplace(i);
  const s = anims.animSlots[i]!;
  s.x = x;
  s.y = y;
  s.flags = flags | 0x80000100;
  if (rate === 0) rate = 10;
  s.frameInterval = Math.floor(1000 / (rate >>> 0));
  if (!(yield* animOpen(s, name))) {
    s.flags = 0;
    return -1;
  }
  s.prevX = s.x;
  s.prevY = s.y;
  return i;
}

/**
 * anim_start in the first free slot.
 *
 * @mw2shell anim_start_free 0x00039ad0
 * @fidelity exact
 */
export function* animStartFree(name: string, x: number, y: number, flags: number, rate: number): Blocking<number> {
  for (let i = 0; i < 0x20; i++) {
    const s = anims.animSlots[i]!;
    if ((s.flags & ACTIVE) !== 0) continue;
    s.x = x;
    s.y = y;
    s.flags = (flags & ~0x10000000) | 0x80000100;
    if (rate === 0) rate = 10;
    s.frameInterval = Math.floor(1000 / (rate >>> 0));
    if (!(yield* animOpen(s, name))) {
      s.flags = 0;
      return -1;
    }
    s.prevX = s.x;
    s.prevY = s.y;
    return i;
  }
  return -1;
}

/**
 * Closes the movie, frees the shapes and frame buffer, clears the flags.
 *
 * @mw2shell anim_free 0x00039650
 * @fidelity exact
 */
export function animFree(i: number): void {
  if (i < 0 || i > 0x1f) return;
  const s = anims.animSlots[i]!;
  if (s.smk) smackClose(s.smk);
  s.smk = null;
  s.shapes = null;
  s.flags = 0;
  s.frameBuffer = null;
}

/**
 * @mw2shell anim_free_all 0x000396f0
 * @fidelity exact
 */
export function animFreeAll(): void {
  for (let i = 0; i < 0x20; i++) animFree(i);
}

/**
 * Active and not stopped.
 *
 * @mw2shell anim_is_running 0x00039590
 * @fidelity exact
 */
export function animIsRunning(i: number): number {
  if (i < 0 || i >= 0x20) return 0;
  const f = anims.animSlots[i]!.flags;
  return (f & ACTIVE) !== 0 && (f & 1) === 0 ? 1 : 0;
}

/**
 * flags = flags & ~mask | value & mask.
 *
 * @mw2shell anim_set_flags 0x000395d0
 * @fidelity exact
 */
export function animSetFlags(i: number, mask: number, value: number): void {
  if (i < 0 || i >= 0x20) return;
  const s = anims.animSlots[i]!;
  s.flags = (s.flags & ~mask) | (mask & value);
}

/**
 * Unhides a hidden slot and marks it changed.
 *
 * @mw2shell anim_unhide 0x00039610
 * @fidelity exact
 */
export function animUnhide(i: number): void {
  if (i < 0 || i >= 0x20) return;
  const s = anims.animSlots[i]!;
  if ((s.flags & 0x20) !== 0) s.flags = (s.flags & ~0x20) | 0x100;
}

/**
 * Moves an active slot (bottom-centre anchored with 0x80).
 *
 * @mw2shell anim_move 0x00039710
 * @fidelity exact
 */
export function animMove(i: number, x: number, y: number): void {
  if (i < 0 || i >= 0x20) return;
  const s = anims.animSlots[i]!;
  if ((s.flags & ACTIVE) === 0) return;
  if ((s.flags & 0x80) !== 0) {
    x -= (s.width / 2) | 0;
    y -= s.height;
  }
  s.x = x;
  s.y = y;
}

/**
 * Shows a given frame (0 past the end) and forces a redraw.
 *
 * @mw2shell anim_set_frame 0x00039fb0
 * @fidelity exact
 */
export function animSetFrame(i: number, frame: number): void {
  if (i < 0 || i >= 0x20) return;
  const s = anims.animSlots[i]!;
  if (s.frameCount <= frame) frame = 0;
  s.frame = frame;
  s.prevFrame = -1;
}

/**
 * The per-pass step. Pass 1: a movie at frame 0 decodes its first frame; a
 * slot that moved, changed frame, is hidden or is being freed has its old
 * rectangle restored (if drawn) and is marked changed; a slot being freed
 * is freed. Then the under labels. Pass 2: each slot follows the mouse
 * (0x20000000), is drawn unless hidden (a changed one always, else only
 * where the dirty rectangle reaches it), and advances unless stopped -
 * shapes on the timer, movies when the decoder says the next frame is due;
 * at the end it holds (4), loops (8) or stops and is freed. Then the over
 * labels.
 *
 * @mw2shell anim_update_all 0x00039270
 * @fidelity exact
 */
export function animUpdateAll(): void {
  const d = driver();
  for (let i = 0; i < 0x20; i++) {
    const s = anims.animSlots[i]!;
    if ((s.flags & ACTIVE) === 0) continue;
    if (s.smk && s.frame === 0 && (s.flags & 1) === 0) {
      smackDoFrame(s.smk);
      if ((s.flags & 2) !== 0) s.flags |= 0x10;
      s.frame = 1;
    }
    if (s.smk && (s.flags & 2) === 0) s.prevFrame = s.frame;
    if (s.x !== s.prevX || s.y !== s.prevY || s.frame !== s.prevFrame || (s.flags & 0x40000020) !== 0) {
      if ((s.flags & 0x10) !== 0) videoDriverErase(d, s.prevX, s.prevY, s.width, s.height);
      s.flags |= 0x100;
    }
    s.prevX = s.x;
    s.prevY = s.y;
    s.prevFrame = s.frame;
    s.flags &= ~0x10;
    if ((s.flags & 0x40000000) !== 0) animFree(i);
  }
  labelsRedraw(d, 0);
  const m = shell.shellMouse!;
  for (let i = 0; i < 0x20; i++) {
    const s = anims.animSlots[i]!;
    if ((s.flags & ACTIVE) === 0) continue;
    if ((s.flags & 0x20000000) !== 0) {
      s.x = m.x;
      s.y = m.y;
    }
    if (!s.smk) {
      if (!s.shapes) continue;
      if ((s.flags & 0x20) === 0) {
        const changed = (s.flags & 0x100) !== 0;
        s.flags |= 0x10;
        if (changed) videoDriverShape(d, s.shapes, s.frame, s.x, s.y, s.width, s.height);
        else videoDriverShapeIfDirty(d, s.shapes, s.frame, s.x, s.y, s.width, s.height);
        s.flags &= ~0x100;
      }
      if ((s.flags & 1) === 0) {
        const now = timerRead();
        if (now >>> 0 >= s.nextFrameTime >>> 0) {
          s.nextFrameTime = (now + s.frameInterval) | 0;
          const was = s.frame;
          s.frame = was + 1;
          if (s.frameCount <= s.frame) {
            s.frame = was;
            if ((s.flags & 4) !== 0) s.flags |= 1;
            else if ((s.flags & 8) !== 0) s.frame = 0;
            else s.flags |= 0x40000001;
          }
          s.flags |= 0x100;
        }
      }
    } else {
      if (s.frameBuffer && (s.flags & 0x20) === 0) {
        const changed = (s.flags & 0x100) !== 0;
        s.flags |= 0x10;
        if (changed) videoDriverPut(d, s.frameBuffer, s.x, s.y, s.width, s.height);
        else videoDriverPutIfDirty(d, s.frameBuffer, s.x, s.y, s.width, s.height);
        s.flags &= ~0x100;
      }
      if ((s.flags & 1) === 0 && smackWait(s.smk) === 0) {
        const was = s.frame;
        s.frame = was + 1;
        if (s.frameCount < s.frame) {
          s.frame = was;
          if ((s.flags & 4) !== 0) s.flags |= 1;
          else if ((s.flags & 8) !== 0) {
            s.frame = 1;
            smackGoto(s.smk, 1);
            advanced(s);
          } else s.flags |= 0x40000001;
        } else {
          if (s.frame !== 1) smackNextFrame(s.smk);
          advanced(s);
        }
      }
    }
  }
  labelsRedraw(d, 1);
}

/** A movie slot's new frame: decoded, marked changed, and drawn-flagged when it goes straight to the screen. */
function advanced(s: AnimSlot): void {
  smackDoFrame(s.smk!);
  s.flags |= 0x100;
  if ((s.flags & 2) !== 0) s.flags |= 0x10;
}

/**
 * Plays one slot through: its loop flag cleared, then anim_update_all's two
 * passes and a present, until that slot stops or is freed - the Jade Falcon
 * doors, the holoprojector, the training intro.
 *
 * @mw2shell anim_play_to_end 0x00039c20
 * @fidelity exact
 */
export function* animPlayToEnd(i: number): Blocking<void> {
  if (i >= 0 && i < 0x20) anims.animSlots[i]!.flags &= ~8;
  for (;;) {
    animUpdateAll();
    yield* mouseUpdate(shell.shellMouse!);
    const s = i >= 0 && i < 0x20 ? anims.animSlots[i]! : null;
    if (!s || (s.flags & ACTIVE) === 0 || (s.flags & 1) !== 0) return;
  }
}
