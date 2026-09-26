/**
 * Screen layout: MW2's own helpers (vfx_font module) that place panes and
 * points. The mission, CPIT and HUD resources lay the screen out in 320x200
 * DESIGN pixels; at start-up layout_rescale_all turns every such table into
 * 16.16 fractions of that design screen (x / 319, y / 199) and then into
 * pixels of the real window (times xMax, yMax, rounded). Panes are
 * ViewWindows; points are two ints.
 */
import type { ViewWindow } from '../../generated/classes.gen.ts';
import { mulr16 } from '../../core/int/fx16.ts';
import { cdiv } from '../../core/int/cint.ts';
import { sdivShl } from '../../core/int/i64.ts';
import type { VfxWindow } from '../../engine/vfx/vfx.ts';
import { vfxLineDraw, vfxShapeBounds } from '../../engine/vfx/vfx.ts';

/**
 * out = pane scaled by the window's size: x0, x1 times xMax, y0, y1 times
 * yMax, 16.16 rounded.
 *
 * @mw2 layout_pane_to_window 0x00013300
 * @fidelity exact
 */
export function layoutPaneToWindow(win: VfxWindow, pane: ViewWindow, out: ViewWindow): ViewWindow {
  const l = mulr16(win.xMax, pane.left);
  const t = mulr16(win.yMax, pane.top);
  const r = mulr16(win.xMax, pane.right);
  const b = mulr16(win.yMax, pane.bottom);
  out.left = l;
  out.top = t;
  out.right = r;
  out.bottom = b;
  return out;
}

/**
 * out = a fraction pane placed inside a parent pane: the parent's width and
 * height (x1 - x0, y1 - y0) times the fractions, 16.16 rounded, plus the
 * parent's x0, y0.
 *
 * @mw2 layout_pane_in_pane 0x00013360
 * @fidelity exact
 */
export function layoutPaneInPane(parent: ViewWindow, pane: ViewWindow, out: ViewWindow): ViewWindow {
  const w = (parent.right - parent.left) | 0;
  const h = (parent.bottom - parent.top) | 0;
  const l = mulr16(pane.left, w);
  const t = mulr16(pane.top, h);
  const r = mulr16(pane.right, w);
  const b = mulr16(pane.bottom, h);
  out.left = (l + parent.left) | 0;
  out.top = (t + parent.top) | 0;
  out.right = (r + parent.left) | 0;
  out.bottom = (b + parent.top) | 0;
  return out;
}

/**
 * A fraction point times the window's xMax, yMax, rounded.
 *
 * @mw2 layout_point_to_window 0x00013460
 * @fidelity exact
 */
export function layoutPointToWindow(win: VfxWindow, p: Int32Array, out: Int32Array, at = 0, outAt = at): Int32Array {
  const x = mulr16(win.xMax, p[at]!);
  const y = mulr16(win.yMax, p[at + 1]!);
  out[outAt] = x;
  out[outAt + 1] = y;
  return out;
}

/**
 * A fraction point times the pane's width (x1 - x0) and height, rounded -
 * relative to the pane, with no origin added.
 *
 * @mw2 layout_point_in_pane 0x00013510
 * @fidelity exact
 */
export function layoutPointInPane(pane: ViewWindow, p: Int32Array, out: Int32Array, at = 0, outAt = at): Int32Array {
  const x = mulr16((pane.right - pane.left) | 0, p[at]!);
  const y = mulr16((pane.bottom - pane.top) | 0, p[at + 1]!);
  out[outAt] = x;
  out[outAt + 1] = y;
  return out;
}

/**
 * A fraction pane back to 320x200 design pixels (x times 319, y times 199,
 * rounded), y further scaled by aspect / 0xd555.
 *
 * @mw2 layout_pane_to_design_aspect 0x00013560
 * @fidelity exact
 */
export function layoutPaneToDesignAspect(pane: ViewWindow, aspect: number): ViewWindow {
  const k = sdivShl(aspect, 16, 0xd555);
  pane.left = mulr16(pane.left, 0x13f);
  pane.top = mulr16(mulr16(pane.top, 199), k);
  pane.right = mulr16(pane.right, 0x13f);
  pane.bottom = mulr16(mulr16(pane.bottom, 199), k);
  return pane;
}

