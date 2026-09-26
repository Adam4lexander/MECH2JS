/**
 * Ray (terrain_part1, 0x1d840..0x1dd5b): a segment with its start, end and
 * delta, and a cached 16.16 unit direction and length. `normalised` says how
 * the cache was filled: 0 not yet, 1 by the octagonal approximation
 * (ray_normalise), 2 by the exact square root (ray_normalise_exact). Length
 * is stored SIGNED: ray_set_length keeps whatever it is given, so a
 * negative length puts the end behind the start (mech_move_step relies on
 * it).
 */
import type { Ray } from '../../generated/classes.gen.ts';
import { sdivShl } from '../../core/int/i64.ts';
import { mulDiv64, mulr16 } from '../../core/int/fx16.ts';

/**
 * The octagonal length approximation used throughout the binary:
 * (4 * max + mid + min) >> 2 of the three absolute values, with the exact
 * compare-and-swap order of the originals (the result is the same whichever
 * order; the arithmetic shift matters for sums above 2^31, which wrap).
 *
 * @portOnly arithmetic idiom
 */
export function octLength(a: number, b: number, c: number): number {
  a = Math.abs(a | 0) | 0;
  b = Math.abs(b | 0) | 0;
  c = Math.abs(c | 0) | 0;
  let hi = a;
  let lo = b;
  if (a < b) {
    hi = b;
    lo = a;
  }
  let top = hi;
  let mid = c;
  if (hi < c) {
    top = c;
    mid = hi;
  }
  return ((Math.imul(top, 4) + lo + mid) | 0) >> 2;
}

/**
 * @mw2 ray_set_points 0x0001d840
 * @fidelity exact
 */
export function raySetPoints(ray: Ray, startX: number, startY: number, startZ: number, endX: number, endY: number, endZ: number): void {
  ray.length = 0;
  ray.normalised = 0;
  ray.startX = startX | 0;
  ray.startY = startY | 0;
  ray.startZ = startZ | 0;
  ray.endX = endX | 0;
  ray.endY = endY | 0;
  ray.dx = (endX - startX) | 0;
  ray.dy = (endY - startY) | 0;
  ray.endZ = endZ | 0;
  ray.dz = (endZ - startZ) | 0;
  ray.unitX = ray.unitY = ray.unitZ = ray.length;
}

/**
 * @mw2 ray_length 0x0001d940
 * @fidelity exact
 */
export function rayLength(ray: Ray): number {
  if (ray.normalised === 0) rayNormalise(ray);
  return ray.length;
}

/**
 * unit and length from delta by the octagonal approximation; a length of 0
 * or less leaves unit stale and normalised clear.
 *
 * @mw2 ray_normalise 0x0001d960
 * @fidelity exact
 */
export function rayNormalise(ray: Ray): void {
  if (ray.normalised !== 0) return;
  const len = octLength(ray.dx, ray.dy, ray.dz);
  ray.length = len;
  if (0 < len) {
    ray.unitX = sdivShl(ray.dx, 16, len);
    ray.unitY = sdivShl(ray.dy, 16, len);
    ray.normalised = 1;
    ray.unitZ = sdivShl(ray.dz, 16, len);
  }
}

/**
 * The exact normalisation, on the x87: v = end - start (not the stored
 * delta), len = sqrt(v . v), unit = trunc(v / len * 65536), length =
 * trunc(len + 0.5). A zero vector gives 1/0 = infinity on the FPU and an
 * integer-indefinite store (0x80000000) in each field.
 *
 * @mw2 ray_normalise_exact 0x0001d9f0
 * @fidelity exact
 * @divergence the x87 works in 80-bit extended precision and the port in doubles; a value within an extended ulp of an integer could truncate differently
 */
export function rayNormaliseExact(ray: Ray): void {
  if (ray.normalised === 2) return;
  const x = (ray.endX - ray.startX) | 0;
  const y = (ray.endY - ray.startY) | 0;
  const z = (ray.endZ - ray.startZ) | 0;
  const len = Math.sqrt(x * x + y * y + z * z);
  const inv = 1 / len;
  ray.unitX = fistpTrunc(x * inv * 65536.0);
  ray.unitY = fistpTrunc(y * inv * 65536.0);
  ray.unitZ = fistpTrunc(z * inv * 65536.0);
  ray.normalised = 2;
  ray.length = fistpTrunc(len + 0.5);
}

/** clib_fp_trunc then fistp: truncate toward zero; out of range or NaN stores the integer indefinite 0x80000000. */
function fistpTrunc(v: number): number {
  const t = Math.trunc(v);
  if (!Number.isFinite(t) || t > 0x7fffffff || t < -0x80000000) return -0x80000000;
  return t | 0;
}

/**
 * Cuts or extends the segment to `length` along its unit direction.
 *
 * @mw2 ray_set_length 0x0001daa0
 * @fidelity exact
 */
export function raySetLength(ray: Ray, length: number): void {
  if (ray.normalised === 0) rayNormalise(ray);
  if (ray.normalised === 0) return;
  ray.endX = (ray.startX + mulr16(length, ray.unitX)) | 0;
  ray.endY = (ray.startY + mulr16(length, ray.unitY)) | 0;
  ray.endZ = (ray.startZ + mulr16(length, ray.unitZ)) | 0;
  ray.dx = (ray.endX - ray.startX) | 0;
  ray.dy = (ray.endY - ray.startY) | 0;
  ray.length = length | 0;
  ray.dz = (ray.endZ - ray.startZ) | 0;
}

