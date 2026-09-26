/**
 * What a queued polygon turns into on screen: poly_fill_dispatch and the two
 * fillers it hands polygons to (polygonFillHook) - render_asm_sub_03bb80,
 * the main views' filler, and map_fill_polygon, the overhead map's. The
 * original fills pixels; the port reduces each polygon to at most one fill
 * (a draw word for the indexed material, with how its vertices are read)
 * and one outline (a palette index for a line loop through its vertices),
 * which SceneRenderer hands the GPU.
 *
 * Painter's order within one polygon is kept by drawing its fill before its
 * outline (the fill material is pushed back in depth). When a polygon is
 * filled twice - black, then again - the second fill is what shows, as the
 * second covers the same pixels; a texel the second skips (0xff) would show
 * the first there, which is not reproduced.
 */
import { renderOptions, HOOK } from '../../sim/display/renderState.ts';
import { unestablished } from '../../core/provenance.ts';

/** How the fill's vertices are read (SceneRenderer / the indexed material). */
export const FillKind = {
  /** the draw word, as render_asm_sub_03bb80 fills it */
  ByMode: 0,
  /** map_fill_polygon's mode 0x4000: each vertex's own palette index from its height (mapVertexIndex) */
  MapHeight: 1,
  /** map_fill_polygon's mode 0x3000: render_asm_sub_03b990 with its last argument 1 - an upright square on the sprite's ground point */
  MapSprite: 2,
} as const;
export type FillKind = (typeof FillKind)[keyof typeof FillKind];

export interface PolyDraw {
  /** the fill's draw word, or -1 for none */
  fill: number;
  kind: FillKind;
  /** the outline's palette index, or -1 for none */
  outline: number;
}

/** render_asm_sub_03bb80 with `word`: mode 0x2000 is a line loop in word & 0xff; every other mode fills. */
function fillByMode(word: number, out: PolyDraw): void {
  if ((word & 0x7000) === 0x2000) out.outline = word & 0xff;
  else {
    out.fill = word;
    out.kind = FillKind.ByMode;
  }
}

/**
 * map_fill_polygon with `word`: mode 0 is filled with word 0 (black) and
 * then outlined in word | 0x2000; mode 0x3000 is the map's sprite square
 * (slot (word & 0xff0) >> 4, no shade); mode 0x4000 the height-shaded fill
 * (per-vertex indices, the per-vertex-shade filler while shadedFillEnabled,
 * else the flat filler); every other mode goes to render_asm_sub_03bb80.
 *
 * @mw2 map_fill_polygon 0x00012690
 * @fidelity partial
 * @divergence the pixels are the GPU's (SceneRenderer); with shadedFillEnabled clear the flat filler 0x59180 would fill from one vertex's index, where the port drops the dither and interpolates (as for mode 0x4000 elsewhere); the vertex loop writes the indices through mapVertexIndex; returns nothing when the current radar mode has no record, as the original does
 */
export function mapFillPolygon(word: number, out: PolyDraw): void {
  const mode = word & 0x7000;
  if (mode === 0) {
    fillByMode(0, out);
    fillByMode(word | 0x2000, out);
  } else if (mode === 0x3000) {
    out.fill = word;
    out.kind = FillKind.MapSprite;
  } else if (mode === 0x4000) {
    out.fill = word;
    out.kind = FillKind.MapHeight;
  } else fillByMode(word, out);
}

function fillHook(word: number, out: PolyDraw): void {
  const h = renderOptions.polygonFillHook;
  if (h === HOOK.mapFillPolygon) mapFillPolygon(word, out);
  else {
    if (h !== HOOK.polyFillByMode) unestablished(`polygonFillHook 0x${h.toString(16)} is not ported; render_asm_sub_03bb80 used`, 'poly_fill_dispatch');
    fillByMode(word, out);
  }
}

/**
 * A queued polygon of `count` vertices with colour word `word`: while
 * wireframeMode is set the word gets 0x2000 (an outline), and with
 * wireframeMode 1 the polygon is first filled with word 0 - black - so the
 * outlines behind it are hidden; then polygonFillHook.
 *
 * @mw2 poly_fill_dispatch 0x0003ccf0
 * @fidelity partial
 * @divergence 1- and 2-vertex polygons (points while 0x97038 is set, vfx_line_draw lines while 0x97034 is set, else the filler) are not drawn: SceneRenderer builds no geometry for them
 */
export function polyFillDispatch(count: number, word: number, out: PolyDraw): PolyDraw {
  out.fill = -1;
  out.kind = FillKind.ByMode;
  out.outline = -1;
  if (count < 3) return out;
  let w = word;
  const wf = renderOptions.wireframeMode;
  if (wf !== 0) {
    w |= 0x2000;
    if (wf === 1) fillHook(0, out);
  }
  fillHook(w, out);
  return out;
}
