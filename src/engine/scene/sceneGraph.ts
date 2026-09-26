/**
 * The scene graph: SceneNode trees with a local transform (localBlock:
 * localMatrix + localX/Y/Z) composed down into a world transform
 * (worldBlock: worldMatrix + worldPos). flags bit 0 marks a node dirty;
 * scene_node_walk finds dirty nodes and scene_node_rebuild_subtree
 * recomputes them and everything under them.
 *
 * flags bit 1: allocated from the static arena; bit 2: heap-allocated
 * (scene_subtree_destroy frees only those). The port has a garbage
 * collector, so both are kept only as markers.
 */

import { SceneNode, type WorldObject } from '../../generated/classes.gen.ts';
import { matrixFromEuler, matrixIdentity, matrixMultiply, matrixRenormalise, matrixToEuler, transformCompose } from '../../core/math/matrix.ts';
import { registerGlobals } from '../globals.ts';
import { imageI32 } from '../image.ts';
import { LABEL } from '../../generated/labels.gen.ts';
import { objectAddToWorld, objectMoveToAltList, objectMoveToAuxList, objectMoveToWorldList, objectRemoveFromWorld } from './objectLists.ts';
import { objectSetClass, objectUpdateWorldPos } from './worldObject.ts';

export const sceneGlobals = registerGlobals(
  'scene',
  {
    /** 0x95ae4: seeds each node's renormCountdown, then steps to ((v + 7) & 0x7f) + 0x40 */
    renormCountdownSeed: 100,
  },
  () => {
    sceneGlobals.renormCountdownSeed = imageI32(LABEL.renormCountdownSeed, 100);
  },
);

function nextRenormSeed(): number {
  const v = sceneGlobals.renormCountdownSeed;
  sceneGlobals.renormCountdownSeed = (((v + 7) >>> 0) & 0x7f) + 0x40;
  return v;
}

/**
 * Creates a node under `parent` (prepended to its children, or appended with
 * option 0x10), with an identity local transform and the parent's world
 * transform. options 2: static arena, 4: heap; neither returns null.
 *
 * @mw2 scene_node_create 0x0001dd60
 * @fidelity exact
 */
export function sceneNodeCreate(parent: SceneNode | null, options: number): SceneNode | null {
  let flags: number;
  if ((options & 2) === 0) {
    if ((options & 4) === 0) return null;
    flags = 4;
  } else {
    flags = 2;
  }
  const n = new SceneNode();
  n.flags = flags;
  n.firstChild = null;
  n.nextSibling = null;
  n.parent = parent;
  if (parent) {
    if ((options & 0x10) === 0) {
      n.nextSibling = parent.firstChild;
      parent.firstChild = n;
    } else {
      let last: SceneNode | null = null;
      for (let c = parent.firstChild; c; c = c.nextSibling) last = c;
      if (last) last.nextSibling = n;
      else parent.firstChild = n;
    }
  }
  matrixIdentity(n.localBlock);
  if (!parent) matrixIdentity(n.worldBlock);
  else n.worldBlock.set(parent.worldBlock);
  n.flags |= 1;
  n.renormCountdown = nextRenormSeed();
  n.userData = null;
  n.name = null;
  return n;
}

/**
 * Builds a node in storage the caller owns; always prepends; flags = 1 only.
 *
 * @mw2 scene_node_init_in_place 0x0001de60
 * @fidelity exact
 */
export function sceneNodeInitInPlace(parent: SceneNode | null, node: SceneNode): SceneNode {
  node.firstChild = null;
  node.parent = parent;
  if (!parent) node.nextSibling = null;
  else {
    node.nextSibling = parent.firstChild;
    parent.firstChild = node;
  }
  matrixIdentity(node.localBlock);
  if (!parent) matrixIdentity(node.worldBlock);
  else node.worldBlock.set(parent.worldBlock);
  node.renormCountdown = nextRenormSeed();
  node.userData = null;
  node.flags = 1;
  node.name = null;
  return node;
}

/**
 * @mw2 scene_node_set_userdata 0x0001def0
 * @fidelity exact
 */