/**
 * A design-pixel pane to 16.16 fractions: (x << 16) / 319, (y << 16) / 199.
 *
 * @mw2 layout_pane_to_fraction 0x000135f0
 * @fidelity exact
 */
export function layoutPaneToFraction(pane: ViewWindow, out: ViewWindow): ViewWindow {
  const l = sdivShl(pane.left, 16, 0x13f);
  const t = sdivShl(pane.top, 16, 199);
  const r = sdivShl(pane.right, 16, 0x13f);
  const b = sdivShl(pane.bottom, 16, 199);
  out.left = l;
  out.top = t;
  out.right = r;
  out.bottom = b;
  return out;
}

/**
 * @mw2 layout_point_to_fraction 0x000136d0
 * @fidelity exact
 */
export function layoutPointToFraction(p: Int32Array, out: Int32Array, at = 0, outAt = at): Int32Array {
  const x = sdivShl(p[at]!, 16, 0x13f);
  const y = sdivShl(p[at + 1]!, 16, 199);
  out[outAt] = x;
  out[outAt + 1] = y;
  return out;
}

/**
 * out = the pane's size centred in the window.
 *
 * @mw2 layout_pane_centre_in_window 0x00013710
 * @fidelity exact
 */
export function layoutPaneCentreInWindow(win: VfxWindow, pane: ViewWindow, out: ViewWindow): ViewWindow {
  const w = (pane.right - pane.left) | 0;
  const h = (pane.bottom - pane.top) | 0;
  const x = cdiv((win.xMax - (w + 1) - 1) | 0, 2);
  const y = cdiv((win.yMax - (h + 1) - 1) | 0, 2);
  out.left = x;
  out.top = y;
  out.right = (w + x) | 0;
  out.bottom = (h + y) | 0;
  return out;
}

/**
 * out = the pane scaled about its centre: centre = left + (right - left + 1)
 * >> 1 (and the same for y), each edge's offset from it times scaleX or
 * scaleY (16.16, rounded), the centre added back.
 *
 * @mw2 layout_pane_scale_about_centre 0x000137a0
 * @fidelity exact
 */
export function layoutPaneScaleAboutCentre(pane: ViewWindow, out: ViewWindow, scaleX: number, scaleY: number): ViewWindow {
  const cx = ((((pane.right - pane.left + 1) | 0) >> 1) + pane.left) | 0;
  const cy = (pane.top + (((pane.bottom - pane.top + 1) | 0) >> 1)) | 0;
  const l = (pane.left - cx) | 0;
  const t = (pane.top - cy) | 0;
  const r = (pane.right - cx) | 0;
  const b = (pane.bottom - cy) | 0;
  out.left = (mulr16(l, scaleX) + cx) | 0;
  out.top = (mulr16(t, scaleY) + cy) | 0;
  out.right = (mulr16(r, scaleX) + cx) | 0;
  out.bottom = (mulr16(b, scaleY) + cy) | 0;
  return out;
}

/**
 * out = the pane shrunk (or grown) about its centre to a shape's own size:
 * vfx_shape_bounds' high word (the width) over the pane's width, its low
 * word (the height) over the pane's height, each 16.16 by idiv.
 *
 * @mw2 layout_pane_fit_shape 0x00013860
 * @fidelity exact
 */
export function layoutPaneFitShape(pane: ViewWindow, out: ViewWindow, table: Uint8Array, shapeNumber: number): ViewWindow {
  const bounds = vfxShapeBounds(table, shapeNumber);
  const h = bounds & 0xffff;
  const w = bounds >> 16;
  const sx = sdivShl(w, 16, (pane.right - pane.left + 1) | 0);
  const sy = sdivShl(h, 16, (pane.bottom - pane.top + 1) | 0);
  return layoutPaneScaleAboutCentre(pane, out, sx, sy);
}

