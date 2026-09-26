/**
 * World records: the mission's scenery. 0x402 WorldRecord slots, defined by
 * OBJ chunks inside BLK..ENDB (world_record_define), linked to gamethings by
 * GT chunks, and built into WorldObjects after the stream has run
 * (world_records_build_all). A destroyed record is swapped for its
 * replacement; parent state (DESTROYED 0x200, SUPPRESSED 0x800) propagates
 * down to child records each tick.
 *
 * WorldRecord.flags: bits 0..8 the mesh load flags, 0x200 DESTROYED, 0x400
 * GAMETHING-LINKED, 0x800 SUPPRESSED, bits 12..15 the object class.
 *
 * Block frames (BLK..ENDB): up to 32 nested coordinate frames; a BLKX before
 * an included stream places that stream's first block.
 */
import { ProjectBlockFrame, WorldRecord } from '../../generated/classes.gen.ts';
import type { SceneNode, WorldObject } from '../../generated/classes.gen.ts';
import { LABEL } from '../../generated/labels.gen.ts';
import { cdiv } from '../../core/int/cint.ts';
import { matrixFromEulerOrder0, transformCompose, transformCopy, transformPoint } from '../../core/math/matrix.ts';
import { systemError } from '../../core/systemError.ts';
import { registerCode } from '../../engine/codePtr.ts';
import { registerGlobals } from '../../engine/globals.ts';
import { imageI32, imageI32s, imageU8 } from '../../engine/image.ts';
import { cacheLoadResource, cacheUnlock, projectResourceSize } from '../../engine/resources/cache.ts';
import { objectLink } from '../../engine/scene/objectLists.ts';
import {
  sceneNodeCopyTransform,
  sceneNodeCreate,
  sceneNodeGetUserdata,
  sceneNodeGetWorldPos,
  sceneNodeRebuildSubtree,
  sceneNodeSetEuler,
  sceneNodeSetOrigin,
  sceneNodeSetTransform,
  sceneNodeSetUserdata,
  sceneNodeTransform,
  sceneNodeWalk,
  sceneSubtreeDestroy,
  sceneSubtreeSetObjectClass,
  sceneSubtreeSetObjectIndex,
  sceneSubtreeSetObjectType,
} from '../../engine/scene/sceneGraph.ts';
import { objectDestroy, objectGetStateFlags, objectSetClass, objectSetIndex, objectSetNode, objectSetType, objectTransformNow } from '../../engine/scene/worldObject.ts';
import { polyLoadWtboBlock, polySetLoadFlags, polySetVertexScale, wtboGlobals } from '../../engine/scene/wtboLoader.ts';
import { type TaskList, taskCreate, taskListClear, taskListNotifyRebuilt, taskListRun } from '../../engine/tasks/taskList.ts';
import type { CodeFn } from '../../engine/codePtr.ts';
import { destructiblesRegisterSubtree } from '../things/destructibles.ts';
import { fallingObjectsFull } from '../things/fallingObjects.ts';
import { gamethingClear, things } from '../things/gameThings.ts';
import { objectBuildGroundQuadtree } from './groundQuadtree.ts';
import { mechLodUpdate } from './detailRecords.ts';
import { projectMaps } from './projectMaps.ts';

export const WORLD_RECORD_COUNT = 0x402;
export const BLOCK_FRAME_COUNT = 0x20;

/** WorldRecord.tasks is a task list head; the port keeps the list object per record. */
const recordTasks = new WeakMap<WorldRecord, TaskList>();
export function recordTaskList(r: WorldRecord): TaskList {
  let l = recordTasks.get(r);
  if (!l) {
    l = { head: null };
    recordTasks.set(r, l);
  }
  return l;
}

