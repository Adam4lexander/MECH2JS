/**
 * The shell's video driver object (main's videoDriver, 0x3a6 bytes): a VFX
 * double buffer over the 640x480 screen. decompiled/mw2shell/src/vfx/
 * video_driver.c.
 *
 *   +0x16 / +0x1a  the label lists drawn over / under the animations
 *   +0x1e          palette dirty: the next present uploads +0x8e and blits
 *                  the whole screen
 *   +0x2a          the screen window (what screens draw into)
 *   +0x3e          the background window: the screen as the background
 *                  image left it, which erasing copies back from
 *   +0x52 / +0x66  panes over the two windows (the whole of each)
 *   +0x7a          the dirty pane: the rectangle drawn since the last
 *                  present (+0x7e x0, +0x82 y0, +0x86 x1, +0x8a y1), kept
 *                  inverted (x0 = xMax, x1 = 0) when nothing is dirty
 *   +0x8e          the palette, 256 x RGB, 6-bit
 *   +0x38e/+0x392  width, height; +0x396/+0x39a their maxima
 *   +0x39e         1 when the background just loaded had the palette
 *                  already up: the next present skips the black-out
 *   +0x3a2         the fill colour erasing passes VFX_pane_copy (-1: none)
 *
 * The VFX display driver itself (DATABASE.MW2 item 0x21, loaded through
 * shell_input_sub_019d50, reached through the hook table at 0x84728) is the
 * port's hardware layer (host/hardware.ts): its entry points are set-DAC-
 * entry (0x8474c), set graphics mode (0x8472c) and shut down (0x84730).
 */
import { ViewWindow } from '../../generated/classes.gen.ts';
import { VfxWindow, vfxCharacterDraw, vfxCharacterWidth, vfxFontHeight, vfxLineDraw, vfxShapeDraw, vfxStringDraw, vfxWindowAllocate } from '../../engine/vfx/vfx.ts';
import { divergence } from '../../core/provenance.ts';
import { hardware, SCREEN_H, SCREEN_W } from '../host/hardware.ts';
import { cursorRefresh, screenBlit } from './cursor.ts';

/** A label list (label_list_init): a collection of labels, drawn in order. @portOnly the collection's storage */
export type LabelList<L> = L[];

/** @portOnly the driver object's layout (see the module note) */
export class VideoDriver<L = unknown> {
  /** +0x16 */
  labelsOver: LabelList<L> = [];
  /** +0x1a */
  labelsUnder: LabelList<L> = [];
  /** +0x1e */
  paletteDirty = 0;
  /** +0x2a */
  screen = new VfxWindow();
  /** +0x3e */
  background = new VfxWindow();
  /** +0x52 */
  screenPane = new ViewWindow();
  /** +0x66 */
  backgroundPane = new ViewWindow();
  /** +0x7a: canvas is the screen pane (the blit's source) */
  dirty = new ViewWindow();
  /** +0x8e */
  palette = new Uint8Array(768);
  /** +0x38e */
  width = 0;
  /** +0x392 */
  height = 0;
  /** +0x39e */
  paletteUnchanged = 0;
  /** +0x3a2 */
  fillColour = -1;
}

/** Grows the dirty rectangle to cover x0..x1, y0..y1 (inclusive) - every drawing routine's epilogue. @portOnly */
export function dirtyAdd(d: VideoDriver, x0: number, y0: number, x1: number, y1: number): void {
  if (x0 < d.dirty.left) d.dirty.left = x0;
  if (y0 < d.dirty.top) d.dirty.top = y0;
  if (d.dirty.right < x1) d.dirty.right = x1;
  if (d.dirty.bottom < y1) d.dirty.bottom = y1;
}

/** Empties the dirty rectangle (inverted to the screen pane's bounds). @portOnly */
function dirtyReset(d: VideoDriver): void {
  d.dirty.left = d.screenPane.right;
  d.dirty.top = d.screenPane.bottom;
  d.dirty.right = d.screenPane.left;
  d.dirty.bottom = d.screenPane.top;
}

/** The DAC loop of the driver: every entry set to the black at 0xa7d74 (hook 0x8474c). */
function dacBlackOut(): void {
  hardware.dac.fill(0);
  hardware.dacVersion++;
}

/**
 * Builds the driver: loads the VFX display driver, allocates the screen and
 * background windows at the mode's size, the panes over them, the two label
 * lists and the identity colour table at 0xa7d78 (entry 0 = 0xff,
 * transparent); blacks out the DAC, sets the mode, blacks it out again.
 *
 * @mw2shell video_driver_sub_03dd90 0x0003dd90
 * @fidelity exact
 * @divergence the VFX driver (DATABASE item 0x21) is the port's hardware layer, a fixed 640x480 mode
 */
