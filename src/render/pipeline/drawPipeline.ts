/**
 * The main view's object walk down to each polygon's depth key - the part
 * of the original draw that decides WHAT is drawn and AT WHAT DEPTH, which
 * is also what the shading reads:
 *
 *   render_object_list      per object: objectCullHook, then polySortFlags =
 *                           the object's flags, then object_draw_lod_mesh
 *   object_cull_main_view   objectViewDepth = the object's view depth, cm
 *   object_draw_lod_mesh    the LOD mesh from objectViewDepth; per-frame
 *                           vertex state reset; every polygon to the clipper
 *   poly_clip_and_queue     per polygon: back-face cull, per-vertex view
 *                           depth (4 x cm), near/far outcodes, trivial
 *                           reject, near-plane clip, the depth key (max, min
 *                           or mean of the clipped vertices per
 *                           polySortFlags) - which is the depth
 *                           polygon_resolve_colour dims by
 *
 * The rasterising half (projection, screen outcodes, the painter's sort) is
 * the GPU's; see SceneRenderer.
 */
import type { MeshBlock, MeshPolygon, MeshVertex, WorldObject } from '../../generated/classes.gen.ts';
import { Acc64, imul64, regHi, regLo } from '../../core/int/i64.ts';
import { renderView } from './viewLatch.ts';

const acc = new Acc64();

/**
 * The main 3D view's object cull. With cockpitViewActive, objects of type
 * family 0xa0 are rejected (1). Then the bounding sphere against the far
 * clip - the viewer's +0xb4 copy, plus the radius - as a sphere test on
 * squared distance (5 when beyond; the 64-bit compare falls through when
 * the difference's low dword is 0, as the code tests only that dword). Then
 * the view depth along the depth row, >> 29 rounded, into objectViewDepth;
 * 4 when depth + radius is nearer than the near clip. 0 = draw.
 *
 * @mw2 object_cull_main_view 0x0003f500
 * @fidelity partial
 * @divergence the lateral tests after 0x3f62a (against rotation rows 0 and 1) are not read upstream; objects to the side of the view are returned 0 and left to the GPU's frustum clip, which does not change what is visible
 */
export function objectCullMainView(obj: WorldObject): number {
  const r = renderView;
  if (r.cockpitViewActive !== 0 && (obj.type & 0xf0) === 0xa0) return 1;
  const dx = (obj.posX - r.viewTranslationX) | 0;
  const dy = (obj.posY - r.viewTranslationY) | 0;
  const dz = (obj.posZ - r.viewTranslationZ) | 0;
  const far = (r.viewer!.field_0xb4 + obj.radius) | 0;
  const sum = BigInt(dx) * BigInt(dx) + BigInt(dy) * BigInt(dy) + BigInt(dz) * BigInt(dz);
  const diff = BigInt.asUintN(64, sum - BigInt(far) * BigInt(far));
  // sub/sbb then jae: no borrow (sum >= far^2 unsigned) is "beyond" unless the low dword is 0
  if (BigInt.asUintN(64, sum) >= BigInt.asUintN(64, BigInt(far) * BigInt(far)) && (diff & 0xffffffffn) !== 0n) return 5;
  const depth = acc.clear().mulAdd(dx, r.cullDepthRowX).mulAdd(dy, r.cullDepthRowY).mulAdd(dz, r.cullDepthRowZ).shr29r();
  r.objectViewDepth = depth;
  if (((depth + obj.radius) | 0) < r.viewNearClip) return 4;
  return 0;
}

/**
 * The backdrop pass's object cull, the hook the frame render installs at
 * 0x3f780 while it draws backdropNode's tree (disassembly 0x3f780..0x3f835):
 * 1 for an object with flags bit 0x1000 (the alt-list bit); then the view
 * depth along the depth row, >> 29 rounded, into objectViewDepth, and 4 when
 * depth + radius is nearer than the near clip; 0 = draw. Unlike
 * object_cull_main_view there is no far-sphere test and no cockpit check -
 * the pass runs with the far clip lifted.
 *
 * @portOnly the cull hook at 0x3f780, reached only through objectCullHook and unnamed upstream
 * @divergence the lateral tests after 0x3f835 are not read; objects to the side are left to the GPU's frustum clip
 */
