/**
 * Polar terms from a position difference.
 */
import { fixedAtan2, fixedCos, fixedSin } from '../angle/trig.ts';
import { sdivShl } from '../int/i64.ts';

export interface RangeBearing {
  /** fixed_atan2(dx, dz): bearing from +Z toward +X, 16.16 degrees */
  azimuth: number;
  /** true 3D distance */
  slantRange: number;
  /** horizontal distance */
  groundRange: number;
  /** fixed_atan2(dy, groundRange) */
  elevation: number;
}

/**
 * Ground range is the larger leg over sin or cos of the azimuth (shifted 29 to
 * undo the sine scale); slant range is ground range over cos(elevation).
 * Zero where the divisor is zero.
 *
 * @mw2 vec_to_range_bearing 0x0002ab60
 * @fidelity exact
 */
export function vecToRangeBearing(dx: number, dy: number, dz: number): RangeBearing {
  dx |= 0;
  dy |= 0;
  dz |= 0;
  const azimuth = fixedAtan2(dx, dz);
  const ax = (dx ^ (dx >> 31)) - (dx >> 31);
  const az = (dz ^ (dz >> 31)) - (dz >> 31);
  let ground = 0;
  if (az < ax) {
    const s = fixedSin(azimuth);
    if (s !== 0) ground = sdivShl(dx, 29, s);
  } else {
    const c = fixedCos(azimuth);
    if (c !== 0) ground = sdivShl(dz, 29, c);
  }
  const elevation = fixedAtan2(dy, ground);
  let slant = fixedCos(elevation);
  if (slant !== 0) slant = sdivShl(ground, 29, slant);
  return { azimuth, slantRange: slant, groundRange: ground, elevation };
}
