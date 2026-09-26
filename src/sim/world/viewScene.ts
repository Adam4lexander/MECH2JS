/**
 * The mission-start sort of the world list for the main view: the backdrop
 * model taken out to be drawn on its own, the cockpit head found, family
 * 0x70 hidden, and objectClass 4 taken off the world chain.
 */
import type { SceneNode } from '../../generated/classes.gen.ts';
import { registerGlobals } from '../../engine/globals.ts';
import { objectMoveToAltList, objectRemoveFromWorld, objectsOnList, worldRootNode } from '../../engine/scene/objectLists.ts';
import { sceneSubtreeMoveToAuxList } from '../../engine/scene/sceneGraph.ts';
import { objectGetNode } from '../../engine/scene/worldObject.ts';

export const viewScene = registerGlobals(
  'viewScene',
  {
    /**
     * 0x95508: the scene node of the first world object of type family 0x90.
     * The frame render draws its tree before anything else, with the far
     * clip lifted (render_scene_tree_sorted under the cull hook at 0x3f780):
     * a backdrop behind the world.
     */
    backdropNode: null as SceneNode | null,
    /** 0x9550c: the scene node of the first world object of type family 0xa0 (the mech heads), drawn over the scene in the cockpit view */
    cockpitHeadNode: null as SceneNode | null,
  },
  () => {
    viewScene.backdropNode = null;
    viewScene.cockpitHeadNode = null;
  },
);

/**
 * Called by main once the mission is running, after world_records_tick.
 * Walks the world list three times (disassembly 0x103c0..0x1048b):
 *  1. the first object of type family 0x90 becomes backdropNode, and its
 *     whole subtree moves to the aux list;
 *  2. the first object of family 0xa0 becomes cockpitHeadNode (left where it is);
 *  3. every object of family 0x70 moves to the alt list (so it is not
 *     drawn) and off the world chain; every object with objectClass 4 comes
 *     off the world chain only. The world chain (+0xc / +0x10,
 *     object_remove_from_world) is the one world_find_highest_hit searches -
 *     not the draw list - so objectClass 4 objects are still drawn but no
 *     longer found by that search.
 * Each walk starts again from the head of the world list, so the third does
 * not see the backdrop's objects.
 *
 * @mw2 vfx_video_sub_0103c0 0x000103c0
 * @fidelity exact
 */
export function vfxVideoSub0103c0(): void {
  const v = viewScene;
  for (const o of objectsOnList(worldRootNode)) {
    if ((o.type & 0xf0) === 0x90) {
      v.backdropNode = objectGetNode(o);
      if (v.backdropNode) sceneSubtreeMoveToAuxList(v.backdropNode);
      break;
    }
  }
  for (const o of objectsOnList(worldRootNode)) {
    if ((o.type & 0xf0) === 0xa0) {
      v.cockpitHeadNode = objectGetNode(o);
      break;
    }
  }
  for (const o of [...objectsOnList(worldRootNode)]) {
    if ((o.type & 0xf0) === 0x70) {
      objectMoveToAltList(o);
      objectRemoveFromWorld(o);
    }
    if (o.objectClass === 4) objectRemoveFromWorld(o);
  }
}
