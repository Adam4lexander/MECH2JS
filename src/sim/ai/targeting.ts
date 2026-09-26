/**
 * Targeting: what a mech may aim at and how the player's target is picked.
 *
 * A target is a handle (MechEntity.targetHandle): type 0x200 a mech, 0x400 a
 * gamething, 0x100 a tracked object (navpoint or waypoint), with the index
 * in the low byte; the bit 0x1000 marks it as NONE (dropped or not found).
 * Three validators share a vocabulary - 1 accepted (after writing the
 * target's position and bearing into the asking mech), -1 index below 0,
 * -2 past the table, -9 a forbidden mode bit, others per type - and
 * ai_cycle_target walks the ring mechs -> gamethings -> tracked objects
 * asking them. See the upstream notes on ai_cycle_target and the validators
 * for the mode word.
 */
import type { MechEntity } from '../../generated/classes.gen.ts';
import { LABEL } from '../../generated/labels.gen.ts';
import { vecToRangeBearing } from '../../core/math/vec.ts';
import { registerGlobals } from '../../engine/globals.ts';
import { imageI32 } from '../../engine/image.ts';
import { sceneNodeGetUserdata, sceneNodeGetWorldPos } from '../../engine/scene/sceneGraph.ts';
import type { SceneNode } from '../../generated/classes.gen.ts';
import { mechAllegiance } from '../groups/groups.ts';
import { mechs } from '../mech/mechGlobals.ts';
import { soundPlay } from '../sound/sound.ts';
import { gamethingAllegiance } from '../things/gameThingDamage.ts';
import { things } from '../things/gameThings.ts';
import { aim } from '../weapons/aim.ts';
import { worldObjectGetPos, worldObjectNode, worldRecordObject } from '../world/worldRecords.ts';
import { trackedGlobals } from './tracked.ts';

export const targeting = registerGlobals(
  'targeting',
  {
    /**
     * 0x96290: the player's current target was chosen with the reticle
     * (player_target_reticle sets it, ai_cycle_target clears it for the
     * player); while set the player may keep a powered-down or
     * non-combatant target.
     */
    playerTargetFromReticle: 0,
    /**
     * 0x9628c: what ai_validate_current_target's inspection of the player's
     * target found: 0 nothing to report (inspect_target not held, or a
     * tracked object), 1 in inspection range (the target's radius / range +
     * 200 m) and now identified, 2 out of range, 3 already identified. The
     * target readout (hud_target_readout_tick) reads it.
     */
    targetInspectResult: 0,
  },
  () => {
    targeting.playerTargetFromReticle = imageI32(LABEL.playerTargetFromReticle, 0);
    targeting.targetInspectResult = imageI32(0x9628c, 0);
  },
);

/** 0x2ab98 cm, 1750 m: the player's targeting range for anything without flags 0x1000. */
const PLAYER_TARGET_RANGE = 0x2ab98;

function writeTarget(m: MechEntity, x: number, y: number, z: number): void {
  const rb = vecToRangeBearing((x - m.posX) | 0, (y - m.posY) | 0, (z - m.posZ) | 0);
  m.targetX = x;
  m.targetY = y;
  m.targetZ = z;
  m.desiredHeading = rb.azimuth;
  m.targetSlantRange = rb.slantRange;
  m.targetDistance = rb.groundRange;
  m.torsoTilt = rb.elevation;
}

/**
 * The trackedObjects validator: forbidden mode bits 0xe; -3 not in use, -4
 * mode 0x10000 without flags 0x40, -6 a temporary waypoint (flags bit 0) not
 * this mech's own or, with mode 0x100, an ordinary navpoint, -6 another
 * group's. Accepting refreshes a followed object's position from its node.
 *
 * @mw2 ai_validate_tracked 0x0002a0a0
 * @fidelity exact
 */
