/**
 * Detail records: the parts of every mech (and other gamepiece) model, one
 * record per part with a POLY per level of detail (REPR nests in the mission
 * stream). A part's scene node is built once; its mesh is rebuilt per level
 * as mech_lod_update picks levels by distance.
 */
import { DetailRecord, SceneNode as SceneNodeClass } from '../../generated/classes.gen.ts';
import type { MechEntity, SceneNode } from '../../generated/classes.gen.ts';
import { LABEL } from '../../generated/labels.gen.ts';
import { mulShr } from '../../core/int/i64.ts';
import { vecToRangeBearing } from '../../core/math/vec.ts';
import { registerCode } from '../../engine/codePtr.ts';
import { registerGlobals } from '../../engine/globals.ts';
import { imageI32 } from '../../engine/image.ts';
import { cacheLoadResource, cacheUnlock, projectResourceSize } from '../../engine/resources/cache.ts';
import { projectionGlobals } from '../camera/projection.ts';
import { objectLink, objectMoveToAltList, objectMoveToWorldList, objectRemoveFromWorld } from '../../engine/scene/objectLists.ts';
import { sceneNodeCreate, sceneNodeInitInPlace, sceneNodeSetOrigin, sceneNodeSetUserdata, sceneNodeWalk, sceneSubtreeSetObjectType } from '../../engine/scene/sceneGraph.ts';
import { objectDestroy, objectGetStateFlags, objectSetClass, objectSetHitLocation, objectSetIndex, objectSetNode, objectSetStateFlags, objectSetType } from '../../engine/scene/worldObject.ts';
import { polyLoadWtboBlock, polySetLoadFlags, polySetVertexScale, wtboGlobals } from '../../engine/scene/wtboLoader.ts';
import { cameraGetMode, viewer } from '../camera/viewer.ts';
import { mechs } from '../mech/mechGlobals.ts';

export const DETAIL_RECORD_COUNT = 0x30c;

export const detail = registerGlobals(
  'detailRecords',
  {
    detailRecords: Array.from({ length: DETAIL_RECORD_COUNT }, () => new DetailRecord()),
    detailRecordCount: 0,
    detailRecordsReady: 0,
  },
  () => {
    detail.detailRecords = Array.from({ length: DETAIL_RECORD_COUNT }, () => new DetailRecord());
    detail.detailRecordCount = imageI32(LABEL.detailRecordCount, 0);
    detail.detailRecordsReady = imageI32(LABEL.detailRecordsReady, 0);
  },
);

const dr = (i: number): DetailRecord => detail.detailRecords[i]!;

/**
 * Gives every part of a newly spawned mech its node, then destroys the
 * level-built object again - only the node hierarchy survives; meshes come
 * later from mech_lod_update.
 *
 * @mw2 mech_create_part_nodes 0x00036d90
 * @fidelity exact
 * @divergence nodes are JS objects rather than one static_malloc'd pool
 */
export function mechCreatePartNodes(mech: MechEntity): boolean {
  for (let i = 0; i < detail.detailRecordCount; i++) {
    const r = dr(i);
    if (mech.index !== r.owner) continue;
    detailRecordBuild(i, mech.spawnDetailLevel, new SceneNodeClass());
    if (r.builtLevel > -1 && mech.spawnDetailLevel === r.builtLevel && r.object) {
      objectDestroy(r.object);
      r.object = null;
      r.builtLevel = -1;
    }
  }
  return true;
}

/**
 * Records one detail level of an object: level 0 creates a record, later
 * levels write into `existing`; empty later slots are filled forward.
 *
 * @mw2 detail_record_set 0x00036e60
 * @fidelity exact
 */
export function detailRecordSet(polyId: number, x: number, y: number, z: number, parent: number, level: number, existing: number, typeCode: number): number {
  if (detail.detailRecordsReady === 0) detailRecordsReset();
  if (detail.detailRecordCount >= DETAIL_RECORD_COUNT) return -1;
  if (parent === -1) parent = -2;
  let r: DetailRecord;
  if (level === 0) {
    existing = detail.detailRecordCount;
    r = dr(existing);
    r.owner = -2;
    r.builtLevel = -1;
    r.parent = parent;
    r.originX = x;
    r.originZ = z;
    r.originY = y;
    r.polyIds[0] = polyId;
    r.released = 0;
    r.object = null;
    r.node = null;
    r.location = 0;
    detail.detailRecordCount++;
  } else {
    if (existing < 0) return -1;
    r = dr(existing);
  }
  r.polyIds[level] = polyId;
  r.typeCodes[level] = typeCode;
  for (let k = level + 1; k < 5; k++) {
    if (r.polyIds[k] === -1) {
      r.polyIds[k] = polyId;
      r.typeCodes[k] = typeCode;
    }
  }
  return existing;
}

