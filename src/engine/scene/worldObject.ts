/**
 * World objects and their meshes: construction from WTBO records (the build
 * half of poly_load_wtbo_record - see wtboLoader.ts), face normals, bounds,
 * and the model-to-world transform.
 *
 * Representation (tools/struct-overrides.ts): a MeshBlock's vertices and
 * polygons are JS arrays and a polygon's vertex-index bytes are
 * MeshPolygon.indices. object_add_mesh's size arithmetic (0x18 + vertices *
 * 0x2c + polygons * 0x24 + index bytes) therefore has nothing to allocate;
 * polygonOffset is still computed and stored because readers treat it as data.
 */

import { MeshBlock, MeshPolygon, MeshVertex, WorldObject } from '../../generated/classes.gen.ts';
import { dot3r29 } from '../../core/int/i64.ts';
import { registerGlobals } from '../globals.ts';
import { imageI32 } from '../image.ts';
import { objectAddToWorld, objectRemoveFromWorld, objectUnlink } from './objectLists.ts';
import { sceneNodeSetUserdata } from './sceneGraph.ts';

export const objectGlobals = registerGlobals(
  'objects',
  {
    /** 0x96ea0: OR'd (with 0x8000) into every new object's flags; 0 in the image and never seen written */
    objectCreateFlags: 0,
  },
  () => {
    objectGlobals.objectCreateFlags = imageI32(0x96ea0, 0);
  },
);

/** sqrtTable (0xfe9e4): trunc(sqrt(i) * 1024) for i < 1024, as ushorts. */
export const sqrtTable = new Uint16Array(0x400);

/**
 * @mw2 sqrt_table_build 0x0003aba0
 * @fidelity exact
 */
export function sqrtTableBuild(): number {
  for (let i = 0; i < 0x400; i++) sqrtTable[i] = Math.trunc(Math.sqrt(i) * 1024.0);
  return 1;
}
sqrtTableBuild();

/**
 * Allocates a WorldObject with one mesh block of the given capacity.
 * objectClass starts at 4 (scene tree only, off the world chain).
 *
 * @mw2 object_create 0x00038490
 * @fidelity exact
 */
export function objectCreate(vertexCount: number, polygonCount: number): WorldObject | null {
  const obj = new WorldObject();
  obj.meshList = null;
  obj.flags = (objectGlobals.objectCreateFlags | 0x8000) & 0xffff;
  obj.currentMesh = null;
  obj.node = null;
  if (!objectAddMesh(obj, 0, vertexCount, polygonCount)) return null;
  obj.type = 0;
  obj.hitLocation = 0;
  obj.index = 0;
  obj.posX = obj.posY = obj.posZ = 0;
  obj.localX = obj.localY = obj.localZ = 0;
  obj.radius = 0;
  obj.bounds = null;
  obj.listPrev = obj.listNext = null;
  obj.worldPrev = obj.worldNext = null;
  obj.objectClass = 4;
  obj.transformVersion = 0;
  return obj;
}

/**
 * Adds a mesh block, makes it currentMesh, and links it into meshList in
 * ascending lodKey order (after the last entry whose key is <= lodKey).
 *
 * @mw2 object_add_mesh 0x00038310
 * @fidelity exact
 */
export function objectAddMesh(obj: WorldObject | null, lodKey: number, vertexCount: number, _polygonCount: number): MeshBlock | null {
  if (!obj) return null;
  const m = new MeshBlock();
  m.lodKey = lodKey | 0;
  m.vertexCount = 0;
  m.polygonCount = 0;
  m.polygonOffset = (vertexCount * 0x2c + 0x18) & 0xffff;
  m.transformVersion = 0;
  m.field_0x14 = 0;
  obj.currentMesh = m;
  const head = obj.meshList;
  if (!head) {
    obj.meshList = m;
    m.next = null;
  } else if (lodKey < head.lodKey) {
    m.next = head;
    obj.meshList = m;
  } else {
    let prev = head;
    while (prev.next && prev.next.lodKey <= lodKey) prev = prev.next;
    m.next = prev.next;
    prev.next = m;
  }
  return m;
}

/**
 * @mw2 object_set_mesh_key 0x00038440
 * @fidelity exact
 */