export function aiValidateTracked(mechIndex: number, objectIndex: number, mode: number): number {
  const g = trackedGlobals;
  if (objectIndex < 0) return -1;
  if (g.trackedObjectCount <= objectIndex) return -2;
  if ((mode & 0xe) !== 0) return -9;
  const m = mechs.mechTable[mechIndex]!;
  const t = g.trackedObjects[objectIndex]!;
  if (t.inUse === 0) return -3;
  if ((mode & 0x10000) !== 0 && (t.flags & 0x40) === 0) return -4;
  if ((t.flags & 1) === 0) {
    if ((mode & 0x100) !== 0) return -6;
  } else if ((mechIndex | 0x200) !== t.targetHandle) return -6;
  if (t.groupId !== m.groupId) return -6;
  if (t.followNode) {
    const p = sceneNodeGetWorldPos(t.followNode);
    t.x = p[0];
    t.y = p[1];
    t.z = p[2];
  }
  writeTarget(m, t.x, t.y, t.z);
  return 1;
}

/**
 * The mechTable validator: forbidden mode bits 0x15; -3 for the player
 * against a powered-down mech (flags 0x10) unless by reticle, destroyed
 * (flags & 6) or itself; -4 mode 0x10000 without flags 0x40; -9 wrong
 * allegiance for 0x20000 / 0x40000; for the player -5 neither combatant bit
 * (0x400 / 0x1000) unless by reticle, -5 the never-target bit 0x800; -8 no
 * node or userdata; -7 for the player beyond 1750 m without flags 0x1000.
 *
 * @mw2 ai_validate_target 0x0002a210
 * @fidelity exact
 */
export function aiValidateTarget(attackerIndex: number, targetIndex: number, mode: number): number {
  const m = mechs;
  if (targetIndex < 0) return -1;
  if (m.mechCount <= targetIndex) return -2;
  if ((mode & 0x15) !== 0) return -9;
  const target = m.mechTable[targetIndex]!;
  const attacker = m.mechTable[attackerIndex]!;
  const player = attackerIndex === m.playerMechIndex;
  if (targeting.playerTargetFromReticle === 0 && (target.flags & 0x10) !== 0 && player) return -3;
  if ((target.flags & 6) !== 0) return -3;
  if (attackerIndex === target.index) return -3;
  if ((mode & 0x10000) !== 0 && (target.flags & 0x40) === 0) return -4;
  if ((mode & 0x20000) !== 0 && mechAllegiance(targetIndex) !== 0) return -9;
  if ((mode & 0x40000) !== 0 && mechAllegiance(targetIndex) !== 1) return -9;
  if (targeting.playerTargetFromReticle === 0 && ((target.flags >> 8) & 0x14) === 0 && player) return -5;
  if (((target.flags >> 8) & 8) !== 0 && player) return -5;
  if (!target.node) return -8;
  if (!sceneNodeGetUserdata(target.node)) return -8;
  const x = target.posX;
  const y = target.posY;
  const z = target.posZ;
  const rb = vecToRangeBearing((x - attacker.posX) | 0, (y - attacker.posY) | 0, (z - attacker.posZ) | 0);
  if (((target.flags >> 8) & 0x10) === 0 && PLAYER_TARGET_RANGE < rb.slantRange && player) return -7;
  attacker.targetX = x;
  attacker.targetY = y;
  attacker.targetZ = z;
  attacker.desiredHeading = rb.azimuth;
  attacker.targetSlantRange = rb.slantRange;
  attacker.targetDistance = rb.groundRange;
  attacker.torsoTilt = rb.elevation;
  return 1;
}

/**
 * The gameThings validator: forbidden mode bits 0x23; -3 destroyed (flags
 * 4); -9 wrong allegiance; for the player -5 neither combatant bit unless by
 * reticle, -5 never-target; -8 no node or world record; -7 for the player
 * beyond 1750 m without flags 0x1000.
 *
 * @mw2 ai_validate_gamething 0x0002a460
 * @fidelity exact
 */