export function objectCullBackdrop(obj: WorldObject): number {
  const r = renderView;
  if ((obj.flags & 0x1000) !== 0) return 1;
  const dx = (obj.posX - r.viewTranslationX) | 0;
  const dy = (obj.posY - r.viewTranslationY) | 0;
  const dz = (obj.posZ - r.viewTranslationZ) | 0;
  const depth = acc.clear().mulAdd(dx, r.cullDepthRowX).mulAdd(dy, r.cullDepthRowY).mulAdd(dz, r.cullDepthRowZ).shr29r();
  r.objectViewDepth = depth;
  if (((depth + obj.radius) | 0) < r.viewNearClip) return 4;
  return 0;
}

/** (lodScale * lodKey) >> 16, rounded by bit 15 - object_draw_lod_mesh's threshold. */
function lodThreshold(lodScale: number, lodKey: number): number {
  imul64(lodScale, lodKey);
  const lo = regLo();
  return (((lo >>> 16) | (regHi() << 16)) + ((lo >>> 15) & 1)) | 0;
}

/**
 * The LOD choice: meshList is sorted by lodKey, finest first; the walk keeps
 * advancing while lodKey * lodScale is within viewDepth and the last mesh it
 * reached is used (the head when even that one is beyond). A head with lodKey
 * 0 is used as it is, without walking. Makes it currentMesh and refreshes it
 * when the object has moved since.
 *
 * @mw2 object_draw_lod_mesh 0x0003cda0
 * @fidelity partial
 * @divergence split in two: this is the selection half; meshResetClipState and polyDepthKey are the draw half, run by SceneRenderer per polygon; the frameHasRoom / draw-list budget is not modelled
 */
export function objectSelectLodMesh(obj: WorldObject, viewDepth: number, refresh: (o: WorldObject) => void): MeshBlock | null {
  const head = obj.meshList;
  if (!head) return null;
  let chosen: MeshBlock = head;
  if (head.lodKey !== 0) {
    const lodScale = renderView.viewer!.lodScale;
    for (let m: MeshBlock | null = head; m && lodThreshold(lodScale, m.lodKey) <= viewDepth; m = m.next) chosen = m;
  }
  obj.currentMesh = chosen;
  if (obj.transformVersion !== chosen.transformVersion) refresh(obj);
  return chosen;
}

/**
 * object_draw_lod_mesh's per-frame reset before the clipper runs: every
 * vertex's clip record dropped and its "view depth computed" bit (4) cleared.
 *
 * @portOnly the vertex loop of object_draw_lod_mesh (0x3cda0), split out as the draw half
 */
export function meshResetClipState(m: MeshBlock): void {
  for (let i = 0; i < m.vertexCount; i++) {
    const v = m.vertices[i]!;
    v.clipRecord = null;
    v.flags &= ~4;
  }
}

/** Once a frame per vertex: view depth (4 x cm) and near (1) / far (2) outcode, with bit 4 marking it done. */
function vertexViewDepth(v: MeshVertex): void {
  if ((v.flags & 4) !== 0) return;
  const r = renderView;
  const d = acc
    .clear()
    .mulAdd(r.viewDepthRowY, (v.worldY - r.viewTranslationY) | 0)
    .mulAdd(r.viewDepthRowX, (v.worldX - r.viewTranslationX) | 0)
    .mulAdd(r.viewDepthRowZ, (v.worldZ - r.viewTranslationZ) | 0)
    .shr27r();
  v.viewDepth = d;
  v.flags |= 4;
  let out = d < r.viewNearClipScaled ? 1 : 0;
  if (r.viewFarClipScaled < d) out |= 2;
  v.flags = (v.flags & ~3) | out;
}