export const world = registerGlobals(
  'worldRecords',
  {
    worldRecords: Array.from({ length: WORLD_RECORD_COUNT }, () => new WorldRecord()),
    worldObjectCount: 0,
    worldRecordsReady: 0,
    worldRecordsDirty: 0,
    projectBlockFrames: Array.from({ length: BLOCK_FRAME_COUNT }, () => new ProjectBlockFrame()),
    projectBlockStack: new Int32Array(BLOCK_FRAME_COUNT + 1),
    projectBlockDepth: 0,
    projectBlockCurrent: -1,
    projectBlockNextSlot: 0,
    /** nine dwords: scale x,y,z, pitch, yaw, roll, position x,y,z - set by BLKX, consumed by the next BLK */
    pendingBlockXform: [1, 1, 1, 0, 0, 0, 0, 0, 0],
    /** 0x96cbc: what pendingBlockXform is reset to */
    defaultBlockXform: [1, 1, 1, 0, 0, 0, 0, 0, 0],
    /** 0x96ce0: while 0, records whose gamething carries 0x8000 are not built */
    debrisEnabled: 1,
  },
  () => {
    const w = world;
    w.worldRecords = Array.from({ length: WORLD_RECORD_COUNT }, () => new WorldRecord());
    w.worldObjectCount = imageI32(LABEL.worldObjectCount, 0);
    w.worldRecordsReady = imageI32(LABEL.worldRecordsReady, 0);
    w.worldRecordsDirty = imageI32(LABEL.worldRecordsDirty, 0);
    w.projectBlockFrames = Array.from({ length: BLOCK_FRAME_COUNT }, () => new ProjectBlockFrame());
    w.projectBlockStack = new Int32Array(BLOCK_FRAME_COUNT + 1);
    w.projectBlockDepth = imageI32(LABEL.projectBlockDepth, 0);
    w.projectBlockCurrent = imageI32(LABEL.projectBlockCurrent, -1);
    w.projectBlockNextSlot = imageI32(LABEL.projectBlockNextSlot, 0);
    w.defaultBlockXform = imageI32s(LABEL.defaultBlockXform, 9, [1, 1, 1, 0, 0, 0, 0, 0, 0]);
    w.pendingBlockXform = imageI32s(LABEL.pendingBlockXform, 9, [1, 1, 1, 0, 0, 0, 0, 0, 0]);
    w.debrisEnabled = imageU8(LABEL.debrisEnabled, 1);
  },
);

const rec = (i: number): WorldRecord => world.worldRecords[i]!;

/**
 * @mw2 world_records_tick 0x00035870
 * @fidelity exact
 */
export function worldRecordsTick(): void {
  if (world.worldRecordsDirty !== 0) {
    worldRecordsPropagate();
    world.worldRecordsDirty = 0;
  }
  mechLodUpdate();
  worldRecordsRunTasks();
}

/**
 * Last match wins; -1 for a negative id or none.
 *
 * @mw2 world_record_find 0x000358a0
 * @fidelity exact
 */
export function worldRecordFind(id: number): number {
  let r = -1;
  if (id > -1) {
    const m = projectMaps;
    for (let i = 0; i < m.worldRecordMapCount; i++) if (m.worldRecordMapIds[i] === id) r = m.worldRecordMapValues[i]!;
  }
  return r;
}

/**
 * The next record for `id`; the first call resets all 0x402.
 *
 * @mw2 world_record_alloc 0x000358f0
 * @fidelity exact
 */
export function worldRecordAlloc(id: number): number {
  const w = world;
  if (w.worldRecordsReady === 0) {
    for (let i = 0; i < WORLD_RECORD_COUNT; i++) worldRecordReset(i);
    w.worldObjectCount = 0;
    w.worldRecordsReady = 1;
  }
  const m = projectMaps;
  let result = -1;
  let next = w.worldObjectCount;
  if (w.worldObjectCount < WORLD_RECORD_COUNT && m.worldRecordMapCount < m.worldRecordMapCapacity) {
    m.worldRecordMapValues[m.worldRecordMapCount] = w.worldObjectCount;
    m.worldRecordMapIds[m.worldRecordMapCount] = id;
    m.worldRecordMapCount++;
    next = w.worldObjectCount + 1;
    result = w.worldObjectCount;
  }
  w.worldObjectCount = next;
  return result;
}

/**
 * The record's object slot, read live (a task holds the slot, not the object).
 *
 * @mw2 world_record_object_slot 0x00035970
 * @fidelity exact
 */
export function worldRecordObjectSlot(record: number): { get(): WorldObject | null } {
  return { get: () => rec(record).object };
}

/**
 * Get-or-create a record and fill it from an OBJ inside a BLK.
 *
 * @mw2 world_record_define 0x000359b0
 * @fidelity exact
 */
