/**
 * Projectiles in flight: the per-frame sweep of the 175-slot pool, the
 * integration step, hit resolution, homing and a round's end. The pool itself
 * and its reset live in effects/simTables.ts; mech_weapon_fire (weapons.ts)
 * stocks a slot and projectile_place_on_fire puts its node at the muzzle.
 *
 * Units: positions in world units (cm), velocities 16.16 world units per
 * tick, accelerations 16.16 per tick per tick; dt is tickDelta (182 Hz).
 */
import { fixedAsin, fixedAtan2 } from '../../core/angle/trig.ts';
import { mulr16 } from '../../core/int/fx16.ts';
import { mulShr, sdivShl } from '../../core/int/i64.ts';
import { divergence } from '../../core/provenance.ts';
import { Ray } from '../../generated/classes.gen.ts';
import type { Projectile, WorldObject } from '../../generated/classes.gen.ts';
import { clock } from '../../engine/clock.ts';
import { octLength, rayNormalise, rayNormaliseExact, raySetEndAtHeight, raySetPoints, vec3Normalise } from '../../engine/collision/ray.ts';
import {
  sceneNodeGetUserdata,
  sceneNodeGetWorldPos,
  sceneNodeRemoveSubtreeFromWorld,
  sceneNodeSetEuler,
  sceneNodeSetOrigin,
  sceneNodeWalk,
  sceneSubtreeMoveToAltList,
} from '../../engine/scene/sceneGraph.ts';
import { viewShakeImpulse } from '../camera/cameraUpdate.ts';
import { effectSpawn } from '../effects/effects.ts';
import { PROJECTILE_COUNT, projectileClear, simTables } from '../effects/simTables.ts';
import { mechApplyDamage } from '../mech/damage.ts';
import { mechs } from '../mech/mechGlobals.ts';
import { aiLogAttack } from '../mech/mechTickAi.ts';
import { net } from '../net/netplay.ts';
import { destructibleApplyDamage } from '../things/destructibles.ts';
import { gamethingApplyDamage } from '../things/gameThingDamage.ts';
import { things } from '../things/gameThings.ts';
import { worldGroundHeightNear, worldRaycast } from '../world/collision.ts';
import { worldObjectGetPos, worldRecordObject } from '../world/worldRecords.ts';

/**
 * Once a frame from main: every active projectile with a node loses
 * tickDelta of timeLeft and gains it in age, then - unless motionHeld is set -
 * takes its step.
 *
 * @mw2 projectiles_update_all 0x000506f0
 * @fidelity exact
 */
export function projectilesUpdateAll(): void {
  const t = simTables;
  for (let slot = 0; slot < PROJECTILE_COUNT; slot++) {
    const p = t.projectiles[slot]!;
    if (p.active !== 0 && p.node !== null) {
      const left = (p.timeLeft - clock.tickDelta) | 0;
      p.age = (p.age + clock.tickDelta) | 0;
      p.timeLeft = left;
      if (p.motionHeld === 0) projectileUpdate(slot);
    }
  }
}

/** pos + ((vel + (accel * dt >> 1)) * dt >> 16), the 64-bit product's bits 16..47 */
function stepAxis(old: number, vel: number, accelDt: number, dt: number): number {
  return (old + mulShr(((accelDt >> 1) + vel) | 0, dt, 16)) | 0;
}

/**
 * One projectile's step: constant-acceleration integration over tickDelta,
 * then what the segment from the old position to the new one strikes.
 *
 * Hits: a mech takes damage << 16 at the struck part's hitLocation, with
 * 0x8000 (rear armour) when the round travels within 90 degrees of the way
 * the mech's LEGS face; a gamething takes damage unshifted; a destructible
 * (family 0x50) damage << 16. Below y = 0 the heightfield stops a round the
 * raycast missed. A round armed by projectile_home's proximity test (active
 * bit 0x8000) skips the raycast and strikes its target at the old position.
 * An expired round vanishes with no effect; a hit spawns the round's effect
 * at the impact point with the blast point 1 m back along the ray.
 *
 * @mw2 projectile_update 0x00050750
 * @fidelity exact
 */
