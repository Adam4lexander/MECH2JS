/**
 * The Miles VFX library's 2D drawing, as MW2.EXE links it (vfx_lib): the
 * HUD, the cockpit text and the radar draw through these into the VFX window
 * main's frame loop presents.
 *
 * A WINDOW is {buffer, xMax, yMax} (+0, +4, +8: every routine takes xMax + 1
 * and yMax + 1 as the width and height, and gives up with -1 when either is
 * not positive). A PANE is a ViewWindow {window, x0, y0, x1, y1}, inclusive;
 * every routine clips to the pane intersected with its window - x0 and y0
 * floored at 0, x1 and y1 capped at xMax and yMax - and gives up with -2 when
 * that is empty. Coordinates given to a routine are relative to the pane's
 * RAW x0 and y0 (not the clamped ones).
 *
 * The port's window carries, beside the pixels, a mask of the pixels written
 * since the frame was last cleared, because the 3D view underneath is drawn
 * by the GPU rather than into the same buffer (see vfxWindowClear).
 */
import { ViewWindow } from '../../generated/classes.gen.ts';
import { unestablished } from '../../core/provenance.ts';

/** A VFX window. @portOnly the layout of the original's {buffer, xMax, yMax} */
export class VfxWindow {
  /** +0: the pixels, palette indices, row-major, width = xMax + 1 */
  buffer: Uint8Array = new Uint8Array(0);
  /** @portOnly 1 where a pixel has been written since vfxWindowClear */
  drawn: Uint8Array = new Uint8Array(0);
  /** +4 */
  xMax = -1;
  /** +8 */
  yMax = -1;
}

/** Gives a window a buffer of width x height. @portOnly video_init allocates it */
export function vfxWindowAllocate(w: VfxWindow, width: number, height: number): void {
  w.buffer = new Uint8Array(width * height);
  w.drawn = new Uint8Array(width * height);
  w.xMax = width - 1;
  w.yMax = height - 1;
}

/**
 * Forgets what the 2D code drew: the frame's 3D render covers the whole
 * window in the original, so nothing drawn before it survives into the
 * frame. @portOnly
 */
export function vfxWindowClear(w: VfxWindow): void {
  w.drawn.fill(0);
}

/** The pane's clip rectangle in window pixels, or the -1 / -2 every routine returns. */
interface Clip {
  win: VfxWindow;
  pitch: number;
  /** the pane's raw x0, y0: what coordinates are relative to */
  ox: number;
  oy: number;
  cl: number;
  ct: number;
  cr: number;
  cb: number;
}

const clip: Clip = { win: new VfxWindow(), pitch: 0, ox: 0, oy: 0, cl: 0, ct: 0, cr: 0, cb: 0 };

/** The prologue every VFX routine shares (e.g. 0x5436c..0x543d9 in vfx_shape_draw). */
function paneClip(pane: ViewWindow): number {
  const win = pane.canvas as VfxWindow | null;
  if (!win) return -1;
  const width = win.xMax + 1;
  const height = win.yMax + 1;
  if (width <= 0 || height <= 0) return -1;
  clip.win = win;
  clip.pitch = width;
  clip.ox = pane.left;
  clip.oy = pane.top;
  clip.cl = pane.left > 0 ? pane.left : 0;
  clip.ct = pane.top > 0 ? pane.top : 0;
  clip.cr = pane.right < width - 1 ? pane.right : width - 1;
  clip.cb = pane.bottom < height - 1 ? pane.bottom : height - 1;
  if (clip.cr < clip.cl || clip.cb < clip.ct) return -2;
  return 0;
}

function put(win: VfxWindow, at: number, c: number): void {
  win.buffer[at] = c;
  win.drawn[at] = 1;
}

const u32 = (b: Uint8Array, o: number): number => (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;
const i32 = (b: Uint8Array, o: number): number => b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24);

/** Offset of shape n in a table: table + [table + 8 + n * 8]. */
const shapeAt = (t: Uint8Array, n: number): number => u32(t, 8 + n * 8);

/**
 * Decodes shape n with its origin at window (x, y), writing only inside the
 * clip rectangle; remap, when given, replaces every pixel. The token stream is
 * decompiled/tools/dump_shapes.py's.
 */
