/**
 * Ground quadtrees: an objectClass 5 mesh (terrain relief, the walkmesh)
 * gets a quadtree of its polygons at WorldObject.bounds (+0x44) for ground
 * height, point and ray queries.
 *
 * NODE: [0..5] minX maxX minY maxY minZ maxZ, [6] polygon count, [7..10] four
 * children, then the polygon pointers. A count of 0 is an internal node, a
 * leaf lists at most 25 polygons in mesh order. Children tile the parent in X
 * and Z with no overlap: quadrant bit 0 picks x in [min, mid] or
 * [mid + 1, max], bit 1 the same for z, mid = (min + max) >> 1.
 */
import { QuadtreeNode, Ray } from '../../generated/classes.gen.ts';
import type { MeshBlock, MeshPolygon, WorldObject } from '../../generated/classes.gen.ts';
import { rayCopy, rayLength, raySlabIntersect } from '../../engine/collision/ray.ts';
import { collision } from './collisionGlobals.ts';
import { polySurfaceHeight, polygonContainsPointXz, rayHitPolygon } from './meshQueries.ts';

/**
 * @mw2 terrain_alloc_quadtrees 0x0001d1e0
 * @fidelity exact
 * @divergence a JS object; the 'Not enough memory' path cannot happen
 */
export function terrainAllocQuadtrees(minX: number, maxX: number, minY: number, maxY: number, minZ: number, maxZ: number, count: number): QuadtreeNode {
  const n = new QuadtreeNode();
  n.minX = minX | 0;
  n.minY = minY | 0;
  n.maxY = maxY | 0;
  n.polyCount = count | 0;
  n.maxX = maxX | 0;
  n.minZ = minZ | 0;
  n.maxZ = maxZ | 0;
  n.children = [null, null, null, null];
  n.polys = new Array<MeshPolygon | null>(Math.max(0, count)).fill(null);
  return n;
}

/**
 * Does the polygon's X/Z box meet the cell? Then 1 and its Y extent.
 *
 * @mw2 poly_overlaps_cell_xz 0x0001d2a0
 * @fidelity exact
 */
export function polyOverlapsCellXz(poly: MeshPolygon, mesh: MeshBlock, x0: number, x1: number, z0: number, z1: number, out: { minY: number; maxY: number }): number {
  let maxY = -0x7fffffff;
  let maxZ = -0x7fffffff;
  let maxX = -0x7fffffff;
  let minZ = 0x7fffffff;
  let minY = 0x7fffffff;
  let minX = 0x7fffffff;
  for (let i = 0; i < poly.vertexCount; i++) {
    const v = mesh.vertices[poly.indices[i]!]!;
    if (v.worldX < minX) minX = v.worldX;
    if (v.worldY < minY) minY = v.worldY;
    if (v.worldZ < minZ) minZ = v.worldZ;
    if (maxX < v.worldX) maxX = v.worldX;
    if (maxY < v.worldY) maxY = v.worldY;
    if (maxZ < v.worldZ) maxZ = v.worldZ;
  }
  if (x1 < minX || maxX < x0 || z1 < minZ || maxZ < z0) return 0;
  out.minY = minY;
  out.maxY = maxY;
  return 1;
}

/**
 * One quadrant of a node: a leaf of the polygons overlapping it, or - as
 * soon as a 26th overlaps - an internal node subdivided again. An empty
 * cell gives no child.
 *
 * @mw2 quadtree_build_quadrant 0x0001cfe0
 * @fidelity exact
 */
