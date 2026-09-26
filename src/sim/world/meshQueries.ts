/**
 * Polygon-level collision tests (project_entry): point-in-polygon in the
 * three axis planes, a polygon's plane height, and ray against polygon.
 *
 * A polygon's normal (+0x14..+0x1c) is 2.29 fixed point; the tests publish it
 * as 16.16 (>> 13) in hitNormalX/Y/Z. Vertices are read in world space
 * (MeshVertex.worldX/Y/Z), through the polygon's index list.
 */
import type { MeshPolygon, MeshVertex, Ray } from '../../generated/classes.gen.ts';
import { mulr29, sdivShl } from '../../core/int/i64.ts';
import { mulr16 } from '../../core/int/fx16.ts';
import { raySetEnd } from '../../engine/collision/ray.ts';
import { collision } from './collisionGlobals.ts';

type Axis = 'worldX' | 'worldY' | 'worldZ';

/**
 * The crossing test shared by the three planes, over axes u (the one
 * interpolated) and v (the one the point's scanline is on). First a cheap
 * reject: the polygon must have vertices on both sides of the point in both
 * axes. Then the edges (v[n-1], v[0]), (v[n-2], v[n-1]) .. (v[0], v[1]) are
 * walked with two flags - a crossing to the left and one to the right - and
 * the first time both sides are seen the point is inside; a second crossing
 * on the same side means outside. A horizontal edge exactly on the point's
 * scanline decides at once. Edge interpolation is a 64-bit product and a
 * truncating divide.
 */
function containsPoint2D(poly: MeshPolygon, vertices: MeshVertex[], U: Axis, V: Axis, u: number, v: number): number {
  let left = false;
  let right = false;
  let n = poly.vertexCount;
  if (!(2 < n)) return 0;
  const idx = poly.indices;
  let bits = 0;
  for (let i = n - 1; i >= 0; i--) {
    const p = vertices[idx[i]!]!;
    bits |= u < p[U] ? 2 : 1;
    bits |= v < p[V] ? 8 : 4;
    if (bits === 0xf) break;
  }
  if (bits !== 0xf) return 0;
  let a = vertices[idx[0]!]!;
  for (;;) {
    const b = a;
    n--;
    if (n === -1) break;
    a = vertices[idx[n]!]!;
    if ((v <= a[V] || v <= b[V]) && (a[V] <= v || b[V] <= v)) {
      if (v === a[V] && a[V] === b[V]) {
        if (a[U] < u && b[U] < u) return 0;
        if (a[U] <= u) return 1;
        if (u < b[U]) return 0;
        return 1;
      }
      if (v !== a[V]) {
        let crossesLeft: boolean;
        if (a[U] < u && b[U] < u) crossesLeft = true;
        else if (u < a[U] && u < b[U]) crossesLeft = false;
        else {
          const du = BigInt((b[U] - a[U]) | 0) * BigInt((v - a[V]) | 0);
          const xi = (Number(BigInt.asIntN(32, du / BigInt((b[V] - a[V]) | 0))) + a[U]) | 0;
          if (((xi - u) | 0) < 0) crossesLeft = true;
          else if (xi === u) return 1;
          else crossesLeft = false;
        }
        if (crossesLeft) {
          if (left) return 0;
          if (right) return 1;
          left = true;
        } else {
          if (right) return 0;
          if (left) return 1;
          right = true;
        }
      }
    }
  }
  return 0;
}

/**
 * Does the polygon contain (x, z) seen from above?
 *
 * @mw2 polygon_contains_point_xz 0x0001ca00
 * @fidelity exact
 */
export function polygonContainsPointXz(poly: MeshPolygon, vertices: MeshVertex[], x: number, z: number): number {
  return containsPoint2D(poly, vertices, 'worldX', 'worldZ', x, z);
}

/**
 * @mw2 polygon_contains_point_xy 0x0001cbb0
 * @fidelity exact
 */
export function polygonContainsPointXy(poly: MeshPolygon, vertices: MeshVertex[], x: number, y: number): number {
  return containsPoint2D(poly, vertices, 'worldX', 'worldY', x, y);
}

/**
 * @mw2 polygon_contains_point_yz 0x0001cd60
 * @fidelity exact
 */
