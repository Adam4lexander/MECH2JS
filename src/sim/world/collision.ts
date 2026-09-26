/**
 * World collision (project_entry / terrain): per-class object queries, the
 * world sweeps (ground height, raycasts, point queries) and the mech
 * movement step with its sphere pushouts.
 *
 * THE PER-CLASS METHOD TABLE at 0x95a5c: three code pointers per
 * WorldObject.objectClass - point inside, raycast, ground height - read from
 * the image and resolved to the ported methods below (resolveCode):
 *
 *   0 box         box_point_inside     ray_hit_object_box   box_ground_height
 *   1 column      column_point_inside  ray_hit_object_box   -
 *   2 underside   downface_point_inside mesh_raycast_all    -
 *   3             -                    -                    -
 *   4 nothing     null_point_inside    null_raycast         -
 *   5 walkmesh    walkmesh_point_inside walkmesh_raycast    walkmesh_ground_height
 *   6             -                    -                    -   (spheres: mech_collide_obstacles)
 *   7             -                    mesh_raycast_all     -
 *
 * The world sweeps walk the world chain (worldRoot.worldNext ...).
 */
import { Ray } from '../../generated/classes.gen.ts';
import type { MechEntity, MechLoadout, MeshBlock, QuadtreeNode, WorldObject } from '../../generated/classes.gen.ts';
import { divergence } from '../../core/provenance.ts';
import { sdivShl } from '../../core/int/i64.ts';
import { registerCode, resolveCode, type CodeFn } from '../../engine/codePtr.ts';
import { imageI32 } from '../../engine/image.ts';
import { objectLists } from '../../engine/scene/objectLists.ts';
import { objectRefreshMesh } from '../../engine/scene/worldObject.ts';
import { mulr16 } from '../../core/int/fx16.ts';
import { octLength, rayCopy, rayLength, rayNormalise, raySetEnd, raySetLength, raySetPoints, raySlabIntersect, vec3Normalise } from '../../engine/collision/ray.ts';
import { mechs } from '../mech/mechGlobals.ts';
import { mechCrashToGround } from '../mech/mechTickAi.ts';
import { fallingObjectAttach, fallingObjectPush } from '../things/fallingObjects.ts';
import { collision } from './collisionGlobals.ts';
import { quadtreeGroundHeight, quadtreePointBelow, quadtreeRaycast } from './groundQuadtree.ts';
import { planeSolve, polySurfaceHeight, polygonContainsPointXz, rayHitPolygon } from './meshQueries.ts';

export { collision } from './collisionGlobals.ts';

/** An out-parameter (int * in C). @portOnly */
export interface Out<T> {
  v: T;
}

// ---------------------------------------------------------------------------
// bounds

/** WorldObject.bounds as its six ints [minX, maxX, minY, maxY, minZ, maxZ] (a quadtree root starts with the same six). */
function boundsOf(obj: WorldObject): Int32Array | QuadtreeNode | null {
  return obj.bounds;
}
function b6(b: Int32Array | QuadtreeNode, i: number): number {
  if (b instanceof Int32Array) return b[i]!;
  return [b.minX, b.maxX, b.minY, b.maxY, b.minZ, b.maxZ][i]!;
}

/**
 * The world-space box of the head (finest) mesh, refreshed first when its
 * stamp is stale; no mesh gives all zeros, an empty mesh an inverted box.
 *
 * @mw2 object_compute_bounds 0x0001ea20
 * @fidelity exact
 */
export function objectComputeBounds(obj: WorldObject, out: Int32Array): void {
  const mesh = obj.meshList;
  if (!mesh) {
    out.fill(0);
    return;
  }
  if (obj.transformVersion !== mesh.transformVersion) {
    const saved = obj.currentMesh;
    obj.currentMesh = mesh;
    objectRefreshMesh(obj);
    obj.currentMesh = saved;
  }
  out[4] = out[2] = out[0] = 0x7fffffff;
  out[5] = out[3] = out[1] = -0x7fffffff;
  for (let i = 0; i < mesh.vertexCount; i++) {
    const v = mesh.vertices[i]!;
    if (out[1]! < v.worldX) out[1] = v.worldX;
    if (out[3]! < v.worldY) out[3] = v.worldY;
    if (out[5]! < v.worldZ) out[5] = v.worldZ;
    if (v.worldX < out[0]!) out[0] = v.worldX;
    if (v.worldY < out[2]!) out[2] = v.worldY;
    if (v.worldZ < out[4]!) out[4] = v.worldZ;
  }
}

/**
 * Computes the box into WorldObject.bounds (allocated on first use) unless
 * flags 0x200 says it is current, then sets 0x200.
 *
 * @mw2 object_ensure_bounds 0x0001e900
 * @fidelity exact
 */
export function objectEnsureBounds(obj: WorldObject | null): void {
  if (!obj || ((obj.flags >> 8) & 2) !== 0) return;
  if (!obj.bounds) obj.bounds = new Int32Array(6);
  const b = obj.bounds;
  if (b instanceof Int32Array) {
    objectComputeBounds(obj, b);
  } else {
    // a class-5 object's +0x44 is its quadtree root, whose first six ints are the same box
    const t = new Int32Array(6);
    objectComputeBounds(obj, t);
    b.minX = t[0]!;
    b.maxX = t[1]!;
    b.minY = t[2]!;
    b.maxY = t[3]!;
    b.minZ = t[4]!;
    b.maxZ = t[5]!;
  }
  obj.flags |= 0x200;
}