export function aiValidateGamething(mechIndex: number, thingIndex: number, mode: number): number {
  const t = things;
  if (thingIndex < 0) return -1;
  if (t.gameThingCount <= thingIndex) return -2;
  if ((mode & 0x23) !== 0) return -9;
  const g = t.gameThings[thingIndex]!;
  const m = mechs.mechTable[mechIndex]!;
  if ((g.flags & 4) !== 0) return -3;
  // the 0x10000 test is dead in the original: ((flags & 0x40) == 0) is 0 or 1, and it is ANDed with the mode bit
  const player = mechIndex === mechs.playerMechIndex;
  if ((mode & 0x20000) !== 0 && gamethingAllegiance(thingIndex) !== 0) return -9;
  if ((mode & 0x40000) !== 0 && gamethingAllegiance(thingIndex) !== 1) return -9;
  if (targeting.playerTargetFromReticle === 0 && ((g.flags >> 8) & 0x14) === 0 && player) return -5;
  if (((g.flags >> 8) & 8) !== 0 && player) return -5;
  if (!worldObjectNode(g.geomIndex)) return -8;
  if (!worldRecordObject(g.geomIndex)) return -8;
  const [x, y, z] = worldObjectGetPos(g.geomIndex);
  const rb = vecToRangeBearing((x - m.posX) | 0, (y - m.posY) | 0, (z - m.posZ) | 0);
  if (((g.flags >> 8) & 0x10) === 0 && PLAYER_TARGET_RANGE < rb.slantRange && player) return -7;
  m.targetX = x;
  m.targetY = y;
  m.targetZ = z;
  m.desiredHeading = rb.azimuth;
  m.targetSlantRange = rb.slantRange;
  m.targetDistance = rb.groundRange;
  m.torsoTilt = rb.elevation;
  return 1;
}

/**
 * Steps the mech's targetHandle round the ring mechs -> gamethings ->
 * tracked objects to the next candidate its validator accepts under `mode`:
 * step +1 next, -1 previous, 0 (or a NONE handle) restarts at mech 0. At
 * most mechCount + gameThingCount + trackedObjectCount + 3 candidates are
 * tried; with none accepted the old handle keeps its value with 0x1000 set.
 * Ending on anything but a tracked object while the autopilot is engaged
 * raises the autopilot toggle request.
 *
 * @mw2 ai_cycle_target 0x00029e90
 * @fidelity exact
 */
export function aiCycleTarget(mech: MechEntity, step: number, mode: number): void {
  if (mech.index === mechs.playerMechIndex) targeting.playerTargetFromReticle = 0;
  let index: number;
  let type = mech.targetHandle & 0xf00;
  let dir: number;
  if (step === 0 || (mech.targetHandle & 0x1000) !== 0) {
    type = 0x200;
    index = 0;
    dir = 1;
  } else {
    index = ((mech.targetHandle & 0xff) + step) | 0;
    dir = step;
  }
  const limit = (mechs.mechCount + things.gameThingCount + trackedGlobals.trackedObjectCount + 3) | 0;
  let found = 0;
  for (let tries = 0; tries < limit && found === 0; tries++) {
    if (type === 0x200) {
      const r = aiValidateTarget(mech.index, index, mode);
      if (r === 1) found = 1;
      else if (r === -2) {
        type = 0x400;
        index = 0;
      } else if (r === -1) {
        type = 0x100;
        index = (trackedGlobals.trackedObjectCount - 1) | 0;
      } else index = (index + dir) | 0;
    } else if (type === 0x400) {
      const r = aiValidateGamething(mech.index, index, mode);
      if (r === 1) found = 1;
      else if (r === -2) {
        type = 0x100;
        index = 0;
      } else if (r === -1) {
        type = 0x200;
        index = (mechs.mechCount - 1) | 0;
      } else index = (index + dir) | 0;
    } else if (type === 0x100) {
      const r = aiValidateTracked(mech.index, index, mode);
      if (r === 1) found = 1;
      else if (r === -2) {
        type = 0x200;
        index = 0;
      } else if (r === -1) {
        type = 0x400;
        index = (things.gameThingCount - 1) | 0;
      } else index = (index + dir) | 0;
    } else {
      // any other type restarts at mech 0 (LAB_0002a02c); the try is counted
      type = 0x200;
      index = 0;
    }
  }
  if (found === 0) mech.targetHandle = (mech.targetHandle | 0x1000) | 0;
  else mech.targetHandle = (type | index) | 0;
  if (type !== 0x100 && mech.loadout!.autopilotEngaged !== 0) mech.control!.autopilot = 1;
}