export function sceneNodeSetUserdata(node: SceneNode, obj: WorldObject | null): void {
  node.userData = obj;
  node.flags |= 1;
}

/**
 * @mw2 scene_node_get_userdata 0x0001df00
 * @fidelity exact
 */
export function sceneNodeGetUserdata(node: SceneNode): WorldObject | null {
  return node.userData;
}

/**
 * The node's WORLD orientation as (pitch, yaw, roll).
 *
 * @mw2 scene_node_get_world_euler 0x0001df40
 * @fidelity exact
 */
export function sceneNodeGetWorldEuler(node: SceneNode): { pitch: number; yaw: number; roll: number } {
  return matrixToEuler(node.worldMatrix);
}

/**
 * @mw2 scene_node_get_world_pos 0x0001df60
 * @fidelity exact
 */
export function sceneNodeGetWorldPos(node: SceneNode): [number, number, number] {
  return [node.worldPos[0]!, node.worldPos[1]!, node.worldPos[2]!];
}

/**
 * @mw2 scene_node_set_origin 0x0001dfa0
 * @fidelity exact
 */
export function sceneNodeSetOrigin(node: SceneNode, x: number, y: number, z: number): void {
  node.localX = x;
  node.localY = y;
  node.localZ = z;
  node.flags |= 1;
}

/**
 * @mw2 scene_node_translate 0x0001dfc0
 * @fidelity exact
 */
export function sceneNodeTranslate(node: SceneNode, dx: number, dy: number, dz: number): void {
  node.localX = (node.localX + dx) | 0;
  node.localZ = (node.localZ + dz) | 0;
  node.localY = (node.localY + dy) | 0;
  node.flags |= 1;
}

/**
 * @mw2 scene_node_set_transform 0x0001dff0
 * @fidelity exact
 */
export function sceneNodeSetTransform(node: SceneNode, t: Int32Array): void {
  node.localBlock.set(t.subarray(0, 12));
  node.flags |= 1;
}

/**
 * @mw2 scene_node_set_local_matrix 0x0001e070
 * @fidelity exact
 */
export function sceneNodeSetLocalMatrix(node: SceneNode, m: Int32Array): void {
  node.localMatrix.set(m.subarray(0, 9));
  node.flags |= 1;
}

/**
 * localMatrix = localMatrix * rot, renormalised every 0x40..0xbf calls.
 *
 * @mw2 scene_node_rotate_local 0x0001e0b0
 * @fidelity exact
 */
export function sceneNodeRotateLocal(node: SceneNode, rot: Int32Array): void {
  matrixMultiply(node.localMatrix, rot, node.localMatrix);
  const c = (node.renormCountdown - 1) | 0;
  node.flags |= 1;
  node.renormCountdown = c;
  if (c === 0) {
    node.renormCountdown = nextRenormSeed();
    matrixRenormalise(node.localMatrix);
  }
}

const scratch = new Int32Array(12);

/**
 * @mw2 scene_node_set_euler 0x0001e100
 * @fidelity exact
 */
export function sceneNodeSetEuler(node: SceneNode, pitch: number, yaw: number, roll: number, order: number): void {
  matrixFromEuler(scratch, pitch, yaw, roll, 0, 0, 0, order);
  sceneNodeSetLocalMatrix(node, scratch);
}

/**
 * @mw2 scene_node_rotate_euler 0x0001e140
 * @fidelity exact
 */
export function sceneNodeRotateEuler(node: SceneNode, pitch: number, yaw: number, roll: number, order: number): void {
  const m = new Int32Array(12);
  matrixFromEuler(m, pitch, yaw, roll, 0, 0, 0, order);
  sceneNodeRotateLocal(node, m);
}

/** Depth-first walk applying fn to each node's userData, the shape of the scene_subtree_* family. */
function eachObject(node: SceneNode, fn: (o: WorldObject) => void): void {
  if (node.userData) fn(node.userData);
  for (let c = node.firstChild; c; c = c.nextSibling) eachObject(c, fn);
}