export function worldRecordDefine(
  id: number,
  polyId: number,
  xf: number[], // scaleX, scaleY, scaleZ, pitch, yaw, roll, posX, posY, posZ
  blockSlot: number,
  parent: number,
  flagBits: number,
  flagNibble: number,
  objectType: number,
): number {
  let idx = worldRecordFind(id);
  if (idx === -1) idx = worldRecordAlloc(id);
  if (idx === -1) return -1;
  const r = rec(idx);
  const t = new Int32Array(12);
  matrixFromEulerOrder0(t, xf[3]!, xf[4]!, xf[5]!, xf[6]!, xf[7]!, xf[8]!);
  transformCopy(t, r.transform);
  r.scaleX = xf[0]!;
  r.scaleY = xf[1]!;
  r.scaleZ = xf[2]!;
  r.pitch = xf[3]!;
  r.yaw = xf[4]!;
  r.roll = xf[5]!;
  r.posX = xf[6]!;
  r.posY = xf[7]!;
  r.posZ = xf[8]!;
  r.object = null;
  r.polyId = polyId;
  r.parent = parent;
  r.blockSlot = blockSlot;
  if (parent === -2) r.node = null;
  else r.node = sceneNodeCreate(parent === -1 ? null : rec(parent).node, 10);
  r.flags = (r.flags | (flagBits & 0x1ff) | ((flagNibble & 0xf) << 12)) >>> 0;
  r.objectType = objectType;
  worldRecordsPropagate();
  return idx;
}

/**
 * BLK: pushes a block frame - box (corner, extent) normalised to min/max and
 * centre, the pending BLKX transform (translate by -centre, rotate, translate
 * by position, translate back), composed with every enclosing frame.
 *
 * @mw2 project_block_begin 0x00035ad0
 * @fidelity exact
 */
export function projectBlockBegin(box: number[]): void {
  const w = world;
  const m = projectMaps;
  if (w.projectBlockDepth === 0) {
    m.worldRecordMapCount = 0;
    for (let i = 0; i < m.worldRecordMapValues.length; i++) m.worldRecordMapValues[i] = -1;
    w.projectBlockStack[w.projectBlockDepth] = -1;
  }
  const slot = w.projectBlockNextSlot;
  if (!(slot < BLOCK_FRAME_COUNT && slot > -1)) return;
  w.projectBlockDepth++;
  const f = w.projectBlockFrames[slot]!;
  w.projectBlockStack[w.projectBlockDepth] = slot;
  for (let k = 0; k < 3; k++) {
    f.boxMin[k] = box[k]!;
    f.boxMax[k] = box[k + 3]!;
  }
  f.parent = w.projectBlockStack[w.projectBlockDepth - 1]!;
  const p = w.pendingBlockXform;
  f.scale.set(p.slice(0, 3));
  f.angles.set(p.slice(3, 6));
  f.position.set(p.slice(6, 9));
  for (let k = 0; k < 3; k++) {
    if (f.boxMax[k]! < 0) {
      const e = f.boxMax[k]!;
      f.boxMin[k] = (f.boxMin[k]! + e) | 0;
      f.boxMax[k] = -e | 0;
    }
    f.boxMax[k] = (f.boxMax[k]! + f.boxMin[k]!) | 0;
    f.centre[k] = cdiv((f.boxMax[k]! + f.boxMin[k]!) | 0, 2);
  }
  // A scale matrix is built here and never used (the annotation's dead code).
  const a = new Int32Array(12);
  const b = new Int32Array(12);
  const t = f.transform;
  matrixFromEulerOrder0(a, 0, 0, 0, -f.centre[0]! | 0, -f.centre[1]! | 0, -f.centre[2]! | 0);
  matrixFromEulerOrder0(b, f.angles[0]!, f.angles[1]!, f.angles[2]!, 0, 0, 0);
  transformCompose(b, a, t);
  matrixFromEulerOrder0(a, 0, 0, 0, f.position[0]!, f.position[1]!, f.position[2]!);
  transformCompose(a, t, t);
  matrixFromEulerOrder0(a, 0, 0, 0, f.centre[0]!, f.centre[1]!, f.centre[2]!);
  transformCompose(a, t, t);
  for (let fr = f; fr.parent !== -1; ) {
    const parent = w.projectBlockFrames[fr.parent]!;
    transformCompose(parent.transform, t, t);
    fr = parent;
  }
  w.pendingBlockXform = w.defaultBlockXform.slice();
  w.projectBlockCurrent = w.projectBlockNextSlot;
  w.projectBlockNextSlot++;
}

