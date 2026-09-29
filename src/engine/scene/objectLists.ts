/**
 * The object lists: every WorldObject is on one parent/child list (listPrev/
 * listNext) under one of three sentinel headers, and optionally on the world
 * chain (worldPrev/worldNext) that collision and picking walk.
 *
 * The sentinels are WorldObject headers with nothing behind them. Their own
 * link fields ARE the list heads: worldListHead is worldRootNode.listNext,
 * altListHead altRootNode.listNext, auxListHead auxRootNode.listNext, and
 * worldChainHead is worldRootNode.worldNext - the same four bytes in C,
 * reached as absolute addresses. The accessors below keep that aliasing.
 *
 * Flags used here (WorldObject.flags high byte): 0x0800 off the world chain,
 * 0x1000 on altRootNode's list.
 */

import { WorldObject } from '../../generated/classes.gen.ts';
import { registerGlobals } from '../globals.ts';
import { presentNoteFresh } from './present.ts';


export const worldRootNode = new WorldObject(); // 0xf44c0
export const altRootNode = new WorldObject(); // 0xf44ac
export const auxRootNode = new WorldObject(); // 0xf44d4

export const objectLists = registerGlobals(
  'objectLists',
  {
    worldRootNode,
    altRootNode,
    auxRootNode,
    /** which sentinel the world chain hangs off; object_link and the list moves act only while it is worldRootNode (address not looked up) */
    worldRoot: worldRootNode as WorldObject | null,
    altRoot: altRootNode as WorldObject | null,
  },
  objectListsReset,
);

// C aliases: the list heads are fields of the sentinels.
const H = {
  get worldListHead(): WorldObject | null {
    return worldRootNode.listNext;
  },
  set worldListHead(v: WorldObject | null) {
    worldRootNode.listNext = v;
  },
  get altListHead(): WorldObject | null {
    return altRootNode.listNext;
  },
  set altListHead(v: WorldObject | null) {
    altRootNode.listNext = v;
  },
  get auxListHead(): WorldObject | null {
    return auxRootNode.listNext;
  },
  set auxListHead(v: WorldObject | null) {
    auxRootNode.listNext = v;
  },
  get worldChainHead(): WorldObject | null {
    return worldRootNode.worldNext;
  },
  set worldChainHead(v: WorldObject | null) {
    worldRootNode.worldNext = v;
  },
};
export { H as listHeads };

const hi = (o: WorldObject): number => (o.flags >> 8) & 0xff;
const setHi = (o: WorldObject, v: number): void => {
  o.flags = (o.flags & 0x00ff) | ((v & 0xff) << 8);
};

/**
 * @mw2 object_lists_reset 0x0001f730
 * @fidelity exact
 */
export function objectListsReset(): void {
  for (const s of [worldRootNode, altRootNode, auxRootNode]) {
    s.listPrev = s.listNext = s.worldPrev = s.worldNext = null;
    s.flags = 0x4000;
  }
  objectLists.altRoot = altRootNode;
  objectLists.worldRoot = worldRootNode;
}

/**
 * Pushes an object onto the front of its parent/child list (altRootNode's if
 * flags 0x1000, else worldRootNode's) and, unless it is off-chain, onto the
 * world chain. objectClass 4 marks it off-chain (0x0800) first.
 *
 * @mw2 object_link 0x0001f7c0
 * @fidelity exact
 */
export function objectLink(obj: WorldObject | null): void {
  if (objectLists.worldRoot !== worldRootNode || !obj) return;
  const parent = (hi(obj) & 0x10) === 0 ? worldRootNode : altRootNode;
  // port-only: an object entering the drawn world has nothing on screen to be drawn from (present.ts)
  if (parent === worldRootNode && obj.node) presentNoteFresh(obj.node);
  if (parent.listNext) parent.listNext.listPrev = obj;
  obj.listNext = parent.listNext;
  parent.listNext = obj;
  obj.listPrev = parent;
  if (obj.objectClass === 4) setHi(obj, hi(obj) | 8);
  if ((hi(obj) & 8) === 0) {
    if (H.worldChainHead) H.worldChainHead.worldPrev = obj;
    obj.worldNext = H.worldChainHead;
    H.worldChainHead = obj;
    obj.worldPrev = worldRootNode;
  }
}

/**
 * @mw2 object_unlink 0x0001f860
 * @fidelity exact
 */
export function objectUnlink(obj: WorldObject | null): void {
  if (!obj || obj === objectLists.worldRoot || obj === altRootNode) return;
  if (obj.listNext) obj.listNext.listPrev = obj.listPrev;
  if (obj.listPrev) obj.listPrev.listNext = obj.listNext;
  obj.listPrev = obj.listNext = null;
  if (obj.worldNext) obj.worldNext.worldPrev = obj.worldPrev;
  if (obj.worldPrev) obj.worldPrev.worldNext = obj.worldNext;
  obj.worldPrev = obj.worldNext = null;
}

function listRemove(obj: WorldObject): void {
  if (obj.listNext) obj.listNext.listPrev = obj.listPrev;
  if (obj.listPrev) obj.listPrev.listNext = obj.listNext;
  obj.listPrev = obj.listNext = null;
}

/**
 * @mw2 object_move_to_aux_list 0x0001f8e0
 * @fidelity exact
 */