/**
 * @mw2 detail_records_reset 0x00036f70
 * @fidelity exact
 */
export function detailRecordsReset(): void {
  for (let i = 0; i < DETAIL_RECORD_COUNT; i++) {
    const r = dr(i);
    r.owner = -1;
    r.builtLevel = -1;
    r.parent = -1;
    r.object = null;
    r.node = null;
    r.location = 0;
    r.released = 0;
    r.originX = r.originY = r.originZ = 0;
    // the loop writes slots 1..5 from a base one entry high - polyIds[1..4]
    // and typeCodes[1..4] here (slot 0 is always written by detail_record_set)
    for (let k = 1; k < 5; k++) {
      r.polyIds[k] = -1;
      r.typeCodes[k] = 0;
    }
  }
  detail.detailRecordCount = 0;
  detail.detailRecordsReady = 1;
}

/**
 * Hands every unclaimed (-2) record to the mech just spawned.
 *
 * @mw2 detail_records_claim 0x00037000
 * @fidelity exact
 */
export function detailRecordsClaim(mech: MechEntity): void {
  for (let i = 0; i < detail.detailRecordCount; i++) {
    const r = dr(i);
    if (r.owner === -2) {
      const p = r.parent;
      r.owner = mech.index;
      if (p === -1) r.parent = -2;
    }
  }
}

/**
 * Rebuilds one mech's parts at a level (-1: nothing). Returns false if any
 * part failed, so mech_lod_update does not cache a level never built.
 *
 * @mw2 mech_apply_detail_level 0x00037060
 * @fidelity exact
 */
export function mechApplyDetailLevel(mechIndex: number, level: number): boolean {
  if (level === -1) return true;
  let ok = true;
  wtboGlobals.polyOwnerActive = 1;
  wtboGlobals.polyOwnerKind = 0x100;
  wtboGlobals.polyOwnerIndex = mechIndex;
  for (let i = 0; i < detail.detailRecordCount; i++) {
    const r = dr(i);
    if (mechIndex !== r.owner) continue;
    if ((mechs.mechTable[r.owner]!.flags & 2) === 0 || r.location !== 0) {
      if (!detailRecordBuild(i, level, null)) ok = false;
    } else objectMoveToAltList(r.object);
    if (r.location === 0) objectRemoveFromWorld(r.object);
  }
  wtboGlobals.polyOwnerActive = 0;
  return ok;
}

/**
 * Builds one record's mesh at one level, creating its node on the first
 * build (under the owner mech's node, or under the parent record's).
 *
 * @mw2 detail_record_build 0x00037190
 * @fidelity exact
 * @divergence no cache purge-and-retry loop: the in-memory container cannot run out
 */
export function detailRecordBuild(record: number, level: number, nodePool: SceneNode | null): boolean {
  const r = dr(record);
  if (r.released !== 0) return true;
  let keptFlags = 0;
  if (r.object) {
    if ((r.object.type & 0xf0) === 0x50) return true;
    keptFlags = objectGetStateFlags(r.object);
    objectDestroy(r.object);
    r.object = null;
  }
  const polyId = r.polyIds[level]!;
  const data = cacheLoadResource(polyId, 'POLY');
  if (!data) return false;
  const size = projectResourceSize('POLY', polyId);
  r.builtLevel = -1;
  polySetVertexScale(1, 1, 1);
  polySetLoadFlags(0);
  if (!r.object) r.object = polyLoadWtboBlock(data, 0, size, null);
  cacheUnlock(polyId, 'POLY');
  const obj = r.object;
  if (!obj) return false;
  objectSetStateFlags(obj, keptFlags);
  let setOrigin = false;
  r.builtLevel = level;
  if (!r.node) {
    if (r.parent === -2) {
      const owner = mechs.mechTable[r.owner]!.node;
      r.node = nodePool ? sceneNodeInitInPlace(owner, nodePool) : sceneNodeCreate(owner, 10);
    } else {
      const p = dr(r.parent);
      const parentNode = p.node ?? p.object?.node ?? null;
      const node = nodePool ? sceneNodeInitInPlace(parentNode, nodePool) : sceneNodeCreate(parentNode, 10);
      if (node) {
        setOrigin = true;
        r.node = node;
      }
    }
  }
  const node = r.node!;
  sceneNodeSetUserdata(node, obj);
  objectSetNode(obj, node);
  const family = r.typeCodes[level]! & 0xf0;
  objectSetType(obj, family | 0x100);
  objectSetIndex(obj, r.owner);
  objectSetHitLocation(obj, r.location);
  objectLink(obj);
  if (family === 0x70) {
    objectMoveToAltList(obj);
    objectRemoveFromWorld(obj);
  } else {
    objectMoveToWorldList(obj);
    objectSetClass(obj, 6);
  }
  if (family === 0xa0) sceneSubtreeSetObjectType(node, 0x1a0);
  if (setOrigin) sceneNodeSetOrigin(node, r.originX, r.originY, r.originZ);
  sceneNodeWalk(node);
  return true;
}