/**
 * ELSB: empty in this build; no shipped stream uses it.
 *
 * @mw2 project_block_else 0x00035db0
 * @fidelity exact
 */
export function projectBlockElse(): void {}

/**
 * ENDB.
 *
 * @mw2 project_block_end 0x00035dc0
 * @fidelity exact
 */
export function projectBlockEnd(): void {
  const w = world;
  w.projectBlockDepth--;
  if (w.projectBlockDepth < 0) {
    systemError(0x22);
    return;
  }
  w.projectBlockCurrent = w.projectBlockStack[w.projectBlockDepth]!;
}

/**
 * BLKX.
 *
 * @mw2 block_xform_set 0x00035e00
 * @fidelity exact
 */
export function blockXformSet(nine: number[]): void {
  world.pendingBlockXform = nine.slice(0, 9);
}

/**
 * NAVP positions go through the innermost open block's frame.
 *
 * @mw2 block_transform_point 0x00035e20
 * @fidelity exact
 */
export function blockTransformPoint(p: number[]): void {
  if (world.projectBlockCurrent !== -1) transformPoint(world.projectBlockFrames[world.projectBlockCurrent]!.transform, p);
}

/**
 * @mw2 world_record_reset 0x00035e60
 * @fidelity exact
 */
export function worldRecordReset(i: number): void {
  const r = rec(i);
  r.polyId = -1;
  r.blockSlot = -1;
  r.parent = -1;
  r.flags = 0;
  r.objectType = 0;
  r.replacementRecord = -1;
  r.gamething = -1;
  r.object = null;
  r.node = null;
  r.scaleX = r.scaleY = r.scaleZ = 1;
  r.pitch = r.yaw = r.roll = 0;
  r.posX = r.posY = r.posZ = 0;
  r.tasks = null;
  recordTasks.delete(r);
}

/**
 * @mw2 world_records_build_all 0x00035f20
 * @fidelity exact
 */
export function worldRecordsBuildAll(): void {
  for (let i = 0; i < world.worldObjectCount; i++) worldRecordBuild(i, rec(i).blockSlot);
}

/**
 * @mw2 world_record_task_create 0x00035f60
 * @fidelity exact
 */
export function worldRecordTaskCreate(record: number, callback: CodeFn | null, period: number, arg: unknown): void {
  const r = rec(record);
  taskCreate(recordTaskList(r), callback, period, arg);
  r.tasks = recordTaskList(r).head;
}

/**
 * @mw2 world_records_run_tasks 0x00035f90
 * @fidelity exact
 */
export function worldRecordsRunTasks(): void {
  for (let i = 0; i < world.worldObjectCount; i++) {
    const r = rec(i);
    const l = recordTasks.get(r);
    if ((r.flags & 0x800) === 0 && l && l.head) {
      taskListRun(l);
      r.tasks = l.head;
    }
  }
}

/**
 * GT: links a record to a gamething and a replacement (which starts hidden).
 *
 * @mw2 world_record_link_gamething 0x000360b0
 * @fidelity exact
 */
export function worldRecordLinkGamething(record: number, replacement: number, gamething: number): void {
  if (!(record > -1 && record < world.worldObjectCount)) return;
  const r = rec(record);
  r.flags |= 0x400;
  r.objectType |= 0x200;
  r.replacementRecord = (replacement << 16) >> 16;
  r.gamething = (gamething << 16) >> 16;
  if (replacement > -1) {
    rec(replacement).flags |= 0x800;
    worldRecordsPropagate();
  }
}

/**
 * Swaps a destroyed record for its replacement, which appears exactly where
 * the original stood. Returns the replacement index or -1.
 *
 * @mw2 world_record_replace 0x00036110
 * @fidelity exact
 */