export function objectSetMeshKey(obj: WorldObject, key: number): void {
  if (obj.currentMesh) obj.currentMesh.lodKey = key | 0;
}

/**
 * @mw2 mesh_add_vertex 0x00038560
 * @fidelity exact
 */
export function meshAddVertex(obj: WorldObject, x: number, y: number, z: number, texU: number, texV: number): void {
  const m = obj.currentMesh;
  if (!m) return;
  const v = new MeshVertex();
  v.modelX = v.worldX = x | 0;
  v.modelY = v.worldY = y | 0;
  v.modelZ = v.worldZ = z | 0;
  v.texU = texU | 0;
  v.texV = texV | 0;
  m.vertices[m.vertexCount] = v;
  m.vertexCount = (m.vertexCount + 1) << 16 >> 16;
}

/**
 * @mw2 mesh_add_polygon 0x000385b0
 * @fidelity exact
 * @divergence indexOffset is left 0; the index bytes are MeshPolygon.indices
 */
export function meshAddPolygon(obj: WorldObject, code: number): MeshPolygon | null {
  const m = obj.currentMesh;
  if (!m) return null;
  const p = new MeshPolygon();
  p.vertexCount = 0;
  p.owner = obj;
  p.code = code & 0xffff;
  m.polygons[m.polygonCount] = p;
  m.polygonCount = (m.polygonCount + 1) << 16 >> 16;
  return p;
}

/**
 * Appends one vertex index, TRUNCATED TO A BYTE as the original stores it.
 *
 * @mw2 poly_add_index 0x00038610
 * @fidelity exact
 */
export function polyAddIndex(obj: WorldObject, poly: MeshPolygon, index: number): void {
  if (!obj.currentMesh) return;
  poly.indices[poly.vertexCount] = index & 0xff;
  poly.vertexCount = (poly.vertexCount + 1) & 0xffff;
}

/**
 * Unit normal of three points at the 2.29 scale: the NEGATED cross product
 * -((v1 - v0) x (v2 - v1)), normalised through sqrtTable. Read from the
 * disassembly (0x3a4b9..0x3a70b): 64-bit cross product; shift so the
 * largest magnitude's top bit lands on bit 29; sum the squares of each
 * component's top 16 bits; sqrtTable[(sum >> 16) >> 4] is the length;
 * each output is -((c << 13) / length). Degenerate: (-1, -1, -1), returns 0.
 * Returns the shift exponent + 0x1d as a signed short.
 *
 * @mw2 triangle_normal 0x0003a4b9
 * @fidelity exact
 */
export function triangleNormal(ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number, out: Int32Array | number[]): number {
  const d = (p: number, q: number): bigint => BigInt((p - q) | 0);
  const N = [
    BigInt.asIntN(64, d(by, ay) * d(cz, bz) - d(cy, by) * d(bz, az)),
    BigInt.asIntN(64, d(bz, az) * d(cx, bx) - d(cz, bz) * d(bx, ax)),
    BigInt.asIntN(64, d(bx, ax) * d(cy, by) - d(cx, bx) * d(by, ay)),
  ];
  let orLo = 0n;
  let orHi = 0n;
  for (const n of N) {
    const a = BigInt.asUintN(64, n < 0n ? -n : n);
    orLo |= a & 0xffffffffn;
    orHi |= a >> 32n;
  }
  const low32 = (v: bigint): number => Number(BigInt.asIntN(32, v));
  const comp = [0, 0, 0];
  let ret: number;
  if (orHi !== 0n) {
    const p = orHi.toString(2).length - 1;
    const cl = p + 3;
    for (let i = 0; i < 3; i++) comp[i] = low32(N[i]! >> BigInt(cl & 31));
    ret = cl + 0x1d;
  } else if (orLo === 0n) {
    out[0] = out[1] = out[2] = -1;
    return 0;
  } else {
    const p = orLo.toString(2).length - 1;
    const c = 29 - p;
    if (c === 0) {
      for (let i = 0; i < 3; i++) comp[i] = low32(N[i]!);
      ret = 0x1d;
    } else if (c > 0) {
      for (let i = 0; i < 3; i++) comp[i] = low32(N[i]!) << (c & 31);
      ret = 0x1d - c;
    } else {
      for (let i = 0; i < 3; i++) comp[i] = low32(N[i]! >> BigInt(-c & 31));
      ret = -c + 0x1d;
    }
  }
  let sum = 0;
  for (let i = 0; i < 3; i++) {
    const s = comp[i]! >> 16;
    sum = (sum + Math.imul(s, s)) | 0;
  }
  const len = sqrtTable[(((sum >>> 16) & 0xffff) >>> 4)]!;
  for (let i = 0; i < 3; i++) out[i] = -Math.trunc((comp[i]! * 8192) / len) | 0;
  return (ret << 16) >> 16;
}