/**
 * Re-validates the mech's target with its type's validator (mode 0) and
 * drops it (0x1000) when refused, returning 0; otherwise 1. A tracked object
 * reached (targetDistance under its range) by the player without the
 * autopilot is marked seen (flags 0x20, seenByGroups, sound 0xe7 once) and
 * the player moves on to the next navpoint. For the player it then answers
 * the inspect_target control into targetInspectResult, identifying (flags
 * 0x20, seenByGroups) a mech or gamething within its radius / range + 200 m.
 *
 * @mw2 ai_validate_current_target 0x0002a670
 * @fidelity exact
 */
export function aiValidateCurrentTarget(mech: MechEntity): number {
  let drop = true;
  const type = mech.targetHandle & 0xf00;
  const index = mech.targetHandle & 0xff;
  const tracked = trackedGlobals.trackedObjects;
  if (type < 0x200) {
    if (type === 0x100 && aiValidateTracked(mech.index, index, 0) > -1) {
      drop = false;
      const t = tracked[index]!;
      if (mech.targetDistance < t.range && mech.loadout!.autopilotEngaged !== 1 && mechs.playerMechIndex === mech.index) {
        if ((t.flags & 0x20) === 0) {
          t.flags = (t.flags | 0x20) & 0xffff;
          t.seenByGroups = (t.seenByGroups | (1 << (mech.groupId & 0x1f))) & 0xffff;
          soundPlay(0xe7, 100, 0x40, 5, 0x50);
        }
        aiCycleTarget(mech, 1, 1);
      }
    }
  } else if (type === 0x200) {
    if (aiValidateTarget(mech.index, index, 0) > -1) drop = false;
  } else if (type === 0x400 && aiValidateGamething(mech.index, index, 0) > -1) drop = false;
  if (drop) {
    mech.targetHandle = (mech.targetHandle | 0x1000) | 0;
    return 0;
  }
  if (mechs.playerMechIndex !== mech.index) return 1;
  const inspect = mech.control!.inspect_target;
  const g = targeting;
  if (type < 0x200) {
    g.targetInspectResult = 0;
    return 1;
  }
  let identified = false;
  if (type === 0x200) {
    const t = mechs.mechTable[index]!;
    if ((t.flags & 0x20) !== 0) identified = true;
    else if (mech.targetDistance < ((t.loadout!.radius + 20000) | 0)) {
      if (inspect === 0) {
        g.targetInspectResult = 0;
        return 1;
      }
      t.flags = (t.flags | 0x20) & 0xffff;
      g.targetInspectResult = 1;
      t.seenByGroups = (t.seenByGroups | (1 << (mech.groupId & 0x1f))) & 0xffff;
      return 1;
    }
  } else {
    if (type !== 0x400) {
      g.targetInspectResult = 0;
      return 1;
    }
    const t = things.gameThings[index]!;
    if ((t.flags & 0x20) !== 0) identified = true;
    else if (mech.targetDistance < ((t.range + 20000) | 0)) {
      if (inspect === 0) {
        g.targetInspectResult = 0;
        return 1;
      }
      g.targetInspectResult = 1;
      t.flags = (t.flags | 0x20) & 0xffff;
      t.seenByGroups = (t.seenByGroups | (1 << (mech.groupId & 0x1f))) & 0xffff;
      return 1;
    }
  }
  if (identified) {
    g.targetInspectResult = inspect === 0 ? 0 : 3;
    return 1;
  }
  g.targetInspectResult = inspect === 0 ? 0 : 2;
  return 1;
}

/**
 * The scene node of the player's target: a mech's node, a gamething's world
 * object node; null for a tracked object or anything else.
 *
 * @mw2 player_target_node 0x0002a9d0
 * @fidelity exact
 */
export function playerTargetNode(): SceneNode | null {
  const h = mechs.mechTable[mechs.playerMechIndex]!.targetHandle;
  const type = h & 0xf00;
  const index = h & 0xff;
  if (type === 0x200) return mechs.mechTable[index]!.node;
  if (type === 0x400) return worldObjectNode(things.gameThings[index]!.geomIndex);
  return null;
}

/**
 * The target_reticle control: makes the object under the crosshair
 * (crosshairObject) the player's target when it validates as a mech (type
 * bit 0x100) or gamething (0x200), restoring the old target - and an engaged
 * autopilot - when ai_validate_current_target then refuses it. Sets
 * playerTargetFromReticle either way.
 *
 * @mw2 player_target_reticle 0x0002aa40
 * @fidelity exact
 */