/**
 * Over the box in X/Z? Then its top, and whether y is inside it too.
 *
 * @mw2 object_box_query 0x0001ebf0
 * @fidelity exact
 */
export function objectBoxQuery(obj: WorldObject, x: number, y: number, z: number): { inside: number; over: number; top: number } {
  objectEnsureBounds(obj);
  const b = boundsOf(obj);
  const r = { inside: 0, over: 0, top: 0 };
  if (!b) return r;
  if (b6(b, 0) <= x && x <= b6(b, 1) && b6(b, 4) <= z && z <= b6(b, 5)) {
    r.over = 1;
    r.top = b6(b, 3);
    r.inside = y < b6(b, 2) || r.top < y ? 0 : 1;
  }
  return r;
}

// ---------------------------------------------------------------------------
// the per-class methods

/**
 * @mw2 box_point_inside 0x0001eb80
 * @fidelity exact
 */
export const boxPointInside = registerCode('box_point_inside', 0x1eb80, (obj: WorldObject, x: number, y: number, z: number): number => objectBoxQuery(obj, x, y, z).inside);

/**
 * Class 0's ground: the box top, normal straight up.
 *
 * @mw2 box_ground_height 0x0001eba0
 * @fidelity exact
 */
export const boxGroundHeight = registerCode('box_ground_height', 0x1eba0, (obj: WorldObject, x: number, y: number, z: number, out: Out<number>): number => {
  const q = objectBoxQuery(obj, x, y, z);
  if (q.over !== 0) {
    out.v = q.top;
    collision.hitNormalY = 0x10000;
    collision.hitNormalZ = 0;
    collision.hitNormalX = 0;
  }
  return q.over;
});

/**
 * Ray against the object's box by the slab method; on a hit the ray is cut
 * to the entry distance and the entered face's axis normal, signed against
 * the ray, is published.
 *
 * @mw2 ray_hit_object_box 0x0001ec60
 * @fidelity exact
 */
export const rayHitObjectBox = registerCode('ray_hit_object_box', 0x1ec60, (obj: WorldObject, ray: Ray): number => {
  objectEnsureBounds(obj);
  const b = boundsOf(obj);
  if (!b) return 0;
  const s = { near: 0, far: 0 };
  const t = { near: 0, far: 0 };
  if (raySlabIntersect(ray.startX, ray.unitX, b6(b, 0), b6(b, 1), s) !== 0) return 0;
  let axis = 0;
  if (raySlabIntersect(ray.startY, ray.unitY, b6(b, 2), b6(b, 3), t) !== 0) return 0;
  if (s.near < t.near) {
    s.near = t.near;
    axis = 1;
  }
  if (t.far < s.far) s.far = t.far;
  if (raySlabIntersect(ray.startZ, ray.unitZ, b6(b, 4), b6(b, 5), t) !== 0) return 0;
  if (s.near < t.near) {
    s.near = t.near;
    axis = 2;
  }
  if (t.far < s.far) s.far = t.far;
  if (s.far < s.near) return 0;
  if (s.near < 0) {
    collision.dat00095ae8 = s.near;
    s.near = 0;
  }
  const len = rayLength(ray);
  if (len < s.far) s.far = len;
  if (s.far < s.near) return 0;
  raySetLength(ray, s.near);
  const c = collision;
  if (axis === 0) {
    c.hitNormalZ = 0;
    c.hitNormalY = 0;
    c.hitNormalX = ray.dx < 1 ? 0x10000 : -0x10000;
  } else if (axis === 1) {
    c.hitNormalZ = 0;
    c.hitNormalX = 0;
    c.hitNormalY = ray.dy < 1 ? 0x10000 : -0x10000;
  } else {
    c.hitNormalY = 0;
    c.hitNormalX = 0;
    c.hitNormalZ = ray.dz < 1 ? 0x10000 : -0x10000;
  }
  return 1;
});

/**
 * Class 1: inside the box in X and Z, whatever y.
 *
 * @mw2 column_point_inside 0x0001ee20
 * @fidelity exact
 */
export const columnPointInside = registerCode('column_point_inside', 0x1ee20, (obj: WorldObject, x: number, _y: number, z: number): number => {
  objectEnsureBounds(obj);
  const b = boundsOf(obj);
  if (!b) return 0;
  return b6(b, 0) <= x && x <= b6(b, 1) && b6(b, 4) <= z && z <= b6(b, 5) ? 1 : 0;
});

/**
 * @mw2 null_point_inside 0x0001ee60
 * @fidelity exact
 */
export const nullPointInside = registerCode('null_point_inside', 0x1ee60, (): number => 0);

/**
 * @mw2 null_raycast 0x0001ee70
 * @fidelity exact
 */
export const nullRaycast = registerCode('null_raycast', 0x1ee70, (): number => 0);

/**
 * The no-quadtree fallback: the first upward-facing polygon of currentMesh
 * containing (x, z) decides whether y is below the ground.
 *
 * @mw2 walkmesh_point_below_scan 0x0001ee80
 * @fidelity exact
 */