/**
 * @mw2 detail_record_drop_level 0x000374a0
 * @fidelity exact
 */
export function detailRecordDropLevel(record: number, level: number): void {
  const r = dr(record);
  if (r.builtLevel > -1 && level === r.builtLevel && r.object) {
    objectDestroy(r.object);
    r.object = null;
    r.builtLevel = -1;
  }
}

/**
 * @mw2 detail_record_node 0x000374f0
 * @fidelity exact
 */
export function detailRecordNode(record: number): SceneNode | null {
  return record < detail.detailRecordCount && record > -1 ? dr(record).node : null;
}

/**
 * The OBJL chunk (keyword objloc).
 *
 * @mw2 detail_record_set_location 0x00037550
 * @fidelity exact
 */
export function detailRecordSetLocation(record: number, location: number): void {
  dr(record).location = location & 0xffff;
}

/** (lodScale * k) >> 16 with bit 15 added back - the thresholds in mech_lod_update. */
function scaled(lodScale: number, k: number): number {
  return (mulShr(lodScale, k, 16) + ((Math.imul(lodScale, k) >>> 15) & 1)) | 0;
}

/**
 * Picks a detail level per mech by slant range and applies the ones that
 * changed: the nearest within range gets 0, up to three more get 1, the rest
 * 2 or 3 by a threshold; the player's own mech gets 4 in the cockpit view.
 *
 * @mw2 mech_lod_update 0x00037580
 * @fidelity exact
 * @divergence with the host's projectionGlobals.lodAllNear set, every mech inside t0 gets level 0 (the detail enhancement)
 */
export function mechLodUpdate(): void {
  const v = viewer();
  const t0 = scaled(v.lodScale, 0xe10);
  const t1 = scaled(v.lodScale, 0x2134);
  const t2 = scaled(v.lodScale, 0x57e4);
  let nearest = t0;
  let first = -1;
  let second = -1;
  let third = -1;
  let onesGiven = 0;
  const m = mechs;
  const rows: Array<{ range: number; level: number; index: number }> = [];
  for (let i = 0; i < m.mechCount; i++) {
    const row = { range: 0, level: 0, index: i };
    rows.push(row);
    const e = m.mechTable[i]!;
    if (i === m.playerMechIndex && cameraGetMode() === 0) {
      row.level = 4;
      continue;
    }
    if ((e.flags & 2) === 0) {
      row.level = -2;
      const rb = vecToRangeBearing((e.posX - v.posX) | 0, (e.posY - v.posY) | 0, (e.posZ - v.posZ) | 0);
      row.range = rb.slantRange;
      if (rb.groundRange < nearest) {
        nearest = rb.groundRange;
        third = second;
        second = first;
        first = i;
      }
      continue;
    }
    row.level = i !== m.playerMechIndex ? 1 : 0;
  }
  for (const row of rows) {
    if (row.level === -2) {
      // @portOnly lodAllNear (the host's detail enhancement): every mech inside t0 at level 0, not only the nearest
      if ((first === row.index || projectionGlobals.lodAllNear !== 0) && row.range < t0) row.level = 0;
      else if (row.index === second || (row.index === third && row.range < t1)) {
        row.level = 1;
        onesGiven++;
      } else if ((second === -1 || third === -1) && row.range < t1 && onesGiven < 3) {
        row.level = 1;
        onesGiven++;
      } else row.level = (t2 <= row.range ? 1 : 0) + 2;
    }
    const e = m.mechTable[row.index]!;
    if (row.level > -1 && e.detailLevel !== row.level) {
      if (mechApplyDetailLevel(e.index, row.level)) e.detailLevel = row.level;
    }
  }
}

/**
 * onRelease for mech-part debris: the part is gone for good.
 *
 * @mw2 detail_record_release_node 0x000377e0
 * @fidelity exact
 */
export const detailRecordReleaseNode = registerCode('detail_record_release_node', 0x377e0, (node: SceneNode): void => {
  for (let i = 0; i < detail.detailRecordCount; i++) {
    const r = dr(i);
    if (node === r.node) {
      if (r.object) objectDestroy(r.object);
      r.object = null;
      r.builtLevel = -1;
      r.released = 1;
      return;
    }
  }
});