/**
 * Moves the end, then refreshes unit and length the way the old
 * normalised flag says.
 *
 * @mw2 ray_set_end 0x0001dbd0
 * @fidelity exact
 */
export function raySetEnd(ray: Ray, endX: number, endY: number, endZ: number): void {
  ray.endX = endX | 0;
  ray.endY = endY | 0;
  ray.dx = (endX - ray.startX) | 0;
  ray.endZ = endZ | 0;
  ray.dy = (endY - ray.startY) | 0;
  ray.dz = (endZ - ray.startZ) | 0;
  const n = ray.normalised >>> 0;
  ray.normalised = 0;
  if (n !== 0) {
    if (n < 2) {
      rayNormalise(ray);
      return;
    }
    if (n === 2) {
      rayNormaliseExact(ray);
      return;
    }
  }
  ray.length = 0;
  ray.unitX = ray.unitY = ray.unitZ = 0;
}

/**
 * @mw2 ray_copy 0x0001dc70
 * @fidelity exact
 */
export function rayCopy(dst: Ray, src: Ray): void {
  dst.startX = src.startX;
  dst.startY = src.startY;
  dst.startZ = src.startZ;
  dst.endX = src.endX;
  dst.endY = src.endY;
  dst.endZ = src.endZ;
  dst.dx = src.dx;
  dst.dy = src.dy;
  dst.dz = src.dz;
  dst.unitX = src.unitX;
  dst.unitY = src.unitY;
  dst.unitZ = src.unitZ;
  dst.length = src.length;
  dst.normalised = src.normalised;
}

/**
 * A segment from an origin, a 16.16 unit direction and a length; marked
 * normalised since unit and length are given.
 *
 * @mw2 ray_set_from_direction 0x0001d8a0
 * @fidelity exact
 */
export function raySetFromDirection(ray: Ray, startX: number, startY: number, startZ: number, dirX: number, dirY: number, dirZ: number, length: number): void {
  ray.startX = startX | 0;
  ray.startZ = startZ | 0;
  ray.startY = startY | 0;
  ray.unitY = dirY | 0;
  ray.unitZ = dirZ | 0;
  ray.unitX = dirX | 0;
  ray.dx = mulr16(length, dirX);
  ray.dy = mulr16(length, dirY);
  ray.dz = mulr16(length, dirZ);
  ray.normalised = 1;
  ray.endX = (startX + ray.dx) | 0;
  ray.length = length | 0;
  ray.endY = (startY + ray.dy) | 0;
  ray.endZ = (startZ + ray.dz) | 0;
}

/**
 * Cuts the segment where it reaches y = height, by length * (height -
 * startY) / dy; a ray with no vertical extent is left alone.
 *
 * @mw2 ray_set_end_at_height 0x0001dc40
 * @fidelity exact
 */
export function raySetEndAtHeight(ray: Ray, height: number): void {
  if (ray.dy !== 0) raySetLength(ray, mulDiv64(ray.length, (height - ray.startY) | 0, ray.dy));
}

/**
 * Scales three ints to a 16.16 unit vector in place (octagonal length);
 * left alone when that length is not positive.
 *
 * @mw2 vec3_normalise 0x0003fa50
 * @fidelity exact
 */
export function vec3Normalise(v: number[]): void {
  const len = octLength(v[0]!, v[1]!, v[2]!);
  if (0 < len) for (let i = 0; i < 3; i++) v[i] = sdivShl(v[i]!, 16, len);
}

/**
 * One axis of the slab method: the 16.16 distances along the ray (whose
 * direction component is `dir`) to the planes slabMin and slabMax, ordered
 * into near and far. A zero direction, or a whole-part quotient outside
 * -0x8000..0x7fff, counts as parallel: outside the slab it returns 1 (a
 * certain miss), inside it gives -0x7fffffff..0x7fffffff. Returns 0 otherwise.
 *
 * @mw2 ray_slab_intersect 0x0001dca0
 * @fidelity exact
 */
export function raySlabIntersect(origin: number, dir: number, slabMin: number, slabMax: number, out: { near: number; far: number }): number {
  let parallel = true;
  const d0 = (slabMin - origin) | 0;
  const d1 = (slabMax - origin) | 0;
  if (dir !== 0) {
    const q0 = (d0 / dir) | 0;
    const q1 = (d1 / dir) | 0;
    if (!(q0 > 0x7fff) && !(q0 < -0x8000) && !(q1 > 0x7fff) && !(q1 < -0x8000)) parallel = false;
  }
  let t0: number;
  let t1: number;
  if (parallel) {
    if (origin < slabMin || slabMax < origin) return 1;
    t0 = -0x7fffffff;
    t1 = 0x7fffffff;
  } else {
    t0 = sdivShl(d0, 16, dir);
    t1 = sdivShl(d1, 16, dir);
  }
  if (t0 <= t1) {
    out.near = t0;
    out.far = t1;
  } else {
    out.near = t1;
    out.far = t0;
  }
  return 0;
}
