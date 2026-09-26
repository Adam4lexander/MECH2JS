/**
 * The weapons' aim (weapons.c): the fire ray from a mech's aim node along
 * its weapons' direction, and the convergence distance (aimRange) that the
 * fire ray is measured against.
 */
import { cameraGlobals } from '../camera/viewer.ts';
import { Ray } from '../../generated/classes.gen.ts';
import type { MechEntity, WorldObject } from '../../generated/classes.gen.ts';
import { rampStep } from '../../core/ramp.ts';
import { matrixFromEulerOrder0, matrixRotateVector, newTransform } from '../../core/math/matrix.ts';
import { clock } from '../../engine/clock.ts';
import { registerGlobals } from '../../engine/globals.ts';
import { sceneNodeGetWorldEuler, sceneNodeGetWorldPos } from '../../engine/scene/sceneGraph.ts';
import { rayLength, raySetFromDirection } from '../../engine/collision/ray.ts';
import { mechs } from '../mech/mechGlobals.ts';
import { worldRaycast } from '../world/collision.ts';

export const aim = registerGlobals(
  'aim',
  {
    /** 0x159440: the mech or gamething the player's fire ray last hit (mech_update_aim_range) */
    crosshairObject: null as WorldObject | null,
  },
  () => {
    aim.crosshairObject = null;
  },
);

/**
 * The unit vector the weapons point along: aimNode's world orientation with
 * its pitch replaced by the torso tilt ramp (loadout ramps[1].current),
 * applied to (0, 0, 0x10000).
 *
 * @mw2 weapon_get_aim_direction 0x00053330
 * @fidelity exact
 */
export function weaponGetAimDirection(mech: MechEntity): [number, number, number] {
  const v = [0, 0, 0x10000];
  const e = sceneNodeGetWorldEuler(mech.aimNode!);
  const m = newTransform();
  matrixFromEulerOrder0(m, mech.loadout!.ramps[1]!.current, e.yaw, e.roll, 0, 0, 0);
  matrixRotateVector(m, v);
  return [v[0]!, v[1]!, v[2]!];
}

/**
 * The fire ray: from aimNode's world position (plus the player's eye
 * offset, when set - even for an AI mech), 150000 along the aim direction.
 *
 * @mw2 weapon_build_fire_ray 0x000532c0
 * @fidelity exact
 */
export function weaponBuildFireRay(mech: MechEntity, ray: Ray): void {
  const [dx, dy, dz] = weaponGetAimDirection(mech);
  const [x, y0, z] = sceneNodeGetWorldPos(mech.aimNode!);
  let y = y0;
  // playerEyeOffsetY (0x96f04, set by hud_widgets_install): the PLAYER's eye offset whoever fires
  const eye = cameraGlobals.playerEyeOffsetY;
  if (eye) y = (y + eye.eyeOffsetY) | 0;
  raySetFromDirection(ray, x, y, z, dx, dy, dz, 150000);
}

/**
 * Steps the convergence distance: the fire ray is cast (ignoring the mech
 * itself) and a hit on a mech (type 0x100) or gamething (0x200) snaps
 * aimRangeSeek to the hit distance, at least 2000; aimRange then ramps
 * toward aimRangeSeek. Returns the object hit, or null.
 *
 * @mw2 mech_update_aim_range 0x00053190
 * @fidelity exact
 */
export function mechUpdateAimRange(mech: MechEntity): WorldObject | null {
  const hit = { v: null as WorldObject | null };
  rampStep(mech.aimRangeSeek, clock.simTick);
  const ray = new Ray();
  weaponBuildFireRay(mech, ray);
  if (worldRaycast(ray, hit, mech.index) !== 0 && hit.v && (((hit.v.type >> 8) & 1) !== 0 || ((hit.v.type >> 8) & 2) !== 0)) {
    let d = rayLength(ray);
    if (d < 0x7d1) d = 2000;
    mech.aimRangeSeek.current = d;
    if (mechs.playerMechIndex === mech.index) aim.crosshairObject = hit.v;
  }
  mech.aimRange.target = mech.aimRangeSeek.current;
  rampStep(mech.aimRange, clock.simTick);
  return hit.v;
}

/**
 * @mw2 mech_aim_range 0x00053240
 * @fidelity exact
 */
export function mechAimRange(mech: MechEntity): number {
  return mech.aimRange.current;
}