export function quadtreeBuildQuadrant(parent: QuadtreeNode, quadrant: number, mesh: MeshBlock): QuadtreeNode | null {
  let x0: number, x1: number, z0: number, z1: number;
  if ((quadrant & 1) === 0) {
    x0 = parent.minX;
    x1 = (parent.maxX + x0) >> 1;
  } else {
    x0 = ((parent.maxX + parent.minX) >> 1) + 1;
    x1 = parent.maxX;
  }
  if ((quadrant & 2) === 0) {
    z0 = parent.minZ;
    z1 = (parent.maxZ + z0) >> 1;
  } else {
    z1 = parent.maxZ;
    z0 = ((parent.maxZ + parent.minZ) >> 1) + 1;
  }
  if (!(x0 < x1 && z0 < z1)) return null;
  let lo = 0x7fffffff;
  let hi = -0x7fffffff;
  const list: MeshPolygon[] = [];
  const span = { minY: 0, maxY: 0 };
  for (let i = 0; i < mesh.polygonCount; i++) {
    const p = mesh.polygons[i]!;
    if (polyOverlapsCellXz(p, mesh, x0, x1, z0, z1, span) === 0) continue;
    if (0x19 < list.length + 1) {
      let nlo = 0x7fffffff;
      let nhi = -0x7fffffff;
      const node = terrainAllocQuadtrees(x0, x1, 0x7fffffff, -0x7fffffff, z0, z1, 0);
      for (let q = 0; q < 4; q++) {
        const c = quadtreeBuildQuadrant(node, q, mesh);
        node.children[q] = c;
        if (c) {
          if (nhi < c.maxY) nhi = c.maxY;
          if (c.minY < nlo) nlo = c.minY;
        }
      }
      node.maxY = nhi;
      node.minY = nlo;
      if (nlo === 0x7fffffff) {
        node.maxY = 0;
        node.minY = 0;
      }
      return node;
    }
    if (hi < span.maxY) hi = span.maxY;
    if (span.minY < lo) lo = span.minY;
    list.push(p);
  }
  if (list.length === 0) {
    lo = 0;
    hi = 0;
  }
  const leaf = terrainAllocQuadtrees(x0, x1, lo, hi, z0, z1, list.length);
  for (let i = 0; i < list.length; i++) leaf.polys[i] = list[i]!;
  return leaf;
}

/**
 * Builds WorldObject.bounds for a walkmesh: a root sized to the head mesh's
 * vertices, then its four quadrants. Nothing while groundQuadtreesDisabled
 * or with no mesh.
 *
 * @mw2 object_build_ground_quadtree 0x0001cf10
 * @fidelity exact
 */
export function objectBuildGroundQuadtree(obj: WorldObject): void {
  const mesh = obj.meshList;
  if (collision.groundQuadtreesDisabled !== 0 || !mesh) return;
  const v0 = mesh.vertices[0]!;
  const root = terrainAllocQuadtrees(v0.worldX, v0.worldX, v0.worldY, v0.worldY, v0.worldZ, v0.worldZ, 0);
  obj.bounds = root;
  for (let i = 1; i < mesh.vertexCount; i++) {
    const v = mesh.vertices[i]!;
    if (root.maxX < v.worldX) root.maxX = v.worldX;
    if (v.worldX < root.minX) root.minX = v.worldX;
    if (root.maxZ < v.worldZ) root.maxZ = v.worldZ;
    if (v.worldZ < root.minZ) root.minZ = v.worldZ;
    if (root.maxY < v.worldY) root.maxY = v.worldY;
    if (v.worldY < root.minY) root.minY = v.worldY;
  }
  for (let q = 0; q < 4; q++) root.children[q] = quadtreeBuildQuadrant(root, q, mesh);
}

/**
 * The height of the first upward-facing polygon containing (x, z) in the
 * leaf under it. Inside the tree's X/Z box with no such polygon the height
 * is 0 and the answer still 1.
 *
 * @mw2 quadtree_ground_height 0x0001d6b0
 * @fidelity exact
 */
export function quadtreeGroundHeight(node: QuadtreeNode | null, mesh: MeshBlock, x: number, y: number, z: number, out: { v: number }): number {
  if (!node) return 0;
  if (x < node.minX || node.maxX < x || z < node.minZ || node.maxZ < z) return 0;
  if (node.polyCount === 0) {
    for (let q = 0; q < 4; q++) if (quadtreeGroundHeight(node.children[q]!, mesh, x, y, z, out) !== 0) return 1;
  } else {
    for (let i = 0; i < node.polyCount; i++) {
      const p = node.polys[i]!;
      if (0 < p.normalY && polygonContainsPointXz(p, mesh.vertices, x, z) !== 0) {
        polySurfaceHeight(p, mesh.vertices, x, y, z, out);
        return 1;
      }
    }
  }
  out.v = 0;
  return 1;
}

