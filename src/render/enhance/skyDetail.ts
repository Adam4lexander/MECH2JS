/**
 * The sky enhancement, shared by the screen's sky pass (passes/skyGround.ts)
 * and the headset's sky sphere (xr/xrSky.ts).
 *
 * The original fills the sky with one index (skyColour) over a dithered
 * haze band. Above the band this continues the same way up the sky's own
 * ramp: from skyColour at the horizon to up to three shade steps along the
 * ramp at the zenith - towards the darker end, the sky deepening overhead -
 * with the band's dither (the 16.16 value plus 0x7fff or -0x8000 on
 * alternate pixels) - within the sky colour's hue run (paletteRuns.ts), as a
 * row of the palette may hold other colours. At night (the sky colour dark)
 * there are stars: sparse
 * single dots in the palette's brightest grey, fixed to world directions.
 *
 * The indices are chosen from the palette on the CPU (skyPaletteChoice), so
 * a mission's dusk and night palettes pick their own.
 *
 * @portOnly
 */

/**
 * GLSL: the uniforms, skyStarRadius(dir) - which takes derivatives, so the
 * caller computes it for every fragment, outside any branch - and
 * skyDetail(dir, idx, px, starRadius): the sky index for a world direction
 * above the band.
 */
export const SKY_DETAIL_GLSL = /* glsl */ `
uniform int uSkyEnh;     // the enhancement is on
uniform int uSkyTop;     // the index at the zenith
uniform int uStar;       // the stars' index; < 0: no stars
float skyHash3(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
const float STAR_GRID = 160.0;
float skyStarRadius(vec3 dir) {
  vec3 w = fwidth(dir * STAR_GRID);
  return max(max(w.x, w.y), w.z) * 0.7;
}
int skyDetail(vec3 dir, int sky, ivec2 px, float starRadius) {
  float t = clamp(dir.y / 0.85, 0.0, 1.0);
  int v = int(floor(float(sky << 16) + t * float((uSkyTop - sky) << 16) + 0.5));
  bool upStep = ((px.x + px.y) & 1) == 1;
  int idx = (v + 0x8000 + (upStep ? 0x7fff : -0x8000)) >> 16;
  if (uStar >= 0 && dir.y > 0.08) {
    vec3 p = dir * STAR_GRID;
    vec3 c = floor(p);
    if (skyHash3(c) < 0.012) {
      vec3 at = c + 0.2 + 0.6 * vec3(skyHash3(c + 1.7), skyHash3(c + 3.1), skyHash3(c + 5.3));
      if (length(p - at) < starRadius) idx = uStar;
    }
  }
  return idx;
}
`;

import { hueRun } from './paletteRuns.ts';

export interface SkyChoice {
  top: number;
  /** -1: no stars */
  star: number;
}

const lum = (rgb: Uint8Array, i: number) => 0.3 * rgb[i * 3]! + 0.59 * rgb[i * 3 + 1]! + 0.11 * rgb[i * 3 + 2]!;

/**
 * The zenith index and the stars' index for a palette (6-bit DAC values,
 * 256 x 3) and its sky colour: the zenith up to three steps along the sky's
 * ramp towards its darker end; stars when the sky is dark (luminance under
 * 12 of 63), in the brightest near-grey index.
 */
export function skyPaletteChoice(rgb: Uint8Array, sky: number): SkyChoice {
  const [lo, hi] = hueRun(rgb, sky);
  const down = sky > lo ? lum(rgb, sky - 1) : Infinity;
  const up = sky < hi ? lum(rgb, sky + 1) : Infinity;
  const dir = down <= up ? -1 : 1;
  let top = sky;
  for (let s = 1; s <= 3; s++) {
    const i = sky + dir * s;
    if (i < lo || i > hi) break;
    top = i;
  }
  let star = -1;
  if (lum(rgb, sky) < 12) {
    let best = -1;
    for (let i = 1; i < 255; i++) {
      const r = rgb[i * 3]!;
      const g = rgb[i * 3 + 1]!;
      const b = rgb[i * 3 + 2]!;
      const grey = Math.max(r, g, b) - Math.min(r, g, b) < 10;
      if (grey && (best < 0 || lum(rgb, i) > lum(rgb, best))) best = i;
    }
    if (best >= 0 && lum(rgb, best) > 40) star = best;
  }
  return { top, star };
}