export function polygonContainsPointYz(poly: MeshPolygon, vertices: MeshVertex[], y: number, z: number): number {
  return containsPoint2D(poly, vertices, 'worldY', 'worldZ', y, z);
}

/**
 * Point-in-polygon for a point on the polygon's plane, projected along the
 * normal's dominant axis.
 *
 * @mw2 polygon_contains_point 0x0001c970
 * @fidelity exact
 */
export function polygonContainsPoint(poly: MeshPolygon, vertices: MeshVertex[], x: number, y: number, z: number): number {
  if (poly.vertexCount < 3) return 0;
  const nx = Math.abs(poly.normalX) | 0;
  const ny = Math.abs(poly.normalY) | 0;
  const nz = Math.abs(poly.normalZ) | 0;
  if (nx < ny && nz < ny) return polygonContainsPointXz(poly, vertices, x, z);
  if (nz < nx) return polygonContainsPointYz(poly, vertices, y, z);
  return polygonContainsPointXy(poly, vertices, x, y);
}

/**
 * (nx * dx + nz * dz + bias) / ny, summed in 64 bits, truncating divide.
 * No guard for ny == 0 (a divide fault, fatal in the original).
 *
 * @mw2 plane_solve 0x0003a3aa
 * @fidelity exact
 */
export function planeSolve(nx: number, ny: number, nz: number, bias: number, dx: number, dz: number): number {
  if ((ny | 0) === 0) throw new RangeError('plane_solve: divide by zero (ny == 0)');
  const s = BigInt(nx | 0) * BigInt(dx | 0) + BigInt(nz | 0) * BigInt(dz | 0) + BigInt(bias >>> 0);
  return Number(BigInt.asIntN(32, s / BigInt(ny | 0)));
}

/**
 * The height of the polygon's plane under (x, z); publishes its normal in
 * hitNormalX/Y/Z and returns whether y is below it.
 *
 * @mw2 poly_surface_height 0x0001c090
 * @fidelity exact
 */
export function polySurfaceHeight(poly: MeshPolygon, vertices: MeshVertex[], x: number, y: number, z: number, out: { v: number }): boolean {
  const v0 = vertices[poly.indices[0]!]!;
  const d = planeSolve(poly.normalX, poly.normalY, poly.normalZ, 0, (x - v0.worldX) | 0, (z - v0.worldZ) | 0);
  out.v = (v0.worldY - d) | 0;
  collision.hitNormalX = poly.normalX >> 13;
  collision.hitNormalY = poly.normalY >> 13;
  collision.hitNormalZ = poly.normalZ >> 13;
  return y < out.v;
}

/**
 * One-sided ray against one polygon: on a hit the ray's end moves to the hit
 * point and the normal is published.
 *
 * @mw2 ray_hit_polygon 0x0001c7a0
 * @fidelity exact
 */
export function rayHitPolygon(poly: MeshPolygon, vertices: MeshVertex[], ray: Ray): number {
  const nx = poly.normalX;
  const ny = poly.normalY;
  const nz = poly.normalZ;
  const denom = (mulr29(nx, ray.unitX) + mulr29(ny, ray.unitY) + mulr29(nz, ray.unitZ)) | 0;
  if (!(denom < 0)) return 0;
  const v0 = vertices[poly.indices[0]!]!;
  const atStart = (mulr29(nz, ray.startZ) + mulr29(nx, ray.startX) + mulr29(ny, ray.startY)) | 0;
  const atV0 = (mulr29(nz, v0.worldZ) + mulr29(nx, v0.worldX) + mulr29(ny, v0.worldY)) | 0;
  const num = (atStart - atV0) | 0;
  if (num < 1) return 0;
  const neg = -num | 0;
  if (0x7fff < ((neg / denom) | 0)) return 0;
  const t = sdivShl(neg, 16, denom);
  if (t < 1 || ray.length < t) return 0;
  const x = (ray.startX + mulr16(ray.unitX, t)) | 0;
  const y = (ray.startY + mulr16(ray.unitY, t)) | 0;
  const z = (ray.startZ + mulr16(ray.unitZ, t)) | 0;
  if (polygonContainsPoint(poly, vertices, x, y, z) === 0) return 0;
  raySetEnd(ray, x, y, z);
  collision.hitNormalX = nx >> 13;
  collision.hitNormalY = ny >> 13;
  collision.hitNormalZ = nz >> 13;
  return 1;
}