/**
 * One clip record of the polygon being clipped: a mesh vertex in front of
 * the near plane (b null), or the point where edge a-b crosses it. For a
 * crossing, a is the NEARER endpoint - clip_vertex_at_near_plane always
 * interpolates from it, so the result does not depend on the edge's
 * direction - and the point is a + (b - a) * num / den, with num = near -
 * depth(a) and den = depth(b) - depth(a) (a 64-bit product and a truncating
 * divide per component); its depth is exactly viewNearClipScaled.
 */
export interface ClipRecord {
  a: MeshVertex;
  b: MeshVertex | null;
  num: number;
  den: number;
}

/** The records of the last polygon polyDepthKey queued, in Sutherland-Hodgman order; clipRecordCount of them are live. */
export const clipRecords: ClipRecord[] = [];
export let clipRecordCount = 0;

function pushVertex(v: MeshVertex): void {
  const rec = (clipRecords[clipRecordCount] ??= { a: v, b: null, num: 0, den: 1 });
  rec.a = v;
  rec.b = null;
  clipRecordCount++;
}

/** clip_vertex_at_near_plane(a, b): the crossing, measured from the nearer endpoint. */
function pushCrossing(a: MeshVertex, b: MeshVertex): void {
  const near = renderView.viewNearClipScaled;
  const [n, f] = a.viewDepth < b.viewDepth ? [a, b] : [b, a];
  const rec = (clipRecords[clipRecordCount] ??= { a: n, b: f, num: 0, den: 1 });
  rec.a = n;
  rec.b = f;
  rec.num = (near - n.viewDepth) | 0;
  rec.den = (f.viewDepth - n.viewDepth) | 0;
  clipRecordCount++;
}

/**
 * One component of a crossing record: a + (b - a) * num / den, the product
 * in 64 bits and the divide truncating, as clip_vertex_at_near_plane does
 * for viewX, viewY, texU and texV (den 0 leaves a's value).
 *
 * @portOnly the per-component arithmetic of clip_vertex_at_near_plane (0x3de4e)
 */
export function clipLerp(a: number, b: number, num: number, den: number): number {
  if (den === 0) return a;
  return (Number((BigInt((b - a) | 0) * BigInt(num)) / BigInt(den)) + a) | 0;
}

/**
 * One polygon through the clipper as far as its depth key. Returns null when
 * the original would not queue it:
 *  - 3+ vertices facing away: (first vertex - eye) . normal, 64-bit, not
 *    negative (points and lines skip the test);
 *  - every vertex nearer than the near clip, or every one beyond the far clip;
 *  - fewer than 3 clip records survive the near-plane clip (3+ vertex
 *    polygons only).
 * Otherwise the key over the clip records - each vertex in front at its own
 * depth, and each edge crossing the near plane at exactly viewNearClipScaled
 * (clip_vertex_at_near_plane), in the Sutherland-Hodgman order - is: the
 * MAXIMUM, or the MINIMUM with polySortFlags bit 2, or the unsigned MEAN with
 * bit 1; bit 0 ORs 0x40000000 in. This is the depth polygonDrawHook is
 * called with.
 *
 * @mw2 poly_clip_and_queue 0x0003e1de
 * @fidelity partial
 * @divergence the key, the rejects and the near-plane clip records (clipRecords, which SceneRenderer draws in place of the polygon when it crosses the near plane); projection, the screen-edge reject (all records off one screen edge) and the draw list are the GPU's
 */