export function objectMoveToAuxList(obj: WorldObject | null): void {
  if (objectLists.worldRoot !== worldRootNode || !obj) return;
  listRemove(obj);
  if (H.auxListHead) H.auxListHead.listPrev = obj;
  obj.listNext = H.auxListHead;
  H.auxListHead = obj;
  obj.listPrev = auxRootNode;
}

/**
 * Onto the world chain; clears the off-chain bit. Guarded: must be off-chain,
 * not class 4, already on a list, and a world root must exist.
 *
 * @mw2 object_add_to_world 0x0001f950
 * @fidelity exact
 */
export function objectAddToWorld(obj: WorldObject | null): void {
  if (!obj || (hi(obj) & 8) === 0 || obj.objectClass === 4) return;
  const prev = obj.listPrev;
  setHi(obj, hi(obj) & 0xf7);
  const root = objectLists.worldRoot;
  if (!prev || !root) return;
  if (root.worldNext) root.worldNext.worldPrev = obj;
  obj.worldNext = root.worldNext;
  root.worldNext = obj;
  obj.worldPrev = root;
}

/**
 * Off the world chain (stays in the scene tree); sets the off-chain bit.
 *
 * @mw2 object_remove_from_world 0x0001f9b0
 * @fidelity exact
 */
export function objectRemoveFromWorld(obj: WorldObject | null): void {
  if (!obj || (hi(obj) & 8) !== 0) return;
  setHi(obj, hi(obj) | 8);
  if (!objectLists.worldRoot) return;
  if (obj.worldNext) obj.worldNext.worldPrev = obj.worldPrev;
  if (obj.worldPrev) obj.worldPrev.worldNext = obj.worldNext;
  obj.worldPrev = obj.worldNext = null;
}

/**
 * Onto altRootNode's list, marking 0x1000 (once).
 *
 * @mw2 object_move_to_alt_list 0x0001fa10
 * @fidelity exact
 */
export function objectMoveToAltList(obj: WorldObject | null): void {
  if (!obj || (hi(obj) & 0x10) !== 0) return;
  setHi(obj, hi(obj) | 0x10);
  if (!obj.listPrev) return;
  listRemove(obj);
  if (H.altListHead) H.altListHead.listPrev = obj;
  obj.listNext = H.altListHead;
  H.altListHead = obj;
  obj.listPrev = altRootNode;
}

/**
 * Back onto worldRootNode's list, clearing 0x1000. Refuses family 0x70.
 *
 * @mw2 object_move_to_world_list 0x0001fa90
 * @fidelity exact
 */
export function objectMoveToWorldList(obj: WorldObject | null): void {
  if (!obj || (hi(obj) & 0x10) === 0 || (obj.type & 0xf0) === 0x70) return;
  setHi(obj, hi(obj) & 0xef);
  // port-only: back in the drawn world, from nowhere on screen (present.ts)
  if (obj.node) presentNoteFresh(obj.node);
  if (!obj.listPrev) return;
  listRemove(obj);
  if (H.worldListHead) H.worldListHead.listPrev = obj;
  obj.listNext = H.worldListHead;
  H.worldListHead = obj;
  obj.listPrev = worldRootNode;
}

/**
 * @mw2 object_list_unlink 0x0001fb90
 * @fidelity exact
 */
export function objectListUnlink(obj: WorldObject): void {
  listRemove(obj);
}

/**
 * @mw2 object_list_insert_after 0x0001fbd0
 * @fidelity exact
 */
export function objectListInsertAfter(obj: WorldObject, after: WorldObject): void {
  if (after.listNext) after.listNext.listPrev = obj;
  obj.listNext = after.listNext;
  after.listNext = obj;
  obj.listPrev = after;
}

/** Every object on a sentinel's list, in order. @portOnly for the editor */
export function* objectsOnList(sentinel: WorldObject): Generator<WorldObject> {
  for (let o = sentinel.listNext; o; o = o.listNext) yield o;
}

/** Every object on the world chain. @portOnly for the editor and picking */
export function* worldChain(): Generator<WorldObject> {
  for (let o = worldRootNode.worldNext; o; o = o.worldNext) yield o;
}

objectListsReset();

/**
 * A detail option: family 0xc0 objects (the LIGHT and *SPRS* meshes) put
 * back into the world from altRootNode's list, or - visible 0 - each one on
 * the world chain flagged 0x1000 and moved onto altRootNode's list (when
 * not already flagged and it has a previous link) and taken out of the
 * world.
 *
 * @mw2 scenery_c0_set_visible 0x0001fbf0
 * @fidelity exact
 */
export function sceneryC0SetVisible(visible: number): void {
  if (visible !== 0) {
    let o = altRootNode.listNext;
    while (o) {
      const next = o.listNext;
      if ((o.type & 0xf0) === 0xc0) {
        objectMoveToWorldList(o);
        objectAddToWorld(o);
      }
      o = next;
    }
    return;
  }
  let o = worldRootNode.listNext;
  while (o) {
    const next = o.listNext;
    if ((o.type & 0xf0) === 0xc0) {
      if ((o.flags & 0x1000) === 0) {
        o.flags |= 0x1000;
        if (o.listPrev) {
          objectListUnlink(o);
          objectListInsertAfter(o, altRootNode);
        }
      }
      objectRemoveFromWorld(o);
    }
    o = next;
  }
}
