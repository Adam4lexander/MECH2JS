/**
 * Which palette neighbours an enhancement may move a colour to.
 *
 * MW2's palettes are laid out in rows of 16, but a row is not always one
 * hue running dark to light: PLUMSCN1's ground row, for one, holds greens
 * and the lakes' teal side by side. Moving the ground "two steps along its
 * ramp" there paints teal blotches - water where there is none - and the
 * dither between the two speckles. So the sky enhancement only moves a
 * colour within its RUN: the unbroken stretch of its row whose colours keep
 * its hue (chromaticity within HUE_TOLERANCE of it). The ground's shades
 * come from the whole palette instead (groundShades, below).
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

/** the brightness of each ground shade, of the ground colour's: two darker, the colour, two lighter */
export const GROUND_STEPS = [0.8, 0.9, 1, 1.1, 1.2] as const;
/** how far (6-bit DAC units, per channel) a palette colour may lie from a shade's target and stand for it */
const SHADE_TOLERANCE = 2;

/**
 * The ground enhancement's five shades of palette index `g`: for each of
 * GROUND_STEPS, the palette colour nearest `g`'s colour at that brightness -
 * searched over the whole palette, since `g`'s row is not its ramp (every
 * mission's ground is 0xef, the last of its row, and in most palettes the
 * row's other colours are other hues or the same colour) - taken only if
 * every channel lies within SHADE_TOLERANCE of the target (which keeps the
 * hue: a near-black of another hue is several units off), it is not `g`'s
 * colour, and it lies on the right side of it. A step with no such colour
 * takes the one nearer the middle, so the five run dark to light and a
 * palette without shades of the ground leaves it flat. (The first cut moved
 * the index along its row, within hueRun: in 40 of the 59 missions that gave
 * nothing, and in some - near-blacks passing the hue test - blue on brown.)
 */
export function groundShades(rgb: Uint8Array, g: number): number[] {
  const c = [rgb[g * 3]!, rgb[g * 3 + 1]!, rgb[g * 3 + 2]!];
  const lg = luminance(rgb, g);
  const pick = (k: number): number | null => {
    const t = c.map((v) => Math.min(63, v * k));
    let best: number | null = null;
    let bestD = Infinity;
    for (let j = 0; j < 256; j++) {
      if (j === 0xff) continue;
      const d = Math.max(...t.map((v, ch) => Math.abs(rgb[j * 3 + ch]! - v)));
      if (d > SHADE_TOLERANCE || d >= bestD) continue;
      if (rgb[j * 3] === c[0] && rgb[j * 3 + 1] === c[1] && rgb[j * 3 + 2] === c[2]) continue;
      const lj = luminance(rgb, j);
      if (k < 1 ? lj >= lg : lj <= lg) continue;
      best = j;
      bestD = d;
    }
    return best;
  };
  const d1 = pick(GROUND_STEPS[1]) ?? g;
  const d0 = pick(GROUND_STEPS[0]) ?? d1;
  const l1 = pick(GROUND_STEPS[3]) ?? g;
  const l2 = pick(GROUND_STEPS[4]) ?? l1;
  return [d0, d1, g, l1, l2];
}