export function walkmeshPointBelowScan(obj: WorldObject, x: number, y: number, z: number): number {
  const m = obj.currentMesh!;
  for (let i = 0; ; ) {
    const p = m.polygons[i]!;
    if (0 < p.normalY && polygonContainsPointXz(p, m.vertices, x, z) !== 0) {
      return polySurfaceHeight(p, m.vertices, x, y, z, { v: 0 }) ? 1 : 0;
    }
    i++;
    if (m.polygonCount === i) return 0;
  }
}

/**
 * @mw2 walkmesh_point_inside 0x0001ef40
 * @fidelity exact
 */
export const walkmeshPointInside = registerCode('walkmesh_point_inside', 0x1ef40, (obj: WorldObject, x: number, y: number, z: number): number => {
  if (obj.bounds) return quadtreePointBelow(obj.bounds as QuadtreeNode, obj.meshList as MeshBlock, x, y, z) & 1;
  return walkmeshPointBelowScan(obj, x, y, z);
});

/**
 * @mw2 walkmesh_raycast 0x0001ef70
 * @fidelity exact
 */
export const walkmeshRaycast = registerCode('walkmesh_raycast', 0x1ef70, (obj: WorldObject, ray: Ray): number => quadtreeRaycast(obj.bounds as QuadtreeNode | null, obj.meshList as MeshBlock, ray) & 1);

/**
 * @mw2 walkmesh_ground_height 0x0001ef90
 * @fidelity exact
 */
export const walkmeshGroundHeight = registerCode('walkmesh_ground_height', 0x1ef90, (obj: WorldObject, x: number, y: number, z: number, out: Out<number>): number =>
  quadtreeGroundHeight(obj.bounds as QuadtreeNode | null, obj.meshList as MeshBlock, x, y, z, out),
);

/**
 * Class 2: the first DOWNWARD-facing polygon of currentMesh over (x, z)
 * decides - inside when y is above its plane. Its normal is published.
 *
 * @mw2 downface_point_inside 0x0001efb0
 * @fidelity exact
 */
export const downfacePointInside = registerCode('downface_point_inside', 0x1efb0, (obj: WorldObject, x: number, y: number, z: number): number => {
  const m = obj.currentMesh!;
  const vertices = m.vertices;
  let i = 0;
  let p;
  for (;;) {
    p = m.polygons[i]!;
    if (p.normalY < 0 && polygonContainsPointXz(p, vertices, x, z) !== 0) break;
    i++;
    if (m.polygonCount === i) return 0;
  }
  const v0 = vertices[p.indices[0]!]!;
  const d = planeSolve(p.normalX, p.normalY, p.normalZ, 0, (x - v0.worldX) | 0, (z - v0.worldZ) | 0);
  collision.hitNormalX = p.normalX >> 13;
  collision.hitNormalY = p.normalY >> 13;
  collision.hitNormalZ = p.normalZ >> 13;
  return y <= ((v0.worldY - d) | 0) ? 0 : 1;
});

/**
 * Ray against every polygon of currentMesh; the first hit in polygon order.
 *
 * @mw2 mesh_raycast_all 0x0001f0c0
 * @fidelity exact
 */
export const meshRaycastAll = registerCode('mesh_raycast_all', 0x1f0c0, (obj: WorldObject, ray: Ray): number => {
  const m = obj.currentMesh;
  if (m) for (let i = 0; i < m.polygonCount; i++) if (rayHitPolygon(m.polygons[i]!, m.vertices, ray) !== 0) return 1;
  return 0;
});

const OBJECT_METHODS = 0x95a5c;
/** the table as the image holds it, for a run without one (unit tests) */
const OBJECT_METHODS_IMAGE = [
  0x1eb80, 0x1ec60, 0x1eba0, 0x1ee20, 0x1ec60, 0, 0x1efb0, 0x1f0c0, 0, 0, 0, 0, 0x1ee60, 0x1ee70, 0, 0x1ef40, 0x1ef70, 0x1ef90, 0, 0, 0, 0, 0x1f0c0, 0,
];

/** objectClass's method in column 0 (point inside), 1 (raycast) or 2 (ground height). @portOnly the table lookup */
function objectMethod(objectClass: number, column: number): CodeFn | null {
  const i = objectClass * 3 + column;
  return resolveCode(imageI32(OBJECT_METHODS + i * 4, OBJECT_METHODS_IMAGE[i] ?? 0) >>> 0);
}

/**
 * Non-zero when the object's class has a ground-height method
 * (objectGroundHeightMethods, column 2: classes 0 and 5).
 *
 * @mw2 object_is_ground 0x0001c2e0
 * @fidelity exact
 */
export function objectIsGround(obj: WorldObject): number {
  const i = obj.objectClass * 3 + 2;
  return imageI32(OBJECT_METHODS + i * 4, OBJECT_METHODS_IMAGE[i] ?? 0) !== 0 ? 1 : 0;
}

// ---------------------------------------------------------------------------
// ground height