export function videoDriverInit(d: VideoDriver): VideoDriver {
  divergence('the VFX display driver (DATABASE.MW2 item 0x21) is the port’s own 640x480 screen', 'video_driver_sub_03dd90');
  d.width = SCREEN_W;
  d.height = SCREEN_H;
  vfxWindowAllocate(d.screen, d.width, d.height);
  vfxWindowAllocate(d.background, d.width, d.height);
  for (const [pane, win] of [
    [d.screenPane, d.screen],
    [d.backgroundPane, d.background],
  ] as const) {
    pane.canvas = win;
    pane.left = 0;
    pane.top = 0;
    pane.right = d.width - 1;
    pane.bottom = d.height - 1;
  }
  d.dirty.canvas = d.screenPane;
  dirtyReset(d);
  d.labelsOver = [];
  d.labelsUnder = [];
  d.paletteUnchanged = 0;
  d.fillColour = -1;
  dacBlackOut();
  dacBlackOut();
  return d;
}

/** The colour table screen_draw_text uses when given none (0xa7d78): identity, entry 0 transparent. */
export const identityRemap: Uint8Array = (() => {
  const t = new Uint8Array(256);
  for (let i = 1; i < 256; i++) t[i] = i;
  t[0] = 0xff;
  return t;
})();

/**
 * Blacks out the DAC and shuts the display driver down - before a
 * full-screen movie takes the display over.
 *
 * @mw2shell video_driver_sub_03dfe0 0x0003dfe0
 * @fidelity exact
 */
export function videoDriverSuspend(_d: VideoDriver): void {
  dacBlackOut();
}

/**
 * After a movie: black out, set the mode again, black out, forget the
 * palette (zeroed) and mark it dirty, so the next present puts up whatever
 * the screen draws next.
 *
 * @mw2shell video_driver_sub_03e020 0x0003e020
 * @fidelity exact
 */
export function videoDriverResume(d: VideoDriver): void {
  dacBlackOut();
  dacBlackOut();
  d.palette.fill(0);
  d.paletteDirty = 1;
  d.paletteUnchanged = 0;
  d.fillColour = -1;
}

/**
 * Frees the two label lists and windows and shuts the display driver down.
 *
 * @mw2shell video_driver_sub_03e0a0 0x0003e0a0
 * @fidelity exact
 */
export function videoDriverFree(d: VideoDriver): void {
  d.labelsOver = [];
  d.labelsUnder = [];
}

/**
 * Marks x, y, w, h dirty - what a movie drawn straight into the screen
 * window reports.
 *
 * @mw2shell video_driver_sub_03e130 0x0003e130
 * @fidelity exact
 */
export function videoDriverMarkDirty(d: VideoDriver, x: number, y: number, w: number, h: number): void {
  dirtyAdd(d, x, y, x + w - 1, y + h - 1);
}

/**
 * The present, once per pass (from mouse_update). The dirty rectangle is
 * clipped to the screen; with the palette dirty the DAC is blacked out
 * (unless the palette was already up), the whole screen blitted, and the
 * palette uploaded; otherwise the dirty rectangle is blitted, or when there
 * is none only the pointer is refreshed. Then the rectangle is emptied.
 *
 * @mw2shell video_driver_sub_03e1f0 0x0003e1f0
 * @fidelity exact
 */
export function videoDriverPresent(d: VideoDriver): void {
  const p = d.screenPane;
  if (d.dirty.left < p.left) d.dirty.left = p.left;
  if (d.dirty.top < p.top) d.dirty.top = p.top;
  if (p.right < d.dirty.right) d.dirty.right = p.right;
  if (p.bottom < d.dirty.bottom) d.dirty.bottom = p.bottom;
  if (d.paletteDirty === 0) {
    if (d.dirty.left <= d.dirty.right && d.dirty.top <= d.dirty.bottom) screenBlit(d.screenPane, d.dirty.left, d.dirty.top, d.dirty.right, d.dirty.bottom);
    else cursorRefresh();
  } else {
    d.paletteDirty = 0;
    if (d.paletteUnchanged === 0) dacBlackOut();
    screenBlit(d.screenPane, 0, 0, 0x27f, 0x1df);
    if (d.paletteUnchanged === 0) {
      // smacker_sub_04e9e0: the 256 triplets straight to the DAC ports
      hardware.dac.set(d.palette);
      hardware.dacVersion++;
    }
    d.paletteUnchanged = 0;
  }
  dirtyReset(d);
}

/**
 * Copies the driver's palette out (shell_menu keeps it while it draws its
 * own).
 *
 * @mw2shell video_driver_sub_03e310 0x0003e310
 * @fidelity exact
 */
export function videoDriverPaletteSave(d: VideoDriver, out: Uint8Array): void {
  out.set(d.palette.subarray(0, 768));
}

