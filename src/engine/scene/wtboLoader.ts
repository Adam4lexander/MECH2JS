/**
 * Building WorldObjects from WTBO records: the build half of
 * poly_load_wtbo_record, plus poly_load_wtbo_block and the load-time
 * globals (vertex offset and scale, load flags, owner affiliation).
 *
 * Two record flags change the shape of a block, and both LATCH for the rest
 * of the block once seen:
 *   0x2000 part mode: each record builds its own object on its own scene
 *          node, and the record's LAST vertex is that node's pivot (raw,
 *          before offset/scale), not geometry.
 *   0x1000 LOD mode: records after the first append to the same object as
 *          further meshes, keyed by the number after '_' in their name.
 */

import type { SceneNode, WorldObject } from '../../generated/classes.gen.ts';
import { LABEL } from '../../generated/labels.gen.ts';
import { parseWtboRecord } from '../../data/formats/wtbo.ts';
import { registerGlobals } from '../globals.ts';
import { imageI32 } from '../image.ts';
import { objectLink } from './objectLists.ts';
import { sceneNodeChildFromLast, sceneNodeCreate, sceneNodeSetOrigin, sceneNodeSetUserdata, sceneNodeWalk } from './sceneGraph.ts';
import { meshAddPolygon, meshAddVertex, meshFinish, objectAddMesh, objectApplyLoadFlags, objectCreate, objectSetClass, objectSetMeshKey, objectSetNode, objectSetType, polyAddIndex } from './worldObject.ts';

export const wtboGlobals = registerGlobals(
  'meshLoad',
  {
    polyVertexOffsetX: 0,
    polyVertexOffsetY: 0,
    polyVertexOffsetZ: 0,
    polyVertexScaleX: 1,
    polyVertexScaleY: 1,
    polyVertexScaleZ: 1,
    polyLoadFlags: 0,
    polyLoadStatus: 0,
    wtboPartMode: 0,
    wtboLodMode: 0,
    wtboLowFlagIs1: 0,
    wtboLowFlagIs2: 0,
    wtboPartClass: 4,
    polyOwnerActive: 0,
    polyOwnerKind: 0,
    polyOwnerIndex: 0,
    polyCodeRemapTable: null as Int32Array | null,
    polyCodeRemapLimit: 0,
  },
  () => {
    const g = wtboGlobals;
    g.polyVertexOffsetX = imageI32(LABEL.polyVertexOffsetX, 0);
    g.polyVertexOffsetY = imageI32(LABEL.polyVertexOffsetY, 0);
    g.polyVertexOffsetZ = imageI32(LABEL.polyVertexOffsetZ, 0);
    g.polyVertexScaleX = imageI32(LABEL.polyVertexScaleX, 1);
    g.polyVertexScaleY = imageI32(LABEL.polyVertexScaleY, 1);
    g.polyVertexScaleZ = imageI32(LABEL.polyVertexScaleZ, 1);
    g.polyLoadFlags = imageI32(LABEL.polyLoadFlags, 0);
    g.polyLoadStatus = 0;
    g.wtboPartMode = g.wtboLodMode = g.wtboLowFlagIs1 = g.wtboLowFlagIs2 = 0;
    g.wtboPartClass = imageI32(LABEL.wtboPartClass, 4);
    g.polyOwnerActive = g.polyOwnerKind = g.polyOwnerIndex = 0;
    g.polyCodeRemapTable = null;
    g.polyCodeRemapLimit = imageI32(LABEL.polyCodeRemapLimit, 0);
  },
);

/**
 * The owner's affiliation (0..7) for poly_resolve_code: a mech's group
 * affiliation (kind 0x100) or a gamething's (kind 0x200). The engine cannot
 * see those tables; the sim installs the lookup.
 */
let ownerAffiliation: (kind: number, index: number) => number = () => 0;
export function setPolyOwnerAffiliation(fn: (kind: number, index: number) => number): void {
  ownerAffiliation = fn;
}