/**
 * 0 outside the tree's X/Z box, 3 below the surface (or below a node's Y
 * range), 2 otherwise.
 *
 * @mw2 quadtree_point_below 0x0001d370
 * @fidelity exact
 */
export function quadtreePointBelow(node: QuadtreeNode | null, mesh: MeshBlock, x: number, y: number, z: number): number {
  if (!node) return 0;
  if (x < node.minX || node.maxX < x || z < node.minZ || node.maxZ < z) return 0;
  if (y <= node.maxY) {
    if (y < node.minY) return 3;
    if (node.polyCount === 0) {
      for (let q = 0; q < 4; q++) {
        const r = quadtreePointBelow(node.children[q]!, mesh, x, y, z);
        if (r !== 0) return r;
      }
    } else {
      const out = { v: 0 };
      for (let i = 0; i < node.polyCount; i++) {
        const p = node.polys[i]!;
        if (0 < p.normalY && polygonContainsPointXz(p, mesh.vertices, x, z) !== 0) {
          if (polySurfaceHeight(p, mesh.vertices, x, y, z, out)) return 3;
          break;
        }
      }
    }
  }
  return 2;
}

/**
 * Ray against a ground quadtree: slab-clipped node by node, the leaf's
 * polygons tried in order (the first hit clips the ray and wins).
 *
 * @mw2 quadtree_raycast 0x0001d4d0
 * @fidelity exact
 */
export function quadtreeRaycast(node: QuadtreeNode | null, mesh: MeshBlock, ray: Ray): number {
  if (!node) return 0;
  const a = { near: 0, far: 0 };
  const b = { near: 0, far: 0 };
  if (raySlabIntersect(ray.startX, ray.unitX, node.minX, node.maxX, a) !== 0) return 0;
  if (raySlabIntersect(ray.startY, ray.unitY, node.minY, node.maxY, b) !== 0) return 0;
  if (a.near < b.near) a.near = b.near;
  if (b.far < a.far) a.far = b.far;
  if (raySlabIntersect(ray.startZ, ray.unitZ, node.minZ, node.maxZ, b) !== 0) return 0;
  if (a.near < b.near) a.near = b.near;
  if (b.far < a.far) a.far = b.far;
  if (!(a.near <= a.far)) return 0;
  if (a.near < 0) a.near = 0;
  const len = rayLength(ray);
  if (len < a.far) a.far = len;
  if (!(a.near <= a.far)) return 0;
  if (node.polyCount === 0) return quadtreeRaycastChildren(node, mesh, ray) ? 1 : 0;
  for (let i = 0; i < node.polyCount; i++) if (rayHitPolygon(node.polys[i]!, mesh.vertices, ray) !== 0) return 1;
  return 0;
}

/**
 * All four children, each on a fresh copy of the ray; the shortest clipped
 * ray is copied back.
 *
 * @mw2 quadtree_raycast_children 0x0001d610
 * @fidelity exact
 */
export function quadtreeRaycastChildren(node: QuadtreeNode, mesh: MeshBlock, ray: Ray): boolean {
  let best = 0x7fffffff;
  const trial = new Ray();
  const winner = new Ray();
  rayCopy(trial, ray);
  for (let q = 0; q < 4; q++) {
    if (quadtreeRaycast(node.children[q]!, mesh, trial) !== 0) {
      const l = rayLength(trial);
      if (l < best) {
        best = l;
        rayCopy(winner, trial);
      }
      rayCopy(trial, ray);
    }
  }
  const hit = best < 0x7fffffff;
  if (hit) rayCopy(ray, winner);
  return hit;
}

/**
 * Frees a ground quadtree.
 *
 * @mw2 quadtree_free 0x0001d270
 * @fidelity exact
 * @divergence nothing to free in JS; kept so object_free_bounds' class-5 branch has its callee
 */
export function quadtreeFree(_node: QuadtreeNode | null): void {}