/**
 * Puts a saved palette back and marks it dirty.
 *
 * @mw2shell video_driver_sub_03e340 0x0003e340
 * @fidelity exact
 */
export function videoDriverPaletteRestore(d: VideoDriver, saved: Uint8Array): void {
  d.palette.set(saved.subarray(0, 768));
  d.paletteDirty = 1;
}

/**
 * VFX_pane_copy(source, Xs, Ys, target, Xt, Yt, fill): each pane clipped to
 * its window, then to the other shifted by (Xs - Xt, Ys - Yt); over that
 * rectangle the target's pixel at Xt + k takes the source's at Xs + k -
 * or, when `fill` fits in a byte (0..255), the rectangle is FILLED with
 * that colour instead of copied (-1 copies). A copy within one window runs
 * in the direction that leaves overlapping pixels intact. Returns 0; -1 for
 * a window with no pixels, -2 when a pane lies outside its window, -3 when
 * the two do not overlap.
 * CORRECTION (2026-09-28): this used to copy wherever the source had a
 * pixel and use `fill` only outside it, which the port had inferred from
 * the VFX API; the code fills instead of copying, so the credits' erases
 * (fill 0) leave black, not the screen underneath.
 *
 * @mw2shell vfx_lib_sub_045d9f 0x00045d9f
 * @fidelity exact
 */
export function vfxPaneCopy(source: ViewWindow, sx: number, sy: number, target: ViewWindow, tx: number, ty: number, fill: number): number {
  const sw = source.canvas as VfxWindow;
  if (sw.xMax + 1 <= 0 || sw.yMax + 1 <= 0) return -1;
  // the source pane clipped to its window, relative to the pane
  const s0x = Math.max(source.left, 0) - source.left;
  const s0y = Math.max(source.top, 0) - source.top;
  const s1x = Math.min(source.right, sw.xMax) - source.left;
  const s1y = Math.min(source.bottom, sw.yMax) - source.top;
  if (s1x < s0x || s1y < s0y) return -2;
  const tw = target.canvas as VfxWindow;
  if (tw.xMax + 1 <= 0 || tw.yMax + 1 <= 0) return -1;
  const t0x = Math.max(target.left, 0) - target.left;
  const t0y = Math.max(target.top, 0) - target.top;
  const t1x = Math.min(target.right, tw.xMax) - target.left;
  const t1y = Math.min(target.bottom, tw.yMax) - target.top;
  if (t1x < t0x || t1y < t0y) return -2;
  // the overlap, in source-pane coordinates
  const dx = sx - tx;
  const dy = sy - ty;
  const x0 = Math.max(s0x, t0x + dx);
  const y0 = Math.max(s0y, t0y + dy);
  const x1 = Math.min(s1x, t1x + dx);
  const y1 = Math.min(s1y, t1y + dy);
  if (x1 < x0 || y1 < y0) return -3;
  const w = x1 + 1 - x0;
  const h = y1 + 1 - y0;
  const pitchS = sw.xMax + 1;
  const pitchT = tw.xMax + 1;
  const tx0 = target.left + x0 - dx;
  const ty0 = target.top + y0 - dy;
  if ((fill & ~0xff) === 0) {
    for (let j = 0; j < h; j++) tw.buffer.fill(fill & 0xff, (ty0 + j) * pitchT + tx0, (ty0 + j) * pitchT + tx0 + w);
    return 0;
  }
  const sx0 = source.left + x0;
  const sy0 = source.top + y0;
  // copyWithin/set on a row are memmove-safe; rows run bottom-up when the source starts above the target
  const up = sw === tw && sy0 <= ty0;
  for (let k = 0; k < h; k++) {
    const j = up ? h - 1 - k : k;
    const from = (sy0 + j) * pitchS + sx0;
    if (sw === tw) tw.buffer.copyWithin((ty0 + j) * pitchT + tx0, from, from + w);
    else tw.buffer.set(sw.buffer.subarray(from, from + w), (ty0 + j) * pitchT + tx0);
  }
  return 0;
}

/** A pane over part of a window. */
function subPane(win: VfxWindow, x: number, y: number, w: number, h: number): ViewWindow {
  const p = new ViewWindow();
  p.canvas = win;
  p.left = x;
  p.top = y;
  p.right = x + w - 1;
  p.bottom = y + h - 1;
  return p;
}

/**
 * Draws a line on the screen (VFX_line_draw, mode 0) and marks it dirty.
 *
 * @mw2shell video_driver_sub_03e690 0x0003e690
 * @fidelity exact
 */
export function videoDriverLine(d: VideoDriver, x0: number, y0: number, x1: number, y1: number, colour: number): void {
  vfxLineDraw(d.screenPane, x0, y0, x1, y1, 0, colour);
  dirtyAdd(d, x0, y0, x1, y1);
}