/**
 * The ground under (x, z) for something at height y: the highest surface
 * within 1000 either way of y, else the highest below y, else 0. Asks every
 * class-5 and class-0 object on the world chain; leaves the chosen surface's
 * normal in groundNormalX/Y/Z.
 *
 * @mw2 world_ground_height_near 0x0001c120
 * @fidelity exact
 */
export function worldGroundHeightNear(x: number, y: number, z: number): number {
  const root = objectLists.worldRoot;
  if (!root) return 0;
  const c = collision;
  let near = -0x7fffffff;
  let below = -0x7fffffff;
  const h = { v: 0 };
  for (let o = root.worldNext; o; o = o.worldNext) {
    let fn: typeof walkmeshGroundHeight | null = null;
    if (o.objectClass === 5) fn = walkmeshGroundHeight;
    else if (o.objectClass === 0) fn = boxGroundHeight;
    if (!fn || fn(o, x, y, z, h) === 0) continue;
    if (near === -0x7fffffff && h.v < y && below < h.v) {
      c.groundNormalX = c.hitNormalX;
      c.groundNormalY = c.hitNormalY;
      below = h.v;
      c.groundNormalZ = c.hitNormalZ;
    }
    if (y < ((h.v + 1000) | 0) && ((h.v - 1000) | 0) < y && near < h.v) {
      near = h.v;
      c.groundNormalX = c.hitNormalX;
      c.groundNormalY = c.hitNormalY;
      c.groundNormalZ = c.hitNormalZ;
    }
  }
  if (near < -0x7ffffffe) {
    if (-0x7fffffff < below) return below;
    near = 0;
  }
  return near;
}

/**
 * The HIGHEST surface under (x, z) of every class-5 and class-0 object, or
 * 0; its normal goes to groundNormalX/Y/Z.
 *
 * @mw2 world_find_highest_hit 0x0001c240
 * @fidelity exact
 */
export function worldFindHighestHit(x: number, y: number, z: number): number {
  const root = objectLists.worldRoot;
  if (!root) return 0;
  const c = collision;
  let best = -0x7fffffff;
  const h = { v: 0 };
  for (let o = root.worldNext; o; o = o.worldNext) {
    let fn: typeof walkmeshGroundHeight | null = null;
    if (o.objectClass === 5) fn = walkmeshGroundHeight;
    else if (o.objectClass === 0) fn = boxGroundHeight;
    if (!fn) continue;
    if (fn(o, x, y, z, h) !== 0 && best < h.v) {
      c.groundNormalX = c.hitNormalX;
      c.groundNormalY = c.hitNormalY;
      c.groundNormalZ = c.hitNormalZ;
      best = h.v;
    }
  }
  if (best < -0x7ffffffe) best = 0;
  return best;
}

// ---------------------------------------------------------------------------
// point queries and raycasts

const TWO64 = 1n << 64n;

/**
 * The octagonal distance from a point to the object's centre, or 0x7fffffff
 * when the point is outside its bounding sphere (a cube reject against the
 * radius, then a 64-bit unsigned compare of r^2 with |d|^2).
 *
 * @mw2 object_sphere_distance 0x0003a3d8
 * @fidelity exact
 */
export function objectSphereDistance(obj: WorldObject, x: number, y: number, z: number): number {
  const dx = (obj.posX - x) | 0;
  const dy = (obj.posY - y) | 0;
  const dz = (obj.posZ - z) | 0;
  const r = obj.radius | 0;
  const nr = -r | 0;
  if (dx > r || dx < nr || dy > r || dy < nr || dz > r || dz < nr) return 0x7fffffff;
  const sum = BigInt.asUintN(64, BigInt(dz) * BigInt(dz) + BigInt(dx) * BigInt(dx) + BigInt(dy) * BigInt(dy));
  const r2 = BigInt.asUintN(64, BigInt(r) * BigInt(r));
  if (r2 < sum) return 0x7fffffff;
  let a = Math.abs(dx) | 0;
  let b = Math.abs(dy) | 0;
  if (a < b) [a, b] = [b, a];
  let c = Math.abs(dz) | 0;
  if (a < c) [a, c] = [c, a];
  return (((Math.imul(a, 4) + b + c) >>> 0) >>> 2) | 0;
}

/**
 * Of the objects on root's chain, the one whose bounding sphere holds the
 * point with the smallest object_sphere_distance, or null.
 *
 * @mw2 world_nearest_object_at 0x0001c360
 * @fidelity exact
 */
export function worldNearestObjectAt(root: WorldObject | null, x: number, y: number, z: number): WorldObject | null {
  let best: WorldObject | null = null;
  let bestD = 0x7fffffff;
  if (!root) return null;
  for (let o = root.worldNext; o; o = o.worldNext) {
    const d = objectSphereDistance(o, x, y, z);
    if (d < bestD) {
      bestD = d;
      best = o;
    }
  }
  return best;
}

/**
 * The class's point-inside method, or 1 for a class without one.
 *
 * @mw2 object_contains_point 0x0001c3b0
 * @fidelity exact
 */
export function objectContainsPoint(obj: WorldObject, x: number, y: number, z: number): number {
  const fn = objectMethod(obj.objectClass, 0);
  return fn ? (fn(obj, x, y, z) as number) : 1;
}

/**
 * The zero-length-ray case of the raycasts. out is set to the candidate even
 * when the answer is 0.
 *
 * @mw2 world_point_query 0x0001c310
 * @fidelity exact
 */