function shapeBlit(t: Uint8Array, n: number, x: number, y: number, remap: Uint8Array | null): void {
  const s = shapeAt(t, n);
  const x0 = x + i32(t, s + 8);
  const y0 = y + i32(t, s + 0xc);
  const y1 = y + i32(t, s + 0x14);
  const { win, pitch, cl, ct, cr, cb } = clip;
  let p = s + 0x18;
  for (let row = y0; row <= y1; row++) {
    if (row > cb) return;
    let cx = x0;
    const draw = row >= ct;
    const base = row * pitch;
    for (;;) {
      const tok = t[p++]!;
      if (tok === 0) break;
      if (tok === 1) {
        cx += t[p++]!;
        continue;
      }
      const count = tok >> 1;
      const run = (tok & 1) === 0;
      if (draw) {
        for (let i = 0; i < count; i++) {
          const px = cx + i;
          if (px < cl || px > cr) continue;
          const c = run ? t[p]! : t[p + i]!;
          put(win, base + px, remap ? remap[c]! : c);
        }
      }
      p += run ? 1 : count;
      cx += count;
    }
  }
}

/** The rectangle test vfx_shape_draw makes (0x54438..0x544af): 0 inside, 1 partly, -3 outside, -4 an empty rectangle. */
function shapePlacement(t: Uint8Array, n: number, x: number, y: number): number {
  const s = shapeAt(t, n);
  const x0 = x + i32(t, s + 8);
  const y0 = y + i32(t, s + 0xc);
  const x1 = x + i32(t, s + 0x10);
  const y1 = y + i32(t, s + 0x14);
  if (x1 < x0 || y1 < y0) return -4; // jl 0x54755
  const { cl, ct, cr, cb } = clip;
  if (x1 < cl || x0 > cr || y1 < ct || y0 > cb) return -3;
  return x0 >= cl && x1 <= cr && y0 >= ct && y1 <= cb ? 0 : 1;
}

/**
 * Draws shape shapeNumber of an SHP table at (x, y) in a pane. Returns 0, -1
 * for an empty window, -2 for an empty pane, -3 when the shape lies wholly
 * outside, -4 when its own rectangle is empty.
 *
 * @mw2 vfx_shape_draw 0x0005435c
 * @fidelity exact
 */
export function vfxShapeDraw(pane: ViewWindow, table: Uint8Array, shapeNumber: number, x: number, y: number): number {
  const r = paneClip(pane);
  if (r) return r;
  x = (x + clip.ox) | 0;
  y = (y + clip.oy) | 0;
  const where = shapePlacement(table, shapeNumber, x, y);
  if (where < 0) return where;
  if (where === 0) return vfxShapeDrawUnclipped(table, shapeNumber, x, y);
  shapeBlit(table, shapeNumber, x, y, null);
  return 0;
}

/**
 * vfx_shape_draw's path for a shape wholly inside the clip rectangle.
 *
 * @mw2 vfx_shape_draw_unclipped 0x00054760
 * @fidelity exact
 * @divergence takes window coordinates and the clip vfx_shape_draw has set up, not (pane, shape, x, y, pitch)
 */
export function vfxShapeDrawUnclipped(table: Uint8Array, shapeNumber: number, x: number, y: number): number {
  shapeBlit(table, shapeNumber, x, y, null);
  return 0;
}

/** 0xa15d8: the 256-byte table vfx_shape_remap_draw applies */
export const shapeRemap = new Uint8Array(256);

/**
 * @mw2 vfx_shape_remap_set 0x00054827
 * @fidelity exact
 */
export function vfxShapeRemapSet(table: Uint8Array): void {
  shapeRemap.set(table.subarray(0, 256));
}

/**
 * vfx_shape_draw with every pixel replaced by shapeRemap[pixel].
 *
 * @mw2 vfx_shape_remap_draw 0x00054846
 * @fidelity exact
 */
export function vfxShapeRemapDraw(pane: ViewWindow, table: Uint8Array, shapeNumber: number, x: number, y: number): number {
  const r = paneClip(pane);
  if (r) return r;
  x = (x + clip.ox) | 0;
  y = (y + clip.oy) | 0;
  const where = shapePlacement(table, shapeNumber, x, y);
  if (where < 0) return where;
  if (where === 0) return vfxShapeRemapDrawUnclipped(table, shapeNumber, x, y);
  shapeBlit(table, shapeNumber, x, y, shapeRemap);
  return 0;
}

/**
 * @mw2 vfx_shape_remap_draw_unclipped 0x00054d1e
 * @fidelity exact
 * @divergence takes window coordinates and the clip vfx_shape_remap_draw has set up
 */
export function vfxShapeRemapDrawUnclipped(table: Uint8Array, shapeNumber: number, x: number, y: number): number {
  shapeBlit(table, shapeNumber, x, y, shapeRemap);
  return 0;
}

/**
 * @mw2 vfx_shape_count 0x00058a43
 * @fidelity exact
 */
export function vfxShapeCount(table: Uint8Array): number {
  return i32(table, 4);
}

/**
 * Width << 16 | height of shape n.
 *
 * @mw2 vfx_shape_size 0x00058908
 * @fidelity exact
 */