export function projectileUpdate(slot: number): void {
  const t = simTables;
  let rearArmorBit = 0;
  const dt = clock.tickDelta;
  const proj = t.projectiles[slot]!;
  const [oldX, oldY, oldZ] = sceneNodeGetWorldPos(proj.node!);
  let a = Math.imul(proj.accelX, dt);
  const newVelX = (proj.velX + a) | 0;
  const newX = stepAxis(oldX, proj.velX, a, dt);
  a = Math.imul(proj.accelY, dt);
  const newVelY = (proj.velY + a) | 0;
  const newY = stepAxis(oldY, proj.velY, a, dt);
  a = Math.imul(proj.accelZ, dt);
  const newVelZ = (proj.velZ + a) | 0;
  const newZ = stepAxis(oldZ, proj.velZ, a, dt);

  const ray = new Ray();
  raySetPoints(ray, oldX, oldY, oldZ, newX, newY, newZ);
  // the cheap normalise below 30 m a step, the exact one from there (precision only)
  if (octLength((newX - oldX) | 0, (newY - oldY) | 0, (newZ - oldZ) | 0) < 0xbb9) rayNormalise(ray);
  else rayNormaliseExact(ray);

  let hitObject: WorldObject | null = null;
  let hit: number;
  let impactX = 0;
  let impactY = 0;
  let impactZ = 0;
  let blastX = 0;
  let blastY = 0;
  let blastZ = 0;
  if ((proj.active & 0x8000) === 0) {
    const out = { v: null as WorldObject | null };
    hit = worldRaycast(ray, out, proj.attackerMechIndex);
    hitObject = out.v;
    if (hit !== 0) {
      impactX = ray.endX;
      impactY = ray.endY;
      impactZ = ray.endZ;
      blastX = (ray.endX - mulr16(ray.unitX, 100)) | 0;
      blastY = (ray.endY - mulr16(ray.unitY, 100)) | 0;
      blastZ = (ray.endZ - mulr16(ray.unitZ, 100)) | 0;
    }
  } else {
    hit = 1;
    if (proj.targetType === 0x200) {
      const node = mechs.mechTable[proj.targetIndex]?.node ?? null;
      hitObject = node ? sceneNodeGetUserdata(node) : null;
    } else if (proj.targetType === 0x400) {
      hitObject = worldRecordObject(things.gameThings[proj.targetIndex]!.geomIndex);
    }
    blastX = impactX = oldX;
    blastY = impactY = oldY;
    blastZ = impactZ = oldZ;
  }

  if (hit === 0 || hitObject === null) {
    if (newY < 0) {
      const ground = worldGroundHeightNear(newX, newY, newZ);
      if (newY < ground) {
        proj.impactFlags = (proj.impactFlags | 4) & 0xff;
        raySetEndAtHeight(ray, ground);
        blastX = impactX = ray.endX;
        blastY = impactY = ray.endY;
        hit = 1;
        blastZ = impactZ = ray.endZ;
      }
    }
  } else {
    t.killCreditMech = proj.attackerMechIndex;
    const type = hitObject.type;
    if ((type & 0x100) === 0) {
      if ((type & 0x200) === 0) {
        if ((type & 0xf0) === 0x50) destructibleApplyDamage(hitObject.index & 0xffff, proj.damage << 16);
        else if ((type & 0x400) === 0) proj.impactFlags = (proj.impactFlags | 4) & 0xff;
        else proj.impactFlags = (proj.impactFlags | 2) & 0xff;
      } else {
        proj.impactFlags = (proj.impactFlags | 2) & 0xff;
        gamethingApplyDamage(hitObject, proj.damage, impactX, impactY, impactZ);
      }
    } else {
      const idx = hitObject.index & 0xffff;
      proj.impactFlags = (proj.impactFlags | 1) & 0xff;
      if (proj.id === 7) proj.impactFlags = (proj.impactFlags | 0x10) & 0xff;
      const m = mechs.mechTable[idx]!;
      // the struck mech's LEG heading against the round's direction of travel, wrapped to +/-180 degrees
      let rel = ((m.heading - fixedAtan2(proj.velX, proj.velZ)) | 0) % 0x1680000;
      if (rel < 0xb40001) {
        if (rel < -0xb40000) rel = (rel + 0x1680000) | 0;
      } else {
        rel = (rel - 0x1680000) | 0;
      }
      if (rel < 0x5a0000 && -0x5a0000 < rel) rearArmorBit |= 0x8000;
      if (net.netRole === 0 || idx === mechs.playerMechIndex) {
        const l = m.loadout!;
        l.heatThisTick = (l.heatThisTick + proj.heatOnHit) | 0;
        mechApplyDamage(l, proj.damage << 16, hitObject.hitLocation | rearArmorBit);
      }
      if (idx === mechs.playerMechIndex) {
        proj.impactFlags = (proj.impactFlags | 0x40) & 0xff;
        const loc = hitObject.hitLocation;
        if (loc === 1 || loc === 3 || loc === 2 || loc === 4) proj.impactFlags = (proj.impactFlags | 0x20) & 0xff;
        viewShakeImpulse(newVelX, newVelY, newVelZ);
      }
      aiLogAttack(proj.attackerMechIndex, idx);
    }
  }

  if (hit === 0) {
    if (proj.timeLeft < 1) {
      projectileDestroy(slot, 0, newX, newY, newZ, newX, newY, newZ);
      return;
    }
    if (proj.targetType !== 0 && 0 < proj.age) projectileHome(proj, newX, newY, newZ);
    sceneNodeSetOrigin(proj.node!, newX, newY, newZ);
    sceneNodeWalk(proj.node!);
    proj.velX = newVelX;
    proj.velY = newVelY;
    proj.velZ = newVelZ;
    if (proj.missileCam !== 0) {
      t.missileCamProjectile = slot;
      const pose = t.missileCamPose;
      pose[0] = newX;
      pose[1] = newY;
      pose[2] = newZ;
      pose[3] = fixedAtan2(newVelX, newVelZ);
      pose[4] = 0;
      pose[5] = 0;
      pose[6] = 1;
    }
  } else {
    projectileDestroy(slot, 1, impactX, impactY, impactZ, blastX, blastY, blastZ);
  }
}