export function worldPointQuery(x: number, y: number, z: number, out: Out<WorldObject | null>): number {
  const o = worldNearestObjectAt(objectLists.worldRoot, x, y, z);
  out.v = o;
  return o && objectContainsPoint(o, x, y, z) !== 0 ? 1 : 0;
}

/**
 * The fallback for a class with no raycast or point method (3, 6): a hit on
 * the sphere. The ray is cut to sphereDistance when that is positive; the
 * normal runs from the object's centre to the ray's end - or to its START
 * when sphereDistance is 10, ray_bound_sphere_distance's code for a ray
 * starting inside the sphere.
 *
 * @mw2 object_hit_normal_from_centre 0x0001c720
 * @fidelity exact
 */
export function objectHitNormalFromCentre(obj: WorldObject, ray: Ray, sphereDistance: number): void {
  if (0 < sphereDistance) raySetLength(ray, sphereDistance);
  let x: number, y: number, z: number;
  if (sphereDistance === 10) {
    x = (ray.startX - obj.posX) | 0;
    y = (ray.startY - obj.posY) | 0;
    z = (ray.startZ - obj.posZ) | 0;
  } else {
    x = (ray.endX - obj.posX) | 0;
    y = (ray.endY - obj.posY) | 0;
    z = (ray.endZ - obj.posZ) | 0;
  }
  const n = [x, y, z];
  vec3Normalise(n);
  [collision.hitNormalX, collision.hitNormalY, collision.hitNormalZ] = n as [number, number, number];
}

/**
 * How far along the ray it enters the object's bounding sphere; 10 when it
 * starts inside; 0x7fffffff for a miss or a radius of 0 or less. The 64-bit
 * arithmetic is the assembly's, including its test of the CARRY out of the
 * last addition of the dot product (0x3a7de) - a sign test that is only
 * right when the partial sums have the signs it expects.
 *
 * @mw2 ray_bound_sphere_distance 0x0003a745
 * @fidelity exact
 */
export function rayBoundSphereDistance(obj: WorldObject, ray: Ray): number {
  const r = obj.radius | 0;
  if (r < 1) return 0x7fffffff;
  const cx = BigInt((obj.posX - ray.startX) | 0);
  const cy = BigInt((obj.posY - ray.startY) | 0);
  const cz = BigInt((obj.posZ - ray.startZ) | 0);
  const d2 = BigInt.asUintN(64, cx * cx + cy * cy + cz * cz);
  const r2 = BigInt.asUintN(64, BigInt(r) * BigInt(r));
  if (d2 < r2) return 10;
  const diff = BigInt.asUintN(64, d2 - r2);
  const partial = BigInt.asUintN(64, cx * BigInt(ray.dx | 0) + cy * BigInt(ray.dy | 0));
  const third = BigInt.asUintN(64, cz * BigInt(ray.dz | 0));
  if (partial + third >= TWO64) return 0x7fffffff;
  const dot = BigInt.asIntN(64, partial + third);
  let t = Number(BigInt.asIntN(32, dot / BigInt(ray.length | 0)));
  const t2 = BigInt.asUintN(64, BigInt(t) * BigInt(t));
  if (t2 < diff) return 0x7fffffff;
  t = (t - r) | 0;
  if (t < 0) t = 0;
  if (t < rayLength(ray)) return t;
  return 0x7fffffff;
}

/**
 * One object: its class's raycast method; failing that a four-sample march
 * along the ray asking the point-inside method (a hit ends the ray at the
 * sample, normal zero); failing both, a hit on the bounding sphere. A ray
 * of no length counts as a hit.
 *
 * @mw2 world_object_raycast 0x0001c600
 * @fidelity exact
 */
export function worldObjectRaycast(obj: WorldObject, ray: Ray, sphereDistance: number): number {
  if (0 < rayLength(ray)) {
    const cast = objectMethod(obj.objectClass, 1);
    if (cast) return cast(obj, ray) as number;
    const inside = objectMethod(obj.objectClass, 0);
    if (inside) {
      let x = ray.startX;
      let y = ray.startY;
      let z = ray.startZ;
      const sx = ((ray.endX - x) | 0) >> 2;
      const sy = ((ray.endY - y) | 0) >> 2;
      const sz = ((ray.endZ - z) | 0) >> 2;
      for (let i = 0; i < 4; i++) {
        x = (x + sx) | 0;
        y = (y + sy) | 0;
        z = (z + sz) | 0;
        if ((inside(obj, x, y, z) as number) !== 0) {
          raySetEnd(ray, x, y, z);
          collision.hitNormalZ = 0;
          collision.hitNormalY = 0;
          collision.hitNormalX = 0;
          return 1;
        }
      }
      return 0;
    }
    objectHitNormalFromCentre(obj, ray, sphereDistance);
  }
  return 1;
}

/**
 * The nearest hit on the world chain: the ray is clipped to it and its
 * normal left in rayHitNormalX/Y/Z. An object counts when it is not a mech
 * (type 0x100), or is a mech whose index is not ignoreId while ignoreId is
 * 0 or more - so a NEGATIVE ignoreId excludes every mech.
 *
 * @mw2 world_raycast 0x0001c3f0
 * @fidelity exact
 */