export function vfxShapeSize(table: Uint8Array, n: number): number {
  const s = shapeAt(table, n);
  const w = (i32(table, s + 0x10) - i32(table, s + 8) + 1) | 0;
  const h = (i32(table, s + 0x14) - i32(table, s + 0xc) + 1) | 0;
  return ((w << 16) | (h & 0xffff)) | 0;
}

/**
 * Shape n's +4 dword.
 *
 * @mw2 vfx_shape_origin 0x000588e5
 * @fidelity exact
 */
export function vfxShapeOrigin(table: Uint8Array, n: number): number {
  return i32(table, shapeAt(table, n) + 4);
}

/**
 * Shape n's +0 dword.
 *
 * @mw2 vfx_shape_bounds 0x000588c3
 * @fidelity exact
 */
export function vfxShapeBounds(table: Uint8Array, n: number): number {
  return i32(table, shapeAt(table, n));
}

/**
 * Fills the pane, clipped to its window, with one colour. Returns 0, -1 or -2.
 *
 * @mw2 vfx_pane_wipe 0x000561f0
 * @fidelity exact
 */
export function vfxPaneWipe(pane: ViewWindow, colour: number): number {
  const r = paneClip(pane);
  if (r) return r;
  const { win, pitch, cl, ct, cr, cb } = clip;
  for (let y = ct; y <= cb; y++) for (let x = cl; x <= cr; x++) put(win, y * pitch + x, colour & 0xff);
  return 0;
}

/** Cohen-Sutherland outcode against the clip rectangle. */
function outcode(x: number, y: number): number {
  let c = 0;
  if (x < clip.cl) c |= 1;
  if (x > clip.cr) c |= 2;
  if (y < clip.ct) c |= 4;
  if (y > clip.cb) c |= 8;
  return c;
}

function linePixel(x: number, y: number, mode: number, colour: number | Uint8Array): void {
  const at = y * clip.pitch + x;
  if (mode === 0) put(clip.win, at, (colour as number) & 0xff);
  else put(clip.win, at, (colour as Uint8Array)[clip.win.buffer[at]!]!);
}

/**
 * Draws a line between two pane-relative points. mode 0 writes colour; mode 1
 * remaps each pixel it covers through the table colour is; above 1 the
 * original calls colour as a function per pixel, which no caller ported so
 * far uses.
 *
 * The original clips Cohen-Sutherland style, taking the minor coordinate as
 * floor((j * slope + 2^31) / 2^32) at major step j from the unclipped start,
 * slope = (minor << 32) / major (0xffffffff when they are equal); the clipper's
 * crossings are the exact ceilings of that formula (cmp edx,1 / sbb eax,-1
 * and sbb eax,0 after its divisions), so the pixels drawn are exactly those
 * of the unclipped line inside the rectangle - which is how the port draws
 * them. Returns 0 drawn with no clipping, 1 drawn after clipping, 2 nothing
 * inside, -1 / -2 for an empty window / pane.
 *
 * @mw2 vfx_line_draw 0x00053821
 * @fidelity partial
 * @divergence a vertical or horizontal line that is drawn returns 0: the original returns the uninitialised local at [ebp-0x34] tested >= 1 there (its paths at 0x54037 / 0x540c2 skip the store at 0x5393f); mode above 1 (a callback) is not ported
 */
export function vfxLineDraw(pane: ViewWindow, x0: number, y0: number, x1: number, y1: number, mode: number, colour: number | Uint8Array): number {
  const r = paneClip(pane);
  if (r) return r;
  if (mode > 1) {
    unestablished('vfx_line_draw: a callback mode (above 1) is not ported', 'vfx_line_draw');
    return 2;
  }
  x0 = (x0 + clip.ox) | 0;
  x1 = (x1 + clip.ox) | 0;
  y0 = (y0 + clip.oy) | 0;
  y1 = (y1 + clip.oy) | 0;
  const { cl, ct, cr, cb } = clip;
  const dx = x1 - x0;
  const dy = y1 - y0;
  if (dx === 0) {
    // 0x54037: a vertical line (or a point), clamped
    if (x0 < cl || x0 > cr) return 2;
    if (Math.max(y0, y1) < ct || Math.min(y0, y1) > cb) return 2;
    const a = Math.min(Math.max(y0, ct), cb);
    const b = Math.min(Math.max(y1, ct), cb);
    for (let y = Math.min(a, b); y <= Math.max(a, b); y++) linePixel(x0, y, mode, colour);
    return 0;
  }
  if (dy === 0) {
    // 0x540c2: a horizontal line, clamped
    if (y0 < ct || y0 > cb) return 2;
    if (Math.max(x0, x1) < cl || Math.min(x0, x1) > cr) return 2;
    const a = Math.min(Math.max(x0, cl), cr);
    const b = Math.min(Math.max(x1, cl), cr);
    for (let x = Math.min(a, b); x <= Math.max(a, b); x++) linePixel(x, y0, mode, colour);
    return 0;
  }
  const c0 = outcode(x0, y0);
  const c1 = outcode(x1, y1);
  if (c0 & c1) return 2;
  const adx = Math.abs(dx);
  const ady = Math.abs(dy);
  const sx = dx < 0 ? -1 : 1;
  const sy = dy < 0 ? -1 : 1;
  const major = Math.max(adx, ady);
  const minor = Math.min(adx, ady);
  const slope = adx === ady ? 0xffffffff : Math.floor((minor * 4294967296) / major);
  let any = false;
  for (let j = 0; j <= major; j++) {
    const m = Math.floor((j * slope + 2147483648) / 4294967296);
    const x = adx >= ady ? x0 + sx * j : x0 + sx * m;
    const y = adx >= ady ? y0 + sy * m : y0 + sy * j;
    if (x < cl || x > cr || y < ct || y > cb) continue;
    linePixel(x, y, mode, colour);
    any = true;
  }
  if (!any) return 2;
  return c0 | c1 ? 1 : 0;
}