/**
 * The homing step for a round with a target: acceleration becomes
 * unit(target - pos) - unit(vel), which replaces the gravity term, so the
 * correction bends the path from the next tick. A destroyed or gone target
 * drops the lock (acceleration and targetType zeroed). Within 101 world units
 * of the target it sets active bit 0x8000, a hit that cannot miss on the
 * next step. Last it turns the node along the velocity it had BEFORE this
 * step.
 *
 * @mw2 projectile_home 0x00050d50
 * @fidelity exact
 * @divergence the original faults (idiv by zero) when the round is exactly on the target's origin; the port stops after the proximity bit instead
 */
export function projectileHome(proj: Projectile, x: number, y: number, z: number): void {
  if (proj.targetIndex < 0) return;
  const type = proj.targetType >>> 0;
  if (type <= 0x1ff) return;
  let tx: number;
  let ty: number;
  let tz: number;
  if (type < 0x201) {
    const m = mechs.mechTable[proj.targetIndex]!;
    if ((m.flags & 2) !== 0 || (m.flags & 4) !== 0) {
      proj.accelZ = 0;
      proj.targetType = 0;
      proj.accelY = proj.accelZ;
      proj.accelX = proj.accelZ;
      return;
    }
    tx = m.posX;
    ty = m.posY;
    tz = m.posZ;
  } else {
    if (type !== 0x400) return;
    const g = things.gameThings[proj.targetIndex]!;
    if ((g.flags & 4) !== 0) {
      proj.accelZ = 0;
      proj.targetType = 0;
      proj.accelY = proj.accelZ;
      proj.accelX = proj.accelZ;
      return;
    }
    [tx, ty, tz] = worldObjectGetPos(g.geomIndex);
  }
  const dx = (tx - x) | 0;
  const dy = (ty - y) | 0;
  const dz = (tz - z) | 0;
  const d = octLength(dx, dy, dz);
  if (d < 0x65) proj.active |= 0x8000;
  if (d === 0) {
    divergence('projectile_home: the round is on its target; the original divides by zero here and faults', 'projectile_home');
    return;
  }
  const wantX = sdivShl(dx, 16, d);
  const v = [proj.velX, proj.velY, proj.velZ];
  vec3Normalise(v);
  proj.accelX = (wantX - v[0]!) | 0;
  proj.accelY = (sdivShl(dy, 16, d) - v[1]!) | 0;
  proj.accelZ = (sdivShl(dz, 16, d) - v[2]!) | 0;
  const yaw = fixedAtan2(v[0]!, v[2]!);
  const pitch = -fixedAsin(v[1]! << 13) | 0;
  sceneNodeSetEuler(proj.node!, pitch, yaw, 0, 0);
}

