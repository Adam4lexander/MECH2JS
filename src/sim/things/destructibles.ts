/**
 * destructibles: 128 Destructible slots - scene nodes that have become
 * shootable debris. Each gets a fallingObjects slot too, so it falls and
 * tumbles; it lasts 20 seconds (destructibles_update) or until shot.
 */
import { mulr16 } from '../../core/int/fx16.ts';
import { Destructible } from '../../generated/classes.gen.ts';
import type { SceneNode } from '../../generated/classes.gen.ts';
import type { CodeFn } from '../../engine/codePtr.ts';
import { clock } from '../../engine/clock.ts';
import { registerGlobals } from '../../engine/globals.ts';
import {
  sceneNodeDetachKeepWorld,
  sceneNodeFirstChild,
  sceneNodeGetUserdata,
  sceneNodeNextSibling,
  sceneNodeRemoveSubtreeFromWorld,
  sceneNodeWalk,
  sceneSubtreeClearTypeBits,
  sceneSubtreeMoveToAltList,
  sceneSubtreeSetObjectIndex,
  sceneSubtreeSetObjectType,
} from '../../engine/scene/sceneGraph.ts';
import { objectGetPosRadius, objectSetType } from '../../engine/scene/worldObject.ts';
import { effectSpawnAt } from '../effects/effects.ts';
import { mechRuntime } from '../mech/mechRuntime.ts';
import { falling, fallingObjectAttach, fallingObjectClear, fallingObjectFind, fallingObjectRandomiseMotion, fallingObjectTick, FALLING_COUNT } from './fallingObjects.ts';

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

/**
 * The per-frame pass over two tables: falling_object_tick on all 128
 * fallingObjects slots, then - unless the player is out - every live
 * destructible registered more than 0xe38 ticks (20 s) ago is retired: its
 * subtree detached from the world, the node handed to its callback, its
 * falling slot cleared, and the slot restored from the zero template. An
 * expired object leaves quietly, with no effect.
 *
 * @mw2 destructibles_update 0x0002b740
 * @fidelity exact
 */
export function destructiblesUpdate(): void {
  for (let i = 0; i < FALLING_COUNT; i++) fallingObjectTick(i);
  const d = destructibleGlobals.destructibles;
  for (let i = 0; i < DESTRUCTIBLE_COUNT; i++) {
    const s = d[i]!;
    if (s.active === 1 && 0xe38 < ((clock.simTick - s.registeredTick) | 0) && mechRuntime.playerOut === 0) {
      const node = s.node;
      const onRelease = s.onRelease;
      if (node) {
        sceneNodeDetachFromWorld(node);
        onRelease?.(node);
        const f = fallingObjectFind(node);
        if (f !== -1) fallingObjectClear(f);
      }
      d[i] = new Destructible();
    }
  }
}

/**
 * Takes damage (16.16 points) off a slot's hit points and blows it up once
 * they go negative.
 *
 * @mw2 destructible_apply_damage 0x0002b900
 * @fidelity exact
 */
export function destructibleApplyDamage(slot: number, damage: number): void {
  const s = destructibleGlobals.destructibles[slot]!;
  s.hitPoints = (s.hitPoints - damage) | 0;
  if (s.hitPoints < 0) destructibleDestroy(slot);
}

/**
 * Blows up one slot: effect 7 at its object's position, the subtree off the
 * world, the node to the callback, its falling slot cleared, and the slot
 * restored from the zero template. Nothing for a slot with no node.
 *
 * @mw2 destructible_destroy 0x0002b800
 * @fidelity exact
 */
export function destructibleDestroy(slot: number): void {
  const d = destructibleGlobals.destructibles;
  const node = d[slot]!.node;
  if (!node) return;
  const p = objectGetPosRadius(sceneNodeGetUserdata(node)!);
  effectSpawnAt(7, p.x, p.y, p.z, p.x, p.y, p.z);
  sceneSubtreeMoveToAltList(node);
  sceneNodeRemoveSubtreeFromWorld(node);
  sceneNodeWalk(node);
  d[slot]!.onRelease?.(node);
  // the C inlines falling_object_find and falling_object_clear here
  const f = fallingObjectFind(node);
  if (f !== -1) fallingObjectClear(f);
  d[slot] = new Destructible();
}

/**
 * A blast's share for the destructibles: from slot 127 down, every live
 * slot with a node whose object lies within blastRadius + its own radius
 * (exact 64-bit squared distance, inclusive) loses (rate * tickDelta) >> 16,
 * rounded, of its 16.16 hit points - an extra >> 16 against what
 * mechs_blast_damage gives a mech, so blasts all but never destroy
 * scenery - and is destroyed below 0.
 *
 * @mw2 destructibles_blast_damage 0x0002be00
 * @fidelity exact
 */
export function destructiblesBlastDamage(x: number, y: number, z: number, radius: number, rate: number): void {
  const d = destructibleGlobals.destructibles;
  for (let i = DESTRUCTIBLE_COUNT - 1; i >= 0; i--) {
    const s = d[i]!;
    if (s.active === 0 || !s.node) continue;
    const p = objectGetPosRadius(sceneNodeGetUserdata(s.node)!);
    const dx = BigInt((p.x - x) | 0);
    const dy = BigInt((p.y - y) | 0);
    const dz = BigInt((p.z - z) | 0);
    const r = BigInt((radius + p.radius) | 0);
    // the squared distance is summed in 64 bits and compared unsigned
    const dist = BigInt.asUintN(64, dx * dx + dy * dy + dz * dz);
    if (dist <= BigInt.asUintN(64, r * r)) {
      s.hitPoints = (s.hitPoints - mulr16(rate, clock.tickDelta)) | 0;
      if (s.hitPoints < 0) destructibleDestroy(i);
    }
  }
}