function octagonalLength(dx: number, dy: number, dz: number): number {
  let a = dx < 0 ? -dx : dx;
  let b = dy < 0 ? -dy : dy;
  let c = dz < 0 ? -dz : dz;
  let hi = a;
  if (a < b) {
    hi = b;
    b = a;
  }
  a = hi;
  if (hi < c) {
    a = c;
    c = hi;
  }
  return (a * 4 + b + c) >> 2;
}

/**
 * One polygon's normal from its vertices' model positions. Triangles go
 * straight to triangle_normal; larger polygons take the longest edge (by
 * octagonal length, walked backwards from (v0, v[n-1]), first maximum wins)
 * and try each other vertex, keeping the result with the largest return
 * and stopping once a return reaches 0x11. 1- and 2-gons keep +X.
 *
 * @mw2 poly_compute_normal 0x000380a0
 * @fidelity exact
 */
export function polyComputeNormal(poly: MeshPolygon, vertices: MeshVertex[]): void {
  poly.normalX = poly.modelNormalX = 0x20000000;
  poly.normalY = poly.modelNormalY = 0;
  poly.normalZ = poly.modelNormalZ = 0;
  const n = poly.vertexCount;
  if (n <= 2) return;
  const v = (k: number): MeshVertex => vertices[poly.indices[k]!]!;
  const out = [0, 0, 0];
  const store = () => {
    poly.normalX = poly.modelNormalX = out[0]!;
    poly.normalY = poly.modelNormalY = out[1]!;
    poly.normalZ = poly.modelNormalZ = out[2]!;
  };
  if (n === 3) {
    const a = v(0);
    const b = v(1);
    const c = v(2);
    triangleNormal(a.modelX, a.modelY, a.modelZ, b.modelX, b.modelY, b.modelZ, c.modelX, c.modelY, c.modelZ, out);
    store();
    return;
  }
  let best = 0;
  let A: MeshVertex | null = null; // local_28: the later vertex of the longest edge
  let B: MeshVertex | null = null; // local_24: the earlier vertex
  let cur = v(0);
  for (let k = n - 1; k >= 0; k--) {
    const nxt = v(k);
    const len = octagonalLength((cur.modelX - nxt.modelX) | 0, (cur.modelY - nxt.modelY) | 0, (cur.modelZ - nxt.modelZ) | 0);
    if (best < len) {
      best = len;
      A = cur;
      B = nxt;
    }
    cur = nxt;
  }
  if (best === 0 || !A || !B) return;
  let bestRet = -1;
  let k = n;
  let ret: number;
  do {
    let C: MeshVertex;
    do {
      k--;
      if (k === -1) return;
      C = v(k);
    } while (C === B || C === A);
    ret = triangleNormal(B.modelX, B.modelY, B.modelZ, A.modelX, A.modelY, A.modelZ, C.modelX, C.modelY, C.modelZ, out);
    if (bestRet < ret) {
      store();
      bestRet = ret;
    }
  } while (ret < 0x11);
}

/**
 * Object centre = midpoint of the head mesh's vertex box (into both local and
 * pos), radius = trunc(sqrt(max squared distance from it)) - exact Euclidean.
 *
 * @mw2 mesh_compute_bounds 0x00037f60
 * @fidelity exact
 */