export function worldRaycast(ray: Ray, out: Out<WorldObject | null>, ignoreId: number): number {
  if (rayLength(ray) < 1) return worldPointQuery(ray.startX, ray.startY, ray.startZ, out);
  const root = objectLists.worldRoot;
  if (!root) return 0;
  let best: WorldObject | null = null;
  let bestLen = 0x7fffffff;
  const trial = new Ray();
  const keep = new Ray();
  for (let o = root.worldNext; o; o = o.worldNext) {
    if (((o.type >> 8) & 1) !== 0 && !((o.index & 0xffff) !== ignoreId >>> 0 && -1 < (ignoreId | 0))) continue;
    const d = rayBoundSphereDistance(o, ray);
    if (!(d < bestLen)) continue;
    rayCopy(trial, ray);
    if (worldObjectRaycast(o, trial, d) === 0) continue;
    const l = rayLength(trial);
    if (l < bestLen) {
      bestLen = l;
      rayCopy(keep, trial);
      collision.rayHitNormalX = collision.hitNormalX;
      collision.rayHitNormalY = collision.hitNormalY;
      collision.rayHitNormalZ = collision.hitNormalZ;
      best = o;
    }
  }
  out.v = best;
  if (!best) return 0;
  rayCopy(ray, keep);
  return 1;
}

/**
 * world_raycast's sweep for mech movement: never a mech (type 0x100), never
 * objectClass 6 (the obstacles mech_collide_obstacles handles as spheres).
 * QUIRK: unlike world_raycast it does not re-check the clipped length
 * against the best so far - any hit on a candidate whose bounding sphere is
 * nearer than the best hit replaces it.
 *
 * @mw2 world_raycast_no_mechs 0x0001c510
 * @fidelity exact
 */
export function worldRaycastNoMechs(ray: Ray, out: Out<WorldObject | null>): number {
  if (rayLength(ray) < 1) return worldPointQuery(ray.startX, ray.startY, ray.startZ, out);
  const root = objectLists.worldRoot;
  if (!root) return 0;
  let best: WorldObject | null = null;
  let bestLen = 0x7fffffff;
  const trial = new Ray();
  const keep = new Ray();
  for (let o = root.worldNext; o; o = o.worldNext) {
    if (((o.type >> 8) & 1) !== 0 || o.objectClass === 6) continue;
    const d = rayBoundSphereDistance(o, ray);
    if (!(d < bestLen)) continue;
    rayCopy(trial, ray);
    if (worldObjectRaycast(o, trial, d) === 0) continue;
    bestLen = rayLength(trial);
    rayCopy(keep, trial);
    collision.rayHitNormalX = collision.hitNormalX;
    collision.rayHitNormalY = collision.hitNormalY;
    collision.rayHitNormalZ = collision.hitNormalZ;
    best = o;
  }
  out.v = best;
  if (!best) return 0;
  rayCopy(ray, keep);
  return 1;
}

// ---------------------------------------------------------------------------
// mech movement

/** Pushes pos out from `other` to exactly `reach` along n and sets the mover's bounce: mech_collide_mechs' resolution. */
function pushOffMech(loadout: MechLoadout, other: MechEntity, pos: { x: number; y: number; z: number }, reach: number): void {
  const c = collision;
  const dx = (pos.x - other.posX) | 0;
  const dy = (pos.y - other.posY) | 0;
  const dz = (pos.z - other.posZ) | 0;
  const d = octLength(dx, dy, dz);
  if (d === 0) {
    c.rayHitNormalZ = 0x10000;
    c.rayHitNormalX = 0;
    c.rayHitNormalY = 0;
  } else {
    c.rayHitNormalX = sdivShl(dx, 16, d);
    c.rayHitNormalY = sdivShl(dy, 16, d);
    c.rayHitNormalZ = sdivShl(dz, 16, d);
  }
  pos.x = (other.posX + mulr16(c.rayHitNormalX, reach)) | 0;
  pos.y = (other.posY + mulr16(c.rayHitNormalY, reach)) | 0;
  pos.z = (other.posZ + mulr16(c.rayHitNormalZ, reach)) | 0;
  const ol = other.loadout!;
  // QUIRK: the other mech's stepVelocityZ is copied over this one's, and that copy - not a difference - is the closing speed's z
  loadout.stepVelocityZ = ol.stepVelocityZ;
  let a = Math.abs((loadout.stepVelocityX - ol.stepVelocityX) | 0) | 0;
  let b = Math.abs((loadout.stepVelocityY - ol.stepVelocityY) | 0) | 0;
  let e = Math.abs(ol.stepVelocityZ) | 0;
  if (a < b) [a, b] = [b, a];
  if (a < e) [a, e] = [e, a];
  const sum = (Math.imul(a, 4) + b + e) | 0;
  const bounce = sum >> 2 < 0x20001 ? 0x10000 : sum >> 3;
  loadout.velocityX = mulr16(c.rayHitNormalX, bounce);
  loadout.velocityY = mulr16(c.rayHitNormalY, bounce);
  loadout.velocityZ = mulr16(c.rayHitNormalZ, bounce);
}