/**
 * Outlines a pane: four mode-0 lines along its edges.
 *
 * @mw2 vfx_pane_frame 0x00013960
 * @fidelity exact
 */
export function vfxPaneFrame(pane: ViewWindow, colour: number): void {
  const x1 = (pane.right - pane.left) | 0;
  const y1 = (pane.bottom - pane.top) | 0;
  vfxLineDraw(pane, 0, 0, x1, 0, 0, colour);
  vfxLineDraw(pane, x1, 0, x1, y1, 0, colour);
  vfxLineDraw(pane, x1, y1, 0, y1, 0, colour);
  vfxLineDraw(pane, 0, y1, 0, 0, 0, colour);
}

/**
 * Where the ray from the pane's centre through p meets the pane's edge,
 * for a point off screen - the target markers pin themselves there.
 * Relative to the pane: the centre is half the width and height, the
 * direction is (centre - p), and vfx_font_sub_014240 picks the edge from
 * the signs and the slope.
 *
 * @mw2 vfx_font_sub_014020 0x00014020
 * @fidelity exact
 */
export function vfxFontSub014020(pane: ViewWindow, p: Int32Array, out: Int32Array): Int32Array {
  const half = new Int32Array(2);
  half[0] = ((pane.right - pane.left + 1) | 0) >> 1;
  half[1] = ((pane.bottom - pane.top + 1) | 0) >> 1;
  const dx = (half[0]! - p[0]!) | 0;
  let flags = dx >= 0 ? 1 : 0;
  const dy = (half[1]! - p[1]!) | 0;
  if (dy >= 0) flags |= 2;
  let steep: number;
  if (dx === 0) steep = 1;
  else {
    const q = cdiv(dy, dx);
    steep = q > 0x7fff || q < -0x8000 ? 1 : 0;
  }
  const slope = steep === 0 ? sdivShl(dy, 16, dx) : 0;
  flags |= steep * 4;
  vfxFontSub014240(half, flags, slope, out);
  return out;
}

/**
 * The edge crossing for vfx_font_sub_014020: half is the pane's half-size
 * {hx, hy}; flags bit 0 = the point is left of the centre (dx >= 0), bit 1
 * above (dy >= 0), bit 2 = the slope is too steep to hold; slope is dy / dx,
 * 16.16. Writes the crossing, pane-relative, to out.
 *
 * @mw2 vfx_font_sub_014240 0x00014240
 * @fidelity exact
 */
export function vfxFontSub014240(half: Int32Array, flags: number, slope: number, out: Int32Array): Int32Array {
  const hx = half[0]!;
  const hy = half[1]!;
  const fullY = (hy * 2) | 0;
  const diag = hx === 0 ? 0 : sdivShl(hy, 16, hx);
  const xAt = (): number => sdivShl(hy, 16, slope);
  const yAt = (): number => mulr16(hx, slope);
  switch (flags) {
    case 0:
      if (diag < slope) {
        out[0] = (hx + xAt()) | 0;
        out[1] = fullY;
        return out;
      }
      break;
    case 1:
      if ((slope | 0) < (-diag | 0)) {
        out[0] = (hx + xAt()) | 0;
        out[1] = fullY;
        return out;
      }
      out[0] = 0;
      out[1] = (hy - yAt()) | 0;
      return out;
    case 2:
      if ((slope | 0) < (-diag | 0)) {
        out[0] = (hx - xAt()) | 0;
        out[1] = 0;
        return out;
      }
      break;
    case 3:
      if (slope <= diag) {
        out[0] = 0;
        out[1] = (hy - yAt()) | 0;
        return out;
      }
      out[0] = (hx - xAt()) | 0;
      out[1] = 0;
      return out;
    case 5:
      out[0] = hx;
      out[1] = fullY;
      return out;
    case 7:
      out[0] = hx;
      out[1] = 0;
      return out;
    default:
      out[0] = 0;
      out[1] = 0;
      return out;
  }
  // cases 0 and 2 past their test: the right edge
  out[0] = (hx * 2) | 0;
  out[1] = (hy + yAt()) | 0;
  return out;
}