export function worldRecordReplace(record: number): number {
  const r = rec(record);
  let result = r.gamething;
  if (r.gamething === -1) return result;
  r.flags |= 0xa00;
  const g = things.gameThings[r.gamething]!;
  g.geomIndex = -1;
  g.flags = (g.flags & 0xff00) | ((g.flags | 4) & 0xff);
  taskListClear(recordTaskList(r));
  r.tasks = null;
  const saved = new Int32Array(12);
  if (r.object) {
    if (r.node) saved.set(sceneNodeTransform(r.node));
    objectDestroy(r.object);
    r.object = null;
    r.node = null;
  }
  const repl = r.replacementRecord;
  result = repl;
  if (repl !== -1) {
    const rr = rec(repl);
    rr.flags &= ~0x800;
    if (!worldRecordBuild(repl, rr.blockSlot)) {
      result = -1;
      quirkFlagsMask(rr);
    } else {
      const node = rr.node;
      if (node) sceneNodeCopyTransform(node, saved);
      taskListNotifyRebuilt(recordTaskList(rr));
      if (node) sceneNodeRebuildSubtree(node);
    }
  }
  return result;
}

/** flags &= 0x800 right after clearing 0x800: the original leaves flags 0 (world_record_replace, world_records_propagate). */
function quirkFlagsMask(r: WorldRecord): void {
  r.flags &= 0x800;
}

/**
 * Parent state flows to children: a DESTROYED parent's child is replaced; a
 * SUPPRESSED parent's child is suppressed and its object destroyed; a
 * suppressed child under an unsuppressed parent is rebuilt.
 *
 * @mw2 world_records_propagate 0x000362d0
 * @fidelity exact
 */
export function worldRecordsPropagate(): void {
  const w = world;
  for (let i = 0; i < w.worldObjectCount; i++) {
    const r = rec(i);
    if (r.parent < 0) continue;
    if ((rec(r.parent).flags & 0x200) !== 0 && (r.flags & 0x200) === 0) {
      w.worldRecordsDirty = 1;
      worldRecordReplace(i);
    }
    if ((rec(r.parent).flags & 0x800) !== 0) {
      if ((r.flags & 0x800) === 0) {
        w.worldRecordsDirty = 1;
        r.flags |= 0x800;
        if (r.object) {
          objectDestroy(r.object);
          r.object = null;
        }
      }
      continue;
    }
    if ((r.flags & 0x800) === 0 || (r.flags & 0x200) !== 0) continue;
    w.worldRecordsDirty = 1;
    r.flags &= ~0x800;
    if (!worldRecordBuild(i, r.blockSlot)) {
      quirkFlagsMask(r);
      continue;
    }
    if (r.gamething !== -1 && (((things.gameThings[r.gamething]!.flags << 16) >> 16) & 0x8000) !== 0) {
      destructiblesRegisterSubtree(r.node, debrisTeardown, 0);
      worldRecordReleaseSubtree(i);
    }
  }
}

/**
 * 1 when every record has a polyId; 0 means a GT/TSK referenced an id no OBJ defined.
 *
 * @mw2 world_records_all_defined 0x00036440
 * @fidelity exact
 */
export function worldRecordsAllDefined(): boolean {
  for (let i = 0; i < world.worldObjectCount; i++) if (rec(i).polyId === -1) return false;
  return true;
}

/**
 * Builds a record's WorldObject from its POLY. Placement by parent: -2 bakes
 * record x block transform into the mesh (static scenery, no node); -1 gives
 * the record's node the block-composed transform; otherwise the node gets the
 * record's own euler and position under the parent record's node.
 *
 * @mw2 world_record_build 0x00036480
 * @fidelity exact
 */