/**
 * @mw2 scene_subtree_move_to_alt_list 0x0001e1b0
 * @fidelity exact
 */
export function sceneSubtreeMoveToAltList(node: SceneNode): void {
  eachObject(node, objectMoveToAltList);
}

/**
 * Skips family 0x70 at the call site as well as inside object_move_to_world_list.
 *
 * @mw2 scene_subtree_move_to_world_list 0x0001e1f0
 * @fidelity exact
 */
export function sceneSubtreeMoveToWorldList(node: SceneNode): void {
  eachObject(node, (o) => {
    if ((o.type & 0xf0) !== 0x70) objectMoveToWorldList(o);
  });
}

/**
 * @mw2 scene_node_remove_subtree_from_world 0x0001e240
 * @fidelity exact
 */
export function sceneNodeRemoveSubtreeFromWorld(node: SceneNode): void {
  eachObject(node, objectRemoveFromWorld);
}

/**
 * @mw2 scene_node_link_subtree 0x0001e280
 * @fidelity exact
 */
export function sceneNodeLinkSubtree(node: SceneNode): void {
  eachObject(node, objectAddToWorld);
}

/**
 * @mw2 scene_subtree_move_to_aux_list 0x0001e2c0
 * @fidelity exact
 */
export function sceneSubtreeMoveToAuxList(node: SceneNode): void {
  eachObject(node, objectMoveToAuxList);
}

/**
 * @mw2 scene_subtree_set_object_type 0x0001e300
 * @fidelity exact
 */
export function sceneSubtreeSetObjectType(node: SceneNode, type: number): void {
  eachObject(node, (o) => (o.type = type & 0xffff));
}

/**
 * @mw2 scene_subtree_set_object_index 0x0001e340
 * @fidelity exact
 */
export function sceneSubtreeSetObjectIndex(node: SceneNode, index: number): void {
  eachObject(node, (o) => (o.index = index & 0xffff));
}

/**
 * @mw2 scene_subtree_set_object_class 0x0001e380
 * @fidelity exact
 */
export function sceneSubtreeSetObjectClass(node: SceneNode, objectClass: number): void {
  eachObject(node, (o) => objectSetClass(o, objectClass));
}

/**
 * @mw2 scene_subtree_clear_type_bits 0x0001e3c0
 * @fidelity exact
 */
export function sceneSubtreeClearTypeBits(node: SceneNode, bits: number): void {
  eachObject(node, (o) => (o.type = o.type & ~bits & 0xffff));
}

/**
 * world = parent.world (x) local for the node and every descendant; clears
 * dirty; refreshes each attached object's position and back-link.
 *
 * @mw2 scene_node_rebuild_subtree 0x0001e400
 * @fidelity exact
 */
export function sceneNodeRebuildSubtree(node: SceneNode): void {
  node.flags &= 0xfe;
  if (!node.parent) node.worldBlock.set(node.localBlock);
  else transformCompose(node.parent.worldBlock, node.localBlock, node.worldBlock);
  const obj = node.userData;
  if (obj) {
    objectUpdateWorldPos(obj, node.worldBlock);
    obj.node = node;
  }
  for (let c = node.firstChild; c; c = c.nextSibling) sceneNodeRebuildSubtree(c);
}

/**
 * Descends to dirty nodes and rebuilds from each.
 *
 * @mw2 scene_node_walk 0x0001e480
 * @fidelity exact
 */
export function sceneNodeWalk(node: SceneNode): void {
  if ((node.flags & 1) === 0) {
    for (let c = node.firstChild; c; c = c.nextSibling) sceneNodeWalk(c);
    return;
  }
  sceneNodeRebuildSubtree(node);
}

/**
 * @mw2 scene_node_first_child 0x0001e4e0
 * @fidelity exact
 */
export function sceneNodeFirstChild(node: SceneNode): SceneNode | null {
  return node.firstChild;
}

/**
 * @mw2 scene_node_next_sibling 0x0001e4f0
 * @fidelity exact
 */