/**
 * Ends a round: its node leaves the world list and chain, the slot is
 * cleared, and when `spawn` is set the round's effect code - the dword at
 * +4, effectIndex | impactFlags << 8 | effectHigh << 16, read before the
 * clear - is spawned at (x, y, z) with (lx, ly, lz) as its light point.
 *
 * @mw2 projectile_destroy 0x00050f20
 * @fidelity exact
 */
export function projectileDestroy(slot: number, spawn: number, x: number, y: number, z: number, lx: number, ly: number, lz: number): void {
  const p = simTables.projectiles[slot]!;
  if (p.missileCam !== 0) simTables.missileCamProjectile = -1;
  if (p.node) {
    sceneSubtreeMoveToAltList(p.node);
    sceneNodeRemoveSubtreeFromWorld(p.node);
  }
  const code = (p.effectIndex & 0xff) | ((p.impactFlags & 0xff) << 8) | ((p.effectHigh & 0xffff) << 16);
  projectileClear(slot);
  if (spawn !== 0) effectSpawn(code, x, y, z, lx, ly, lz, 0, 0, 0);
}

/**
 * The missile camera's pose while the followed missile lives: null (and the
 * follow dropped) once missileCamProjectile is -1 or that projectile's
 * missileCam flag is gone. The pose is seven dwords {x, y, z, yaw, pitch,
 * roll, valid} that projectile_update writes.
 *
 * @mw2 missile_cam_pose 0x00051a00
 * @fidelity exact
 */
export function missileCamPose(): Int32Array | null {
  const t = simTables;
  if (t.missileCamProjectile === -1 || t.projectiles[t.missileCamProjectile]!.missileCam === 0) {
    t.missileCamProjectile = -1;
    return null;
  }
  return t.missileCamPose;
}

/**
 * Starts the missile camera on the player's last missile (playerLastMissile,
 * which mech_weapon_fire records for kinds 3 and 4) if it is still in flight
 * and the player's; returns 1 if it did. The test is < 1, so slot 0 is never
 * followed.
 *
 * @mw2 missile_cam_follow_last 0x00051a40
 * @fidelity exact
 */
export function missileCamFollowLast(): number {
  const t = simTables;
  const slot = t.playerLastMissile;
  if (slot < 1 || t.projectiles[slot]!.active === 0 || mechs.playerMechIndex !== t.projectiles[slot]!.attackerMechIndex) {
    t.missileCamProjectile = -1;
    return 0;
  }
  t.projectiles[slot]!.missileCam = 1;
  t.missileCamProjectile = slot;
  return 1;
}