/**
 * Sphere pushout against every other mech, in mechTable order: touching
 * when the octagonal distance is under the two radii - or, without a
 * distance test, when a lower-indexed mech already recorded this one in its
 * blockedByMech this tick. The proposed position (in-out) is moved to
 * exactly touching and the mover bounces away along the normal. A
 * destroyed mech does not block: it is knocked down (mech_crash_to_ground)
 * and 0 is returned.
 *
 * @mw2 mech_collide_mechs 0x000200d0
 * @fidelity exact
 */
export function mechCollideMechs(loadout: MechLoadout, pos: { x: number; y: number; z: number }, outHitMech: Out<MechEntity | null>): number {
  const me = loadout.entity!.index;
  const radius = loadout.radius;
  const m = mechs;
  for (let i = 0; i < m.mechCount; i++) {
    const o = m.mechTable[i];
    if (!o || me === o.index) continue;
    const ol = o.loadout;
    if (!ol || ((ol.flags >> 8) & 1) !== 0) continue;
    if (me === o.blockedByMech && i < me) {
      if (ol.status === 4) {
        mechCrashToGround(ol);
        return 0;
      }
      outHitMech.v = o;
      pushOffMech(loadout, o, pos, (radius + ol.radius) | 0);
      return 1;
    }
    const reach = (radius + ol.radius) | 0;
    const d = octLength((pos.x - o.posX) | 0, (pos.y - o.posY) | 0, (pos.z - o.posZ) | 0);
    if (d < reach) {
      if (ol.status !== 4) {
        outHitMech.v = o;
        pushOffMech(loadout, o, pos, reach);
        return 1;
      }
      mechCrashToGround(ol);
      return 0;
    }
  }
  return 0;
}

/**
 * Sphere test against objectClass-6 world objects that are not mechs.
 * SOLID (any family but 0x50): pushed out to exactly touching, the normal
 * left in rayHitNormalX/Y/Z, the object in outHitObject, and velocity set
 * to n * k where - FROZEN BUG, 0x207fe..0x2081a - k is always -4, so the
 * mech simply stops. FAMILY 0x50 (destructible scenery): never blocks; a
 * moving mech knocks it over (falling_object_attach + falling_object_push at
 * twice its velocity). The sweep ends at the first 0x50 object touched.
 *
 * @mw2 mech_collide_obstacles 0x00020570
 * @fidelity partial
 * @divergence the knock-over sound (0xb5 at the object) is Phase 7
 */
export function mechCollideObstacles(loadout: MechLoadout, pos: { x: number; y: number; z: number }, outHitObject: Out<WorldObject | null>): number {
  const root = objectLists.worldRoot;
  if (!root) return 0;
  const c = collision;
  outHitObject.v = null;
  for (let o = root.worldNext; o; o = o.worldNext) {
    if (o.objectClass !== 6 || ((o.type >> 8) & 1) !== 0) continue;
    const dx = (pos.x - o.posX) | 0;
    const dy = (pos.y - o.posY) | 0;
    const dz = (pos.z - o.posZ) | 0;
    const reach = (o.radius + loadout.radius) | 0;
    const d = octLength(dx, dy, dz);
    if (!(d < reach)) continue;
    if ((o.type & 0xf0) !== 0x50) {
      if (d === 0) {
        c.rayHitNormalZ = 0x10000;
        c.rayHitNormalX = 0;
        c.rayHitNormalY = 0;
      } else {
        c.rayHitNormalX = sdivShl(dx, 16, d);
        c.rayHitNormalY = sdivShl(dy, 16, d);
        c.rayHitNormalZ = sdivShl(dz, 16, d);
      }
      pos.x = (o.posX + mulr16(c.rayHitNormalX, reach)) | 0;
      pos.y = (o.posY + mulr16(c.rayHitNormalY, reach)) | 0;
      pos.z = (o.posZ + mulr16(c.rayHitNormalZ, reach)) | 0;
      let k = -octLength(loadout.stepVelocityX, loadout.stepVelocityY, loadout.stepVelocityZ) >> 2;
      k = k < 9 ? -4 : -k >> 1;
      loadout.velocityX = mulr16(c.rayHitNormalX, k);
      loadout.velocityY = mulr16(c.rayHitNormalY, k);
      loadout.velocityZ = mulr16(c.rayHitNormalZ, k);
      outHitObject.v = o;
      return 1;
    }
    if (0 < octLength(loadout.velocityX, loadout.velocityY, loadout.velocityZ)) {
      const slot = fallingObjectAttach(o.node, 1);
      if (-1 < slot) {
        fallingObjectPush(slot, Math.imul(loadout.velocityX, 2), Math.imul(loadout.velocityY, 2), Math.imul(loadout.velocityZ, 2));
        divergence('mech_collide_obstacles: the knock-over sound 0xb5 is not played', 'mech_collide_obstacles');
        return 0;
      }
    }
    break;
  }
  return 0;
}