export function worldRecordBuild(record: number, blockSlot: number): boolean {
  const r = rec(record);
  if ((r.flags & 0x800) !== 0) return false;
  if (r.polyId === -1) return false;
  if (r.gamething !== -1 && (((things.gameThings[r.gamething]!.flags << 16) >> 16) & 0x8000) !== 0) {
    if (world.debrisEnabled === 0) return false;
    if (fallingObjectsFull()) return false;
  }
  if (r.object && (objectGetStateFlags(r.object) & 0x400) === 0) return true;
  const base = cacheLoadResource(r.polyId, 'POLY');
  if (!base) return false;
  const size = projectResourceSize('POLY', r.polyId);
  polySetVertexScale(r.scaleX, r.scaleY, r.scaleZ);
  polySetLoadFlags(r.flags & 0x1ff);
  const parentNode: SceneNode | null = r.parent > -1 ? rec(r.parent).node : null;
  if (r.gamething !== -1) {
    wtboGlobals.polyOwnerActive = 1;
    wtboGlobals.polyOwnerKind = 0x200;
    wtboGlobals.polyOwnerIndex = r.gamething;
  }
  r.object = polyLoadWtboBlock(base, 0, size, parentNode);
  wtboGlobals.polyOwnerActive = 0;
  cacheUnlock(r.polyId, 'POLY');
  if (!r.object) return false;
  const blockT = world.projectBlockFrames[blockSlot]?.transform ?? new Int32Array(12);
  const cls = (r.flags & 0xf000) >> 12;
  const composed = new Int32Array(12);
  if (r.parent === -2) {
    transformCompose(blockT, r.transform, composed);
    objectTransformNow(r.object, composed);
    r.node = null;
    objectSetType(r.object, r.objectType);
    objectSetIndex(r.object, (r.flags & 0x400) === 0 ? record : r.gamething);
    objectSetClass(r.object, cls);
    objectLink(r.object);
  } else {
    if (!r.node) return false;
    sceneNodeSetUserdata(r.node, r.object);
    objectSetNode(r.object, r.node);
    objectLink(r.object);
    if (r.parent === -1) {
      transformCompose(blockT, r.transform, composed);
      sceneNodeSetTransform(r.node, composed);
    } else {
      sceneNodeSetEuler(r.node, r.pitch, r.yaw, r.roll, 0);
      sceneNodeSetOrigin(r.node, r.posX, r.posY, r.posZ);
    }
    sceneNodeWalk(r.node);
    if ((r.flags & 0x400) === 0) {
      objectSetType(r.object, r.objectType);
      objectSetIndex(r.object, record);
    } else {
      sceneSubtreeSetObjectType(r.node, r.objectType);
      sceneSubtreeSetObjectIndex(r.node, r.gamething);
    }
    sceneSubtreeSetObjectClass(r.node, cls);
  }
  if (cls === 5) objectBuildGroundQuadtree(r.object);
  return true;
}

/**
 * @mw2 world_object_node 0x00036790
 * @fidelity exact
 */
export function worldObjectNode(record: number): SceneNode | null {
  return record < world.worldObjectCount && record > -1 ? rec(record).node : null;
}

/**
 * @mw2 world_record_object 0x000367c0
 * @fidelity exact
 */
export function worldRecordObject(record: number): WorldObject | null {
  return record < world.worldObjectCount && record > -1 ? rec(record).object : null;
}

/**
 * The object's position, else the node's, else zeros. Note the bound is
 * `worldObjectCount < n` - n == worldObjectCount is let through, as in C.
 *
 * @mw2 world_object_get_pos 0x000367f0
 * @fidelity exact
 */
export function worldObjectGetPos(record: number): [number, number, number] {
  if (world.worldObjectCount < record || record < 0) return [0, 0, 0];
  const r = rec(record);
  if (r.object) return [r.object.posX, r.object.posY, r.object.posZ];
  if (r.node) return sceneNodeGetWorldPos(r.node);
  return [0, 0, 0];
}

/**
 * Resets a record and every record below it (clearing their gamething
 * slots); destroys nothing - the destructibles system owns the scenery now.
 *
 * @mw2 world_record_release_subtree 0x00036cc0
 * @fidelity exact
 */
export function worldRecordReleaseSubtree(record: number): boolean {
  for (let i = 0; i < world.worldObjectCount; i++) if (rec(i).parent === record) worldRecordReleaseSubtree(i);
  if ((record >>> 0) < WORLD_RECORD_COUNT) {
    const g = rec(record).gamething;
    if (g >>> 0 < 0xfe) gamethingClear(g);
    worldRecordReset(record);
    return true;
  }
  return false;
}

/**
 * The onRelease callback for world-record debris.
 *
 * @mw2 debris_teardown 0x00036d30
 * @fidelity exact
 */
export const debrisTeardown = registerCode('debris_teardown', 0x36d30, (node: SceneNode | null): void => {
  if (!node) return;
  sceneSubtreeDestroy(node, sceneNodeGetUserdata(node) ? objectDestroy : null);
});

/**
 * @mw2 debris_enabled 0x00036d60
 * @fidelity exact
 */
export function debrisEnabled(): number {
  return world.debrisEnabled;
}

/**
 * @mw2 debris_set_enabled 0x00036d70
 * @fidelity partial
 * @divergence the options block copy (+0x24 of *0x97e3c) is not kept here
 */
export function debrisSetEnabled(_unused: number, enabled: number): void {
  world.debrisEnabled = enabled & 0xff;
}
