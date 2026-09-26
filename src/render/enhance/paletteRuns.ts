/**
 * Which palette neighbours an enhancement may move a colour to.
 *
 * MW2's palettes are laid out in rows of 16, but a row is not always one
 * hue running dark to light: PLUMSCN1's ground row, for one, holds greens
 * and the lakes' teal side by side. Moving the ground "two steps along its
 * ramp" there paints teal blotches - water where there is none - and the
 * dither between the two speckles. So the ground and sky enhancements only
 * move a colour within its RUN: the unbroken stretch of its row whose
 * colours keep its hue (chromaticity within HUE_TOLERANCE of it).
 *
 * @portOnly
 */

/** how far a neighbour's chromaticity (r, g, b over their sum) may stray from the colour's */
const HUE_TOLERANCE = 0.045;

function chroma(rgb: Uint8Array, i: number): [number, number, number] {
  const r = rgb[i * 3]!;
  const g = rgb[i * 3 + 1]!;
  const b = rgb[i * 3 + 2]!;
  const s = r + g + b;
  return s === 0 ? [1 / 3, 1 / 3, 1 / 3] : [r / s, g / s, b / s];
}

export function luminance(rgb: Uint8Array, i: number): number {
  return 0.3 * rgb[i * 3]! + 0.59 * rgb[i * 3 + 1]! + 0.11 * rgb[i * 3 + 2]!;
}

/** Whether index j keeps index i's hue (a near-black keeps any: it has none to lose). */
export function sameHue(rgb: Uint8Array, i: number, j: number): boolean {
  if (luminance(rgb, j) < 4 || luminance(rgb, i) < 4) return luminance(rgb, j) < 8 && luminance(rgb, i) < 8;
  const a = chroma(rgb, i);
  const b = chroma(rgb, j);
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2])) <= HUE_TOLERANCE;
}

/** The run round index i (palette of 6-bit DAC values, 256 x 3): [lo, hi] within its row of 16, every index between keeping its hue. */
export function hueRun(rgb: Uint8Array, i: number): [number, number] {
  let lo = i;
  let hi = i;
  while ((lo & 15) > 0 && sameHue(rgb, i, lo - 1)) lo--;
  while ((hi & 15) < 15 && sameHue(rgb, i, hi + 1)) hi++;
  return [lo, hi];
}