export function sceneNodeNextSibling(node: SceneNode): SceneNode | null {
  return node.nextSibling;
}

/**
 * The local copy without the dirty bit.
 *
 * @mw2 scene_node_copy_transform 0x0001e510
 * @fidelity exact
 */
export function sceneNodeCopyTransform(node: SceneNode, t: Int32Array): void {
  node.localBlock.set(t.subarray(0, 12));
}

/**
 * The node's world transform block.
 *
 * @mw2 scene_node_transform 0x0001e540
 * @fidelity exact
 */
export function sceneNodeTransform(node: SceneNode): Int32Array {
  return node.worldBlock;
}

/**
 * Unparents a node without moving it: world becomes local.
 *
 * @mw2 scene_node_detach_keep_world 0x0001e580
 * @fidelity exact
 */
export function sceneNodeDetachKeepWorld(node: SceneNode): void {
  const p = node.parent;
  if (p) {
    if (p.firstChild === node) p.firstChild = node.nextSibling;
    else {
      let prev = p.firstChild;
      while (prev && prev.nextSibling !== node) prev = prev.nextSibling;
      if (prev) prev.nextSibling = node.nextSibling;
    }
  }
  node.parent = null;
  node.nextSibling = null;
  node.localBlock.set(node.worldBlock);
  node.flags |= 1;
  sceneNodeRebuildSubtree(node);
}

/**
 * Detaches and tears down a subtree, calling callback(userData) per node.
 *
 * @mw2 scene_subtree_destroy 0x0001e6a0
 * @fidelity exact
 * @divergence heap nodes are dropped for the garbage collector rather than freed
 */
export function sceneSubtreeDestroy(node: SceneNode, callback: ((o: WorldObject) => void) | null): void {
  sceneNodeDetachKeepWorld(node);
  let c = node.firstChild;
  while (c) {
    const next = c.nextSibling;
    sceneSubtreeDestroy(c, callback);
    c = next;
  }
  if (node.userData && callback) callback(node.userData);
}

/**
 * Unreached in the shipped game (SceneNode.name is never set); ported for completeness.
 *
 * @mw2 scene_node_find_by_name 0x0001e6f0
 * @fidelity exact
 */
export function sceneNodeFindByName(node: SceneNode, name: string): SceneNode | null {
  if (node.name !== null && node.name.toLowerCase() === name.toLowerCase()) return node;
  for (let c = node.firstChild; c; c = c.nextSibling) {
    const r = sceneNodeFindByName(c, name);
    if (r) return r;
  }
  return null;
}

/**
 * The child n places from the END of the child list, or null.
 *
 * @mw2 scene_node_child_from_last 0x0001e750
 * @fidelity exact
 */
export function sceneNodeChildFromLast(node: SceneNode | null, n: number): SceneNode | null {
  if (!node || !node.firstChild) return null;
  let count = 0;
  for (let c: SceneNode | null = node.firstChild; c; c = c.nextSibling) count++;
  let steps = count - 1 - n;
  if (steps < 0) return null;
  let c: SceneNode | null = node.firstChild;
  while (steps-- > 0 && c) c = c.nextSibling;
  return c;
}

/**
 * First node in a subtree whose object has hitLocation == location.
 *
 * @mw2 scene_subtree_find_location 0x0001e7a0
 * @fidelity exact
 */
export function sceneSubtreeFindLocation(node: SceneNode, location: number): SceneNode | null {
  if (node.userData && node.userData.hitLocation === location) return node;
  for (let c = node.firstChild; c; c = c.nextSibling) {
    const r = sceneSubtreeFindLocation(c, location);
    if (r) return r;
  }
  return null;
}

/**
 * @mw2 scene_node_size 0x0001e8b0
 * @fidelity exact
 */
export function sceneNodeSize(): number {
  return 0x7c;
}

/** Every node of a subtree, depth first. @portOnly for the editor */
export function* sceneNodes(root: SceneNode): Generator<SceneNode> {
  yield root;
  for (let c = root.firstChild; c; c = c.nextSibling) yield* sceneNodes(c);
}