/**
 * Copies a w x h picture (a window of its own - an animation frame) to the
 * screen at (x, y) and marks it dirty.
 *
 * @mw2shell video_driver_sub_03e710 0x0003e710
 * @fidelity exact
 */
export function videoDriverPut(d: VideoDriver, src: VfxWindow, x: number, y: number, w: number, h: number): void {
  vfxPaneCopy(subPane(src, 0, 0, w, h), 0, 0, d.screenPane, x, y, d.fillColour);
  dirtyAdd(d, x, y, x + w - 1, y + h - 1);
}

/** Whether x, y, w, h touches the dirty rectangle. */
function touchesDirty(d: VideoDriver, x: number, y: number, w: number, h: number): boolean {
  return !(d.dirty.right < x || x + w - 1 < d.dirty.left || d.dirty.bottom < y || y + h - 1 < d.dirty.top);
}

/**
 * videoDriverPut, only when the picture touches the dirty rectangle - an
 * unchanged animation frame redrawn only where something was erased.
 *
 * @mw2shell video_driver_sub_03e7c0 0x0003e7c0
 * @fidelity exact
 */
export function videoDriverPutIfDirty(d: VideoDriver, src: VfxWindow, x: number, y: number, w: number, h: number): void {
  if (touchesDirty(d, x, y, w, h)) videoDriverPut(d, src, x, y, w, h);
}

/**
 * Erases x, y, w, h: copies it back from the background and marks it
 * dirty.
 *
 * @mw2shell video_driver_sub_03e9c0 0x0003e9c0
 * @fidelity exact
 */
export function videoDriverErase(d: VideoDriver, x: number, y: number, w: number, h: number): void {
  vfxPaneCopy(subPane(d.background, x, y, w, h), 0, 0, d.screenPane, x, y, d.fillColour);
  dirtyAdd(d, x, y, x + w - 1, y + h - 1);
}

/**
 * Draws shape `n` of a VFX shape table at (x, y) on the screen and marks
 * w x h there dirty.
 *
 * @mw2shell video_driver_sub_03eac0 0x0003eac0
 * @fidelity exact
 */
export function videoDriverShape(d: VideoDriver, shapes: Uint8Array, n: number, x: number, y: number, w: number, h: number): void {
  vfxShapeDraw(d.screenPane, shapes, n, x, y);
  dirtyAdd(d, x, y, x + w - 1, y + h - 1);
}

/**
 * videoDriverShape, only when w x h at (x, y) touches the dirty rectangle.
 *
 * @mw2shell video_driver_sub_03eb30 0x0003eb30
 * @fidelity exact
 */
export function videoDriverShapeIfDirty(d: VideoDriver, shapes: Uint8Array, n: number, x: number, y: number, w: number, h: number): void {
  if (touchesDirty(d, x, y, w, h)) videoDriverShape(d, shapes, n, x, y, w, h);
}

export const drawClip = {
  /** 0xa7e78: set while labels_redraw runs - text wholly outside the dirty rectangle is not drawn */
  keepDirty: 0,
};

/**
 * Draws a string at (x, y) in `font` through `remap` (default: the
 * identity table) and marks it dirty; while labels_redraw runs, text wholly
 * outside the dirty rectangle is skipped. Returns its width.
 *
 * @mw2shell screen_draw_text 0x0003ebe0
 * @fidelity exact
 */
export function screenDrawText(d: VideoDriver, x: number, y: number, font: Uint8Array, text: string | null, remap: Uint8Array | null = null): number {
  if (text === null) return 0;
  let w = 0;
  for (let i = 0; i < text.length; i++) w += vfxCharacterWidth(font, text.charCodeAt(i) & 0xff);
  if (w === 0) return 0;
  const h = vfxFontHeight(font);
  if (drawClip.keepDirty !== 0 && !touchesDirty(d, x, y, w, h)) return w;
  vfxStringDraw(d.screenPane, x, y, font, text, remap ?? identityRemap);
  dirtyAdd(d, x, y, x + w - 1, y + h - 1);
  return w;
}


/**
 * The one-character counterpart for typed labels: draws `ch` at (x, y),
 * marks it dirty, and returns its advance.
 *
 * @mw2shell video_driver_sub_03ed10 0x0003ed10
 * @fidelity exact
 */
export function screenDrawChar(d: VideoDriver, x: number, y: number, font: Uint8Array, ch: number, remap: Uint8Array | null = null): number {
  const w = vfxCharacterWidth(font, ch & 0xff);
  const h = vfxFontHeight(font);
  if (drawClip.keepDirty !== 0 && !touchesDirty(d, x, y, w, h)) return w;
  vfxCharacterDraw(d.screenPane, x, y, font, ch & 0xff, remap ?? identityRemap);
  dirtyAdd(d, x, y, x + w - 1, y + h - 1);
  return w;
}