/**
 * While polyOwnerActive, codes whose low byte is 0x00 or 0x14 get the
 * owner's affiliation added (placeholders for per-side colours). Otherwise a
 * code with 0x8000 would be remapped through polyCodeRemapTable, which
 * nothing ever sets.
 *
 * @mw2 poly_resolve_code 0x0004fde0
 * @fidelity exact
 */
export function polyResolveCode(code: number): number {
  const g = wtboGlobals;
  const low = code & 0xff;
  if (g.polyOwnerActive === 0 || (low !== 0 && low !== 0x14)) {
    if ((code & 0x8000) !== 0) {
      code &= 0x7fff;
      if (g.polyCodeRemapTable && code <= g.polyCodeRemapLimit >>> 0) code = g.polyCodeRemapTable[code]!;
    }
    return code;
  }
  return (code + ownerAffiliation(g.polyOwnerKind, g.polyOwnerIndex)) | 0;
}

/**
 * The PLGO chunk's handler (keyword polyoffset).
 *
 * @mw2 poly_set_vertex_offset 0x0004fe80
 * @fidelity exact
 */
export function polySetVertexOffset(x: number, y: number, z: number): void {
  wtboGlobals.polyVertexOffsetX = x | 0;
  wtboGlobals.polyVertexOffsetY = y | 0;
  wtboGlobals.polyVertexOffsetZ = z | 0;
}

/**
 * @mw2 poly_set_vertex_scale 0x0004fea0
 * @fidelity exact
 */
export function polySetVertexScale(x: number, y: number, z: number): void {
  wtboGlobals.polyVertexScaleZ = z === 0 ? 1 : z | 0;
  wtboGlobals.polyVertexScaleY = y === 0 ? 1 : y | 0;
  wtboGlobals.polyVertexScaleX = x === 0 ? 1 : x | 0;
}

/**
 * @mw2 poly_set_load_flags 0x0004fee0
 * @fidelity exact
 */
export function polySetLoadFlags(flags: number): void {
  wtboGlobals.polyLoadFlags = flags | 0;
}

/** Reads a leading decimal number the way Watcom's atoi does (digits only; the caller has checked the first). */
function atoi(s: string): number {
  const m = /^\s*[+-]?\d+/.exec(s);
  return m ? parseInt(m[0], 10) | 0 : 0;
}

/**
 * Loads one WTBO record at `cursor` into `obj` (creating it when null or in
 * part mode) and returns the new cursor, or -1 with polyLoadStatus set.
 *
 * @mw2 poly_load_wtbo_record 0x0004fef0
 * @fidelity exact
 * @divergence a failed checksum returns -1 before building, where the original has already added the vertices and polygons to the object (only matters for corrupt data; every shipped record passes)
 */