export function meshComputeBounds(obj: WorldObject): void {
  const m = obj.meshList;
  if (!m || m.vertexCount <= 0) return;
  const vs = m.vertices;
  let minX = vs[m.vertexCount - 1]!.worldX;
  let minY = vs[m.vertexCount - 1]!.worldY;
  let minZ = vs[m.vertexCount - 1]!.worldZ;
  let maxX = minX;
  let maxY = minY;
  let maxZ = minZ;
  for (let i = m.vertexCount - 2; i >= 0; i--) {
    const p = vs[i]!;
    if (p.worldX < minX) minX = p.worldX;
    if (p.worldY < minY) minY = p.worldY;
    if (p.worldZ < minZ) minZ = p.worldZ;
    if (maxX < p.worldX) maxX = p.worldX;
    if (maxY < p.worldY) maxY = p.worldY;
    if (maxZ < p.worldZ) maxZ = p.worldZ;
  }
  obj.posX = obj.localX = ((maxX + minX) | 0) >> 1;
  obj.posY = obj.localY = ((maxY + minY) | 0) >> 1;
  obj.posZ = obj.localZ = ((maxZ + minZ) | 0) >> 1;
  let far = 0;
  for (let i = m.vertexCount - 1; i >= 0; i--) {
    const p = vs[i]!;
    const dx = (p.worldX - obj.posX) | 0;
    const dy = (p.worldY - obj.posY) | 0;
    const dz = (p.worldZ - obj.posZ) | 0;
    const d = dz * dz + dy * dy + dx * dx;
    if (far < d) far = d;
  }
  obj.radius = Math.trunc(Math.sqrt(far)) | 0;
}

/**
 * @mw2 mesh_finish 0x000387a0
 * @fidelity exact
 */
export function meshFinish(obj: WorldObject): void {
  const m = obj.currentMesh;
  if (!m) return;
  for (let i = m.polygonCount - 1; i >= 0; i--) polyComputeNormal(m.polygons[i]!, m.vertices);
  meshComputeBounds(obj);
}

/**
 * @mw2 object_set_state_flags 0x000386d0
 * @fidelity exact
 */
export function objectSetStateFlags(obj: WorldObject, value: number): void {
  obj.flags = ((value & 0x7ef0) | (obj.flags & 0x810f) | 0x8000) & 0xffff;
}

/**
 * @mw2 object_get_state_flags 0x000386f0
 * @fidelity exact
 */
export function objectGetStateFlags(obj: WorldObject): number {
  return obj.flags & 0x7ef0;
}

/**
 * @mw2 object_set_type 0x00038710
 * @fidelity exact
 */
export function objectSetType(obj: WorldObject, type: number): void {
  obj.type = type & 0xffff;
}

/**
 * @mw2 object_set_hit_location 0x00038720
 * @fidelity exact
 */
export function objectSetHitLocation(obj: WorldObject, loc: number): void {
  obj.hitLocation = loc & 0xffff;
}

/**
 * @mw2 object_set_index 0x00038730
 * @fidelity exact
 */
export function objectSetIndex(obj: WorldObject, index: number): void {
  obj.index = index & 0xffff;
}

/**
 * @mw2 object_get_pos_radius 0x00038770
 * @fidelity exact
 */
export function objectGetPosRadius(obj: WorldObject): { x: number; y: number; z: number; radius: number } {
  return { x: obj.posX, y: obj.posY, z: obj.posZ, radius: obj.radius };
}

/**
 * @mw2 object_get_node 0x00038980
 * @fidelity exact
 */
export function objectGetNode(obj: WorldObject): WorldObject['node'] {
  return obj.node;
}

/**
 * @mw2 object_set_node 0x00038990
 * @fidelity exact
 */
export function objectSetNode(obj: WorldObject, node: WorldObject['node']): void {
  obj.node = node;
}

/**
 * flags = (value & 0x10f) | (flags & 0xfef0) | 0x8000.
 *
 * @mw2 object_apply_load_flags 0x000389c0
 * @fidelity exact
 */
export function objectApplyLoadFlags(obj: WorldObject, value: number): void {
  obj.flags = ((value & 0x10f) | (obj.flags & 0xfef0) | 0x8000) & 0xffff;
}

/**
 * Sets objectClass and makes world-chain membership agree: class 4 leaves
 * the chain, every other class joins it.
 *
 * @mw2 object_set_class 0x0001c070
 * @fidelity exact
 */
export function objectSetClass(obj: WorldObject, objectClass: number): void {
  obj.objectClass = objectClass | 0;
  if (objectClass === 4) objectRemoveFromWorld(obj);
  else objectAddToWorld(obj);
}