export function playerTargetReticle(): void {
  const obj = aim.crosshairObject;
  const mech = mechs.mechTable[mechs.playerMechIndex]!;
  const old = mech.targetHandle;
  let handle = -1;
  const engaged = mech.loadout!.autopilotEngaged;
  if (!obj) {
    targeting.playerTargetFromReticle = 1;
    return;
  }
  if (((obj.type >> 8) & 1) === 0) {
    if (((obj.type >> 8) & 2) !== 0 && aiValidateGamething(mechs.playerMechIndex, obj.index & 0xffff, 0) >= 0) handle = (obj.index | 0x400) & 0xffff;
  } else if (aiValidateTarget(mechs.playerMechIndex, obj.index & 0xffff, 0) >= 0) handle = (obj.index | 0x200) & 0xffff;
  if (handle !== -1 && handle !== mech.targetHandle) {
    mech.targetHandle = handle;
    if (mech.loadout!.autopilotEngaged !== 0) mech.control!.autopilot = 1;
    if (aiValidateCurrentTarget(mech) === 0) {
      mech.targetHandle = old;
      if (engaged === 1) {
        mech.control!.autopilot = 0;
        mech.loadout!.autopilotEngaged = 1;
      }
    }
  }
  targeting.playerTargetFromReticle = 1;
}

/**
 * ai_cycle_target with mode 1 (tracked objects only), or 0x101 (the mech's
 * own temporary waypoints only) when ownWaypointsOnly is set.
 *
 * @mw2 ai_cycle_navpoint 0x0002ac10
 * @fidelity exact
 */
export function aiCycleNavpoint(mech: MechEntity, step: number, ownWaypointsOnly: number): void {
  aiCycleTarget(mech, step, ownWaypointsOnly !== 0 ? 0x101 : 1);
}

/**
 * @mw2 ai_cycle_gamething 0x0002ac30
 * @fidelity exact
 */
export function aiCycleGamething(step: number): void {
  aiCycleTarget(mechs.mechTable[mechs.playerMechIndex]!, step, 4);
}

/**
 * @mw2 ai_cycle_gamepiece 0x0002ac60
 * @fidelity exact
 */
export function aiCycleGamepiece(step: number): void {
  aiCycleTarget(mechs.mechTable[mechs.playerMechIndex]!, step, 2);
}

/**
 * @mw2 ai_cycle_friendly 0x0002ac90
 * @fidelity exact
 */
export function aiCycleFriendly(step: number): void {
  aiCycleTarget(mechs.mechTable[mechs.playerMechIndex]!, step, 0x20008);
}

/**
 * The nearest_enemy control: walks the whole ring with mode 0x40008 (enemy
 * mechs and gamethings), keeping the smallest targetSlantRange (the first on
 * a tie), and stops one cycle after landing on the best again or on NONE.
 * Nothing found, or the best beyond 1750 m, or refused by
 * ai_validate_current_target: the old target is put back and an engaged
 * autopilot's toggle request withdrawn.
 *
 * @mw2 ai_target_nearest_enemy 0x0002acf0
 * @fidelity exact
 */
export function aiTargetNearestEnemy(): void {
  const mech = mechs.mechTable[mechs.playerMechIndex]!;
  let best = -1;
  const old = mech.targetHandle;
  let prev = 0;
  const engaged = mech.loadout!.autopilotEngaged;
  let nearest = 0x7fffffff;
  let step = 0;
  for (;;) {
    aiCycleTarget(mechs.mechTable[mechs.playerMechIndex]!, step, 0x40008);
    if (best === prev) break;
    prev = mech.targetHandle;
    if ((prev & 0x1000) !== 0) break;
    if (mech.targetSlantRange < nearest) {
      best = prev;
      nearest = mech.targetSlantRange;
      prev = 0;
    }
    step = 1;
  }
  if (best === -1 || PLAYER_TARGET_RANGE < nearest) mech.targetHandle = old;
  else {
    mech.targetHandle = best;
    if (aiValidateCurrentTarget(mech) !== 0) return;
    mech.targetHandle = old;
  }
  if (engaged === 1) mech.control!.autopilot = 0;
}
