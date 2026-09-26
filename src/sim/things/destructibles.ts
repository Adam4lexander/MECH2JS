/**
 * destructibles: 128 Destructible slots - scene nodes that have become
 * shootable debris. Each gets a fallingObjects slot too, so it falls and
 * tumbles; it lasts 20 seconds (destructibles_update) or until shot.
 */
import { Destructible } from '../../generated/classes.gen.ts';
import type { SceneNode } from '../../generated/classes.gen.ts';
import type { CodeFn } from '../../engine/codePtr.ts';
import { clock } from '../../engine/clock.ts';
import { registerGlobals } from '../../engine/globals.ts';
import {
  sceneNodeDetachKeepWorld,
  sceneNodeFirstChild,
  sceneNodeNextSibling,
  sceneNodeRemoveSubtreeFromWorld,
  sceneNodeWalk,
  sceneSubtreeClearTypeBits,
  sceneSubtreeMoveToAltList,
  sceneSubtreeSetObjectIndex,
  sceneSubtreeSetObjectType,
} from '../../engine/scene/sceneGraph.ts';
import { objectSetType } from '../../engine/scene/worldObject.ts';
import { falling, fallingObjectAttach, fallingObjectClear, fallingObjectFind, fallingObjectRandomiseMotion, FALLING_COUNT } from './fallingObjects.ts';

export const DESTRUCTIBLE_COUNT = 0x80;

export const destructibleGlobals = registerGlobals(
  'destructibles',
  {
    destructibles: Array.from({ length: DESTRUCTIBLE_COUNT }, () => new Destructible()),
  },
  () => {
    destructibleGlobals.destructibles = Array.from({ length: DESTRUCTIBLE_COUNT }, () => new Destructible());
  },
);

/**
 * Takes a subtree out of the world: objects to the alt list, off the world
 * chain, then a walk.
 *
 * @mw2 scene_node_detach_from_world 0x0002bf00
 * @fidelity exact
 */
export function sceneNodeDetachFromWorld(node: SceneNode | null): void {
  if (!node) return;
  sceneSubtreeMoveToAltList(node);
  sceneNodeRemoveSubtreeFromWorld(node);
  sceneNodeWalk(node);
}

/**
 * Registers one node as destructible debris (16 hit points, a falling slot,
 * a random tumble). Family 0x70 or an unlocated part of a located release
 * becomes family 0x50 and is torn down at once, as is anything when all 128
 * slots are taken.
 *
 * @mw2 destructible_register 0x0002b500
 * @fidelity exact
 */
export function destructibleRegister(node: SceneNode | null, onRelease: CodeFn | null, location: number): void {
  if (!node || !node.userData) return;
  const family = node.userData.type & 0xf0;
  let immediate = false;
  if (family === 0x70 || (location !== 0 && node.userData.hitLocation === 0)) {
    objectSetType(node.userData, 0x50);
    immediate = true;
  }
  const d = destructibleGlobals.destructibles;
  let i = 0;
  while (i < DESTRUCTIBLE_COUNT && d[i]!.active !== 0) i++;
  if (i === DESTRUCTIBLE_COUNT || immediate) {
    sceneNodeDetachKeepWorld(node);
    sceneNodeDetachFromWorld(node);
    onRelease?.(node);
  } else {
    const slot = fallingObjectAttach(node, 2);
    if (slot >= 0) {
      const s = d[i]!;
      s.active = 1;
      s.hitPoints = 0x100000;
      s.node = node;
      s.registeredTick = clock.simTick;
      s.onRelease = onRelease;
      sceneSubtreeClearTypeBits(node, 0x300);
      sceneSubtreeSetObjectType(node, 0x50);
      sceneSubtreeSetObjectIndex(node, i);
      fallingObjectRandomiseMotion(slot);
      return;
    }
    sceneNodeDetachFromWorld(node);
    onRelease?.(node);
  }
  const f = fallingObjectFind(node);
  if (f !== -1) fallingObjectClear(f);
}

/**
 * Post-order: first child's subtree, then the next sibling's, then the node.
 *
 * @mw2 destructibles_register_subtree 0x0002b640
 * @fidelity exact
 */
export function destructiblesRegisterSubtree(node: SceneNode | null, onRelease: CodeFn | null, location: number): void {
  if (!node) return;
  const c = sceneNodeFirstChild(node);
  if (c) destructiblesRegisterSubtree(c, onRelease, location);
  const s = sceneNodeNextSibling(node);
  if (s) destructiblesRegisterSubtree(s, onRelease, location);
  destructibleRegister(node, onRelease, location);
}

/**
 * Releases every slot (calling its onRelease), restores each from the
 * all-zero template at 0x96360, then clears the falling-object table.
 *
 * @mw2 destructibles_reset 0x0002bcd0
 * @fidelity exact
 */
export function destructiblesReset(): void {
  const d = destructibleGlobals.destructibles;
  for (let i = 0; i < DESTRUCTIBLE_COUNT; i++) {
    const s = d[i]!;
    if (s.node && s.onRelease) s.onRelease(s.node);
    d[i] = new Destructible();
  }
  for (let i = 0; i < FALLING_COUNT; i++) fallingObjectClear(i);
  void falling;
}