/**
 * One movement step of a mech from its entity position by (dx, dy, dz).
 * Only while status is 2 or 4; otherwise blockedSteps = 0 and 0 returned.
 * In order: mech_collide_mechs (a hit records blockedByMech, clears
 * outHitObject), mech_collide_obstacles (a hit leaves outHitObject
 * UNTOUCHED - the obstacle stays in a local), then a swept world ray
 * extended by a look-ahead of rideHeight * |uy| + radius * (1 - |uy|): a hit
 * puts the object in outHitObject, reflects the direction off the normal
 * (d = u - 2 (n.u) n), sets velocity = d * -(s / 4) with s the octagonal
 * stepVelocity, stops the look-ahead short of the surface and slides a
 * quarter of the leftover along d. A clean step sets outHitObject to null
 * and blockedSteps to 0. A zero step returns before any of that: 0 if
 * blockedSteps is 0, else blockedSteps + 1 (stored).
 *
 * outHitMech is written only by a mech hit: the other MechEntity (the C
 * stores the entity pointer; the caller reads entity->loadout at +0x20).
 * out holds the resulting position. Returns blockedSteps (0 = clean).
 *
 * @mw2 mech_move_step 0x0001fca0
 * @fidelity exact
 */
export function mechMoveStep(
  loadout: MechLoadout,
  hitObject: Out<WorldObject | null>,
  hitMech: Out<MechEntity | null>,
  dx: number,
  dy: number,
  dz: number,
  out: { x: number; y: number; z: number },
): number {
  const e = loadout.entity!;
  const oldX = e.posX;
  const oldY = e.posY;
  const oldZ = e.posZ;
  const wantX = (oldX + dx) | 0;
  const wantY = (dy + oldY) | 0;
  const wantZ = (oldZ + dz) | 0;
  out.x = wantX;
  out.y = wantY;
  out.z = wantZ;
  if (loadout.status !== 2 && loadout.status !== 4) {
    loadout.blockedSteps = 0;
    return 0;
  }
  let blocked = 0;
  if (mechCollideMechs(loadout, out, hitMech) !== 0) {
    e.blockedByMech = hitMech.v!.index;
    loadout.blockedSteps = (loadout.blockedSteps + 1) | 0;
    blocked = 1;
    hitObject.v = null;
  } else {
    const local: Out<WorldObject | null> = { v: null };
    if (mechCollideObstacles(loadout, out, local) !== 0) {
      blocked = 1;
      loadout.blockedSteps = (loadout.blockedSteps + 1) | 0;
    } else {
      if (dx === 0 && dy === 0 && dz === 0) {
        if (loadout.blockedSteps === 0) return 0;
        loadout.blockedSteps = (loadout.blockedSteps + 1) | 0;
        return loadout.blockedSteps;
      }
      const ray = new Ray();
      raySetPoints(ray, oldX, oldY, oldZ, wantX, wantY, wantZ);
      let stepLength = rayLength(ray);
      const uy = Math.abs(ray.unitY) | 0;
      const ahead = (mulr16(loadout.rideHeight, uy) + mulr16(loadout.radius, (0x10000 - uy) | 0)) | 0;
      raySetLength(ray, (stepLength + ahead) | 0);
      if (worldRaycastNoMechs(ray, local) !== 0) {
        blocked = 1;
        loadout.blockedSteps = (loadout.blockedSteps + 1) | 0;
        hitObject.v = local.v;
        const c = collision;
        const hit = local.v;
        if (c.rayHitNormalX === 0 && c.rayHitNormalY === 0 && c.rayHitNormalZ === 0 && hit) {
          const nr = new Ray();
          raySetPoints(nr, hit.posX, hit.posY, hit.posZ, ray.endX, ray.endY, ray.endZ);
          rayNormalise(nr);
          c.rayHitNormalX = nr.unitX;
          c.rayHitNormalY = nr.unitY;
          c.rayHitNormalZ = nr.unitZ;
        }
        const dot2 = (mulr16(Math.imul(c.rayHitNormalX, 2), ray.unitX) + mulr16(Math.imul(c.rayHitNormalY, 2), ray.unitY) + mulr16(Math.imul(c.rayHitNormalZ, 2), ray.unitZ)) | 0;
        const rx = (ray.unitX - mulr16(dot2, c.rayHitNormalX)) | 0;
        const ry = (ray.unitY - mulr16(dot2, c.rayHitNormalY)) | 0;
        const rz = (ray.unitZ - mulr16(dot2, c.rayHitNormalZ)) | 0;
        const k = -octLength(loadout.stepVelocityX, loadout.stepVelocityY, loadout.stepVelocityZ) >> 2;
        loadout.velocityX = mulr16(rx, k);
        loadout.velocityY = mulr16(ry, k);
        loadout.velocityZ = mulr16(rz, k);
        raySetLength(ray, (rayLength(ray) - ahead) | 0);
        stepLength = (stepLength - rayLength(ray)) | 0;
        if (stepLength < 1) {
          out.x = ray.endX;
          out.y = ray.endY;
        } else {
          out.x = (ray.endX + (mulr16(rx, stepLength) >> 2)) | 0;
          out.y = (ray.endY + (mulr16(ry, stepLength) >> 2)) | 0;
          ray.endZ = (ray.endZ + (mulr16(rz, stepLength) >> 2)) | 0;
        }
        out.z = ray.endZ;
      }
    }
  }
  if (blocked === 0) {
    loadout.blockedSteps = 0;
    hitObject.v = null;
  }
  return loadout.blockedSteps;
}