export function polyLoadWtboRecord(
  data: Uint8Array,
  cursor: number,
  objRef: { obj: WorldObject | null },
  parentNode: SceneNode | null,
  nodeCount: { n: number },
): number {
  const g = wtboGlobals;
  if (!objRef.obj) g.wtboPartMode = g.wtboLodMode = g.wtboLowFlagIs2 = g.wtboLowFlagIs1 = 0;
  const rec = parseWtboRecord(data, cursor);
  if (!rec) {
    g.polyLoadStatus = -2;
    return -1;
  }
  const hiFlags = (rec.flags >> 8) & 0xff;
  if ((hiFlags & 0x20) === 0) {
    if ((hiFlags & 0x10) !== 0) g.wtboLodMode = 1;
  } else g.wtboPartMode = 1;
  const low = rec.flags & 0xcfff;
  g.wtboLowFlagIs1 = low === 1 ? 1 : 0;
  g.wtboLowFlagIs2 = low === 2 ? 1 : 0;

  let lodKey = 0;
  if (g.wtboLodMode !== 0) {
    const us = rec.name.indexOf('_');
    if (us >= 0 && /\d/.test(rec.name[us + 1] ?? '')) lodKey = atoi(rec.name.slice(us + 1));
  }
  if (rec.computedChecksum !== rec.checksum) {
    g.polyLoadStatus = -2;
    return -1;
  }
  const nv = rec.vertexCount;
  const np = rec.polygonCount;
  const geomVerts = g.wtboPartMode === 0 ? nv : nv - 1;
  if (!objRef.obj || g.wtboPartMode !== 0) {
    const o = objectCreate(geomVerts, np);
    objRef.obj = o;
    if (!o) {
      g.polyLoadStatus = -2;
      return -1;
    }
    objectSetMeshKey(o, lodKey);
  } else if (g.wtboLodMode !== 0 && !objectAddMesh(objRef.obj, lodKey, geomVerts, np)) {
    g.polyLoadStatus = -2;
    return -1;
  }
  const obj = objRef.obj!;
  const P = rec.positions;
  const T = rec.texcoords;
  for (let i = 0; i < nv; i++) {
    if (i < geomVerts) {
      meshAddVertex(
        obj,
        (Math.imul(P[i * 3]!, g.polyVertexScaleX) + g.polyVertexOffsetX) | 0,
        (g.polyVertexOffsetY + Math.imul(P[i * 3 + 1]!, g.polyVertexScaleY)) | 0,
        (g.polyVertexOffsetZ + Math.imul(P[i * 3 + 2]!, g.polyVertexScaleZ)) | 0,
        T[i * 2]!,
        T[i * 2 + 1]!,
      );
    }
  }
  for (const p of rec.polygons) {
    const poly = meshAddPolygon(obj, polyResolveCode(p.code));
    if (!poly) {
      g.polyLoadStatus = -9;
      return -1;
    }
    for (const idx of p.indices) polyAddIndex(obj, poly, idx);
  }
  meshFinish(obj);
  g.polyLoadStatus = 0;
  if (g.wtboPartMode !== 0) {
    let node = parentNode ? sceneNodeChildFromLast(parentNode, nodeCount.n) : null;
    if (!node) node = sceneNodeCreate(parentNode, 0x14);
    if (!node) {
      g.polyLoadStatus = -2;
      return -1;
    }
    if (node.userData) {
      node = sceneNodeCreate(parentNode, 0xc);
      if (!node) {
        g.polyLoadStatus = -2;
        return -1;
      }
    }
    // the pivot: the LAST vertex, raw (before offset and scale)
    const last = (nv - 1) * 3;
    sceneNodeSetOrigin(node, P[last]!, P[last + 1]!, P[last + 2]!);
    sceneNodeSetUserdata(node, obj);
    objectSetNode(obj, node);
    sceneNodeWalk(node);
    if (nodeCount.n !== 0) {
      objectLink(obj);
      objectSetClass(obj, g.wtboPartClass);
      objectSetType(obj, 0x50);
    }
    nodeCount.n++;
  }
  return cursor + rec.length;
}

/**
 * Walks a run of WTBO records and returns the FIRST object built; every
 * object gets polyLoadFlags through object_apply_load_flags.
 *
 * @mw2 poly_load_wtbo_block 0x000504a0
 * @fidelity exact
 */
export function polyLoadWtboBlock(data: Uint8Array, start: number, end: number, parentNode: SceneNode | null): WorldObject | null {
  const g = wtboGlobals;
  g.polyLoadStatus = 0;
  const first = { obj: null as WorldObject | null };
  const nodeCount = { n: 0 };
  let cursor = start;
  if (cursor < end) {
    const c = polyLoadWtboRecord(data, cursor, first, parentNode, nodeCount);
    if (c !== -1) {
      cursor = c;
      const cur = { obj: first.obj };
      while (cursor < end) {
        const c2 = polyLoadWtboRecord(data, cursor, cur, parentNode, nodeCount);
        if (c2 === -1) break;
        cursor = c2;
        if (cur.obj) objectApplyLoadFlags(cur.obj, g.polyLoadFlags);
      }
    }
  }
  if (first.obj) objectApplyLoadFlags(first.obj, g.polyLoadFlags);
  return first.obj;
}