/**
 * The glyph height: the dword at font + 8.
 *
 * @mw2 vfx_font_height 0x00057e60
 * @fidelity exact
 */
export function vfxFontHeight(font: Uint8Array): number {
  return i32(font, 8);
}

/**
 * Glyph ch's width.
 *
 * @mw2 vfx_character_width 0x00057e73
 * @fidelity exact
 */
export function vfxCharacterWidth(font: Uint8Array, ch: number): number {
  return i32(font, u32(font, 0x10 + ch * 4));
}

/**
 * Draws glyph ch at pane-relative (x, y). With a colour table each glyph byte
 * is mapped through it and a result of 0xff is not written; without one the
 * rows are copied as they are. Returns the glyph's width (the x advance),
 * clipped or not; -1 / -2 for an empty window / pane.
 *
 * @mw2 vfx_character_draw 0x00057e93
 * @fidelity exact
 */
export function vfxCharacterDraw(pane: ViewWindow, x: number, y: number, font: Uint8Array, ch: number, colourTable: Uint8Array | null): number {
  const r = paneClip(pane);
  if (r) return r;
  x = (x + clip.ox) | 0;
  y = (y + clip.oy) | 0;
  const height = i32(font, 8);
  let src = u32(font, 0x10 + (ch & 0xff) * 4);
  const width = i32(font, src);
  if (width === 0) return 0;
  src += 4;
  const { win, pitch, cl, ct, cr, cb } = clip;
  let cols = width;
  let e = cr + 1 - cols - x;
  if (e < 0) {
    cols += e;
    if (cols <= 0) return width;
  }
  e = x - cl;
  if (e < 0) {
    cols += e;
    if (cols <= 0) return width;
    src -= e;
    x -= e;
  }
  let rows = height;
  e = cb + 1 - rows - y;
  if (e < 0) {
    rows += e;
    if (rows <= 0) return width;
  }
  e = y - ct;
  if (e < 0) {
    rows += e;
    if (rows <= 0) return width;
    y -= e;
    src -= e * width;
  }
  for (let row = 0; row < rows; row++) {
    const d = (y + row) * pitch + x;
    const s = src + row * width;
    for (let i = 0; i < cols; i++) {
      const b = font[s + i]!;
      if (colourTable) {
        const c = colourTable[b]!;
        if (c !== 0xff) put(win, d + i, c);
      } else put(win, d + i, b);
    }
  }
  return width;
}

/**
 * Draws a NUL-terminated string, each character's advance added to x.
 *
 * @mw2 vfx_string_draw 0x00058026
 * @fidelity exact
 */
export function vfxStringDraw(pane: ViewWindow, x: number, y: number, font: Uint8Array, text: string, colourTable: Uint8Array | null): void {
  // do { ... } while (*++s): the first character is drawn even when it is the NUL
  let i = 0;
  do {
    const ch = i < text.length ? text.charCodeAt(i) & 0xff : 0;
    x = (x + vfxCharacterDraw(pane, x, y, font, ch, colourTable)) | 0;
    i++;
  } while (i < text.length);
}

/**
 * Forgets what was drawn inside a pane's rectangle (clipped to its window) -
 * what the frame's 3D render does to the window in the original, which
 * paints its viewport and leaves the rest of the screen as it was. @portOnly
 */
export function vfxWindowClearPane(pane: ViewWindow): void {
  if (paneClip(pane)) return;
  const { win, pitch, cl, ct, cr, cb } = clip;
  for (let y = ct; y <= cb; y++) win.drawn.fill(0, y * pitch + cl, y * pitch + cr + 1);
}