export function polyDepthKey(poly: MeshPolygon, vertices: MeshVertex[]): number | null {
  const r = renderView;
  const idx = poly.indices;
  const n = poly.vertexCount;
  if (n >= 3) {
    const f = vertices[idx[0]!]!;
    acc
      .clear()
      .mulAdd((f.worldX - r.viewTranslationX) | 0, poly.normalX)
      .mulAdd((f.worldY - r.viewTranslationY) | 0, poly.normalY)
      .mulAdd((f.worldZ - r.viewTranslationZ) | 0, poly.normalZ);
    if (acc.h >= 0) return null; // jl on the 64-bit sum: only a negative sum is drawn
  }
  let all = 3;
  for (let i = 0; i < n; i++) {
    const v = vertices[idx[i]!]!;
    vertexViewDepth(v);
    all &= v.flags;
  }
  if (all === 1 || all === 2) return null;
  clipRecordCount = 0;
  const first = vertices[idx[0]!]!;
  const firstNear = first.flags & 1;
  let prev = first;
  let prevNear = firstNear;
  if (firstNear === 0) pushVertex(first);
  for (let i = 1; i < n; i++) {
    const b = vertices[idx[i]!]!;
    const bNear = b.flags & 1;
    if (bNear !== prevNear) pushCrossing(prev, b);
    prev = b;
    prevNear = bNear;
    if (bNear === 0) pushVertex(b);
  }
  if (firstNear !== prevNear) pushCrossing(prev, first);
  if (!(clipRecordCount > 2 || n < 3)) return null;
  const depthOf = (rec: ClipRecord) => (rec.b ? r.viewNearClipScaled : rec.a.viewDepth);
  let key: number;
  const flags = r.polySortFlags & 0xff;
  if ((flags & 2) !== 0) {
    let sum = 0;
    for (let i = 0; i < clipRecordCount; i++) sum = (sum + depthOf(clipRecords[i]!)) >>> 0;
    key = Math.floor(sum / (clipRecordCount & 0xffff)) | 0;
  } else if ((flags & 4) !== 0) {
    key = 0x7fffffff;
    for (let i = 0; i < clipRecordCount; i++) {
      const d = depthOf(clipRecords[i]!);
      if (d < key) key = d;
    }
  } else {
    key = -0x7fffffff; // 0x80000001
    for (let i = 0; i < clipRecordCount; i++) {
      const d = depthOf(clipRecords[i]!);
      if (key < d) key = d;
    }
  }
  if ((flags & 1) !== 0) key |= 0x40000000;
  return key;
}

/** What render_asm_sub_03b990 reads from a sprite polygon's first three vertices. */
export interface SpriteVertices {
  /** u = 0, v = 0: texture row 0's side of the square - in every shipped sprite the UPPER point */
  p: MeshVertex | null;
  /** u = 0, v != 0: the opposite side (texture's last row) - in every shipped sprite the point on the ground */
  q: MeshVertex | null;
  /** a negative v on q, or a negative u on another vertex: the texture is mirrored in u (no shipped sprite sets it) */
  mirror: boolean;
}

/**
 * The vertex reading of a mode 0x3000 sprite, for the world view (its last
 * argument 0): over the first three vertices, u = 0 and v != 0 is q (its v's
 * sign may mirror), u = 0 and v = 0 is p, and any other vertex only
 * contributes the mirror flag through u's sign. Later vertices win. The
 * original draws nothing unless both p and q were found. The square has p
 * and q as the midpoints of two opposite sides, v running 0 at p to 1 at q;
 * the data puts p above q, so texture row 0 is the top of the sprite
 * (test/golden/sprites.test.ts).
 *
 * @mw2 render_asm_sub_03b990 0x0003b990
 * @fidelity partial
 * @divergence the vertex reading only, over the mesh vertices rather than the clipped screen records (a sprite crossing the near plane is not drawn); the square itself is built in the vertex shader (render/materials/indexedMaterial.ts) and the map view's variant (last argument 1) is not ported
 */
export function spriteVertices(poly: MeshPolygon, vertices: MeshVertex[]): SpriteVertices {
  const out: SpriteVertices = { p: null, q: null, mirror: false };
  for (let k = 0; k < 3 && k < poly.vertexCount; k++) {
    const v = vertices[poly.indices[k]!]!;
    if (v.texU === 0) {
      if (v.texV !== 0) {
        out.q = v;
        if (v.texV < 0) out.mirror = true;
      } else out.p = v;
    } else if (v.texU < 0) out.mirror = true;
  }
  return out;
}