/**
 * @mw2 object_free_bounds 0x0001eb00
 * @fidelity exact
 * @divergence nothing to free; the reference is dropped
 */
export function objectFreeBounds(obj: WorldObject | null): void {
  if (obj && obj.bounds) obj.bounds = null;
}

/**
 * @mw2 object_free 0x000386a0
 * @fidelity exact
 * @divergence releases references for the garbage collector
 */
export function objectFree(obj: WorldObject): void {
  obj.meshList = null;
  obj.currentMesh = null;
  objectFreeBounds(obj);
}

/**
 * Clears the node's back-pointer, unlinks and frees.
 *
 * @mw2 object_destroy 0x00038a20
 * @fidelity exact
 */
export function objectDestroy(obj: WorldObject): void {
  if (obj.node) sceneNodeSetUserdata(obj.node, null);
  objectUnlink(obj);
  objectFree(obj);
}

/**
 * Model positions -> world positions (rotated and translated) and model
 * normals -> world normals (rotated only), by a 12-int 2.29 transform.
 *
 * @mw2 mesh_transform_to_world 0x0003a188
 * @fidelity exact
 */
export function meshTransformToWorld(mesh: MeshBlock, t: Int32Array): void {
  const t0 = t[0]!, t1 = t[1]!, t2 = t[2]!, t3 = t[3]!, t4 = t[4]!, t5 = t[5]!, t6 = t[6]!, t7 = t[7]!, t8 = t[8]!;
  for (let i = 0; i < mesh.vertexCount; i++) {
    const v = mesh.vertices[i]!;
    v.worldX = (dot3r29(t0, v.modelX, t1, v.modelY, t2, v.modelZ) + t[9]!) | 0;
    v.worldY = (dot3r29(t3, v.modelX, t4, v.modelY, t5, v.modelZ) + t[10]!) | 0;
    v.worldZ = (dot3r29(t6, v.modelX, t7, v.modelY, t8, v.modelZ) + t[11]!) | 0;
  }
  for (let i = 0; i < mesh.polygonCount; i++) {
    const p = mesh.polygons[i]!;
    p.normalX = dot3r29(t0, p.modelNormalX, t1, p.modelNormalY, t2, p.modelNormalZ);
    p.normalY = dot3r29(t3, p.modelNormalX, t4, p.modelNormalY, t5, p.modelNormalZ);
    p.normalZ = dot3r29(t6, p.modelNormalX, t7, p.modelNormalY, t8, p.modelNormalZ);
  }
}

/**
 * pos = transform(local); clears bounds-valid (0x0200); bumps transformVersion.
 *
 * @mw2 object_update_world_pos 0x0003a2d4
 * @fidelity exact
 */
export function objectUpdateWorldPos(obj: WorldObject, t: Int32Array): void {
  obj.flags &= 0xfdff;
  const x = obj.localX, y = obj.localY, z = obj.localZ;
  obj.posX = (dot3r29(t[0]!, x, t[1]!, y, t[2]!, z) + t[9]!) | 0;
  obj.posY = (dot3r29(t[3]!, x, t[4]!, y, t[5]!, z) + t[10]!) | 0;
  obj.posZ = (dot3r29(t[6]!, x, t[7]!, y, t[8]!, z) + t[11]!) | 0;
  obj.transformVersion = (obj.transformVersion + 1) | 0;
}

/**
 * Eager transform: position and every mesh block, stamped current.
 *
 * @mw2 object_transform_now 0x0003a375
 * @fidelity exact
 */
export function objectTransformNow(obj: WorldObject, t: Int32Array): void {
  objectUpdateWorldPos(obj, t);
  for (let m = obj.meshList; m; m = m.next) {
    meshTransformToWorld(m, t);
    m.transformVersion = obj.transformVersion;
  }
}

/**
 * Lazy transform of currentMesh through the node's world block.
 *
 * @mw2 object_refresh_mesh 0x0001e180
 * @fidelity exact
 */
export function objectRefreshMesh(obj: WorldObject): void {
  const m = obj.currentMesh;
  if (!m || !obj.node) return;
  meshTransformToWorld(m, obj.node.worldBlock);
  m.transformVersion = obj.transformVersion;
}
