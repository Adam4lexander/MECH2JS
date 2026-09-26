/**
 * OBJ chunks (keyword object): one mesh placement, 60 bytes in every OBJ in
 * MW2.PRJ (tools/dump_objects.py; test/golden/objects.test.ts):
 *   +0x08 id  +0x0a parent (-2: a world object placed by its own matrix)
 *   +0x0c objectClass (outside 0..7 read as 4)
 *   +0x0e scale x,y,z (integer)  +0x1a pitch, yaw, roll  +0x26 x, y, z
 *   +0x32 load flags  +0x34 WorldObject.type  +0x38 POLY id
 */
import { matrixFromEulerOrder0 } from '../../core/math/matrix.ts';
import { systemError } from '../../core/systemError.ts';
import { unestablished } from '../../core/provenance.ts';
import type { Chunk } from '../../data/bwd/stream.ts';
import { cacheLoadResource, cacheRelease, cacheUnlock, projectResourceSize } from '../../engine/resources/cache.ts';
import { objectLink } from '../../engine/scene/objectLists.ts';
import { sceneNodeCreate, sceneNodeSetEuler, sceneNodeSetOrigin, sceneNodeSetUserdata, sceneNodeWalk } from '../../engine/scene/sceneGraph.ts';
import { objectSetClass, objectSetNode, objectTransformNow } from '../../engine/scene/worldObject.ts';
import { polyLoadWtboBlock, polySetLoadFlags, polySetVertexScale } from '../../engine/scene/wtboLoader.ts';
import { detailRecordSet } from '../../sim/world/detailRecords.ts';
import { objectBuildGroundQuadtree } from '../../sim/world/groundQuadtree.ts';
import { projectDetailFind, projectMangleId, projectMaps, projectObjectFind, projectObjectRegister } from '../../sim/world/projectMaps.ts';
import { world, worldRecordDefine, worldRecordFind } from '../../sim/world/worldRecords.ts';

/**
 * Three paths: inside a BLK it only defines a world record; inside a REPR it
 * only records the POLY for detail level `reprLevel`; otherwise it loads the
 * mesh, parents it (or places it by its own matrix for parent -2) and
 * registers the object under its id.
 *
 * @mw2 project_obj_exec 0x0004e130
 * @fidelity partial
 * @divergence the loose-file path for an OBJ with no POLY id (poly -1) is not ported; no shipped OBJ uses it
 */
export function projectObjExec(c: Chunk, blockDepth: number, reprActive: number, reprLevel: number): void {
  const polyId = c.i16(0x38);
  const id = c.i16(8);
  const parent = c.i16(10);
  let cls = c.i16(0xc);
  const type = c.i32(0x34);
  if (cls < 0 || cls > 7) cls = 4;
  const v = Array.from({ length: 9 }, (_, k) => c.i32(0xe + k * 4));
  const loadFlags = c.i16(0x32);
  const mangle = projectMaps.projectIdMangle;

  if (polyId === -1) {
    unestablished('OBJ with no POLY id loads a loose .wtb file; not ported', 'project_obj_exec');
    systemError(0x36);
    return;
  }
  const data = cacheLoadResource(polyId, 'POLY');
  if (!data) {
    systemError(0x38);
    return;
  }
  const size = projectResourceSize('POLY', polyId);

  if (blockDepth !== 0 && world.projectBlockCurrent !== -1) {
    let parentRec = -1;
    if (parent === -2) parentRec = -2;
    else if (parent !== -1) {
      parentRec = worldRecordFind((parent + mangle) | 0);
      if (parentRec === -1) systemError(0x2d);
    }
    worldRecordDefine((id + mangle) | 0, polyId, v, world.projectBlockCurrent, parentRec, loadFlags, cls, type);
    cacheUnlock(polyId, 'POLY');
    return;
  }
  const m = projectMaps;
  if (reprActive !== 0 && m.detailMapCount < m.detailMapCapacity) {
    m.detailMapIds[m.detailMapCount] = projectMangleId(id);
    const own = projectDetailFind((id + mangle) | 0);
    const parentDetail = projectDetailFind((parent + mangle) | 0);
    m.detailMapValues[m.detailMapCount] = detailRecordSet(polyId, v[6]!, v[7]!, v[8]!, parentDetail, reprLevel, own, type & 0xffff);
    m.detailMapCount++;
    cacheUnlock(polyId, 'POLY');
    return;
  }

  polySetVertexScale(v[0]!, v[1]!, v[2]!);
  polySetLoadFlags(loadFlags);
  const obj = polyLoadWtboBlock(data, 0, size, null);
  if (obj) {
    obj.type = type & 0xffff;
    objectSetClass(obj, cls);
    projectObjectRegister((id + mangle) | 0, obj);
    if (parent === -2) {
      const t = new Int32Array(12);
      matrixFromEulerOrder0(t, v[3]!, v[4]!, v[5]!, v[6]!, v[7]!, v[8]!);
      objectTransformNow(obj, t);
      objectLink(obj);
      if (obj.objectClass === 5) objectBuildGroundQuadtree(obj);
    } else {
      const parentObj = projectObjectFind((parent + mangle) | 0);
      const node = sceneNodeCreate(parentObj ? parentObj.node : null, 10)!;
      sceneNodeSetUserdata(node, obj);
      objectSetNode(obj, node);
      sceneNodeSetEuler(node, v[3]!, v[4]!, v[5]!, 0);
      sceneNodeSetOrigin(node, v[6]!, v[7]!, v[8]!);
      sceneNodeWalk(node);
      objectLink(obj);
    }
  }
  cacheRelease(polyId, 'POLY');
}
