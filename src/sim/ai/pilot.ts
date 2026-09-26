/**
 * How an AI mech drives and shoots from moment to moment: steering round
 * obstacles, cushioning falls and hopping on its jets, choosing to fire
 * and checking the line of fire, and where to stand behind a target.
 * The states and behaviours call these every think.
 */
import { Ray, type MechEntity, type MechLoadout, type WorldObject } from '../../generated/classes.gen.ts';
import { cmod, iabs, i16 } from '../../core/int/cint.ts';
import { mulr16 } from '../../core/int/fx16.ts';
import { sdivShl } from '../../core/int/i64.ts';
import { x87MulTrunc } from '../../core/int/x87.ts';
import { quirk, unestablished } from '../../core/provenance.ts';
import { vecToRangeBearing } from '../../core/math/vec.ts';
import { randomRange } from '../../core/random.ts';
import { clock } from '../../engine/clock.ts';
import { rayNormalise, raySetPoints } from '../../engine/collision/ray.ts';
import { imageF64 } from '../../engine/image.ts';
import { logWrite } from '../../engine/logWrite.ts';
import { weaponTypes } from '../mech/config.ts';
import { loadoutWeapons } from '../mech/loadout.ts';
import { mechs } from '../mech/mechGlobals.ts';
import { soundPlay } from '../sound/sound.ts';
import { selectedWeaponReady, weaponSelectNextInGroup } from '../weapons/weapons.ts';
import { collision } from '../world/collisionGlobals.ts';
import { objectIsGround, worldRaycast } from '../world/collision.ts';
import { aiBearingToTarget, mechHeadingError, mechProbeRay } from './aiGeometry.ts';
import { aiStepTorsoPan, aiStepTorsoTilt } from './states.ts';

// --- falls and jets ------------------------------------------------------------

/**
 * Below 20000 cm the jets cushion a fall: on when velocityY is under
 * -899859.3 (16.16 cm/tick, -13.7), off above -0xc1d89 (-12.1), as they were
 * between. A fall past -0x102762 is logged. Only with jump fuel (>= 0) and
 * working jets. Returns onGround.
 *
 * @mw2 ai_jets_cushion_fall 0x0002dac0
 * @fidelity exact
 */
export function aiJetsCushionFall(mech: MechEntity): number {
  const l = mech.loadout!;
  if (-1 < l.jumpFuel && l.jetDeltaY !== 0) {
    let on = mech.control!.jumpjet_enabled;
    if (mech.posY < 20000) {
      if (l.velocityY < imageF64(0x90aec, -899859.3)) on = 1;
      else if (-0xc1d89 < l.velocityY) on = 0;
    }
    mech.control!.jumpjet_enabled = on;
    if (l.velocityY < -0x102762) {
      logWrite(`${String(clock.simTick).padStart(6)} : ${String(mech.groupId).padStart(2)} Mech ${String(mech.index).padStart(2)} has exceded fall damage speed.\n`);
    }
  }
  return mech.onGround;
}

/**
 * The AI's jet hop (aiCapabilities bit 0, not avoiding, not behaviour 10):
 * with targetPrimary inside the torso arc the jets go off (unless the
 * behaviour is committed, they are off already or the mech is airborne);
 * outside it they go on when it can jump with heat under 20%, is on the
 * ground and they are off.
 *
 * @mw2 ai_update_jumpjets 0x0002e300
 * @fidelity exact
 */
export function aiUpdateJumpjets(mech: MechEntity): void {
  if ((mech.aiCapabilities & 1) === 0 || mech.avoidTurnSign !== 0 || mech.aiBehaviour === 10) return;
  aiBearingToTarget(mech, mech.targetPrimary);
  const e = iabs(mechHeadingError(mech));
  const lim = mech.loadout!.torsoPanLimit;
  const pc = mech.control!;
  if (e < lim && (e > (-lim | 0) || pc.throttle === 0)) {
    if (mech.behaviourCommitted !== 0 || pc.jumpjet_enabled === 0 || mech.onGround === 0) return;
    pc.jumpjet_enabled = 0;
  } else {
    const l = mech.loadout!;
    if (l.jumpFuel < 6 || l.jetDeltaY === 0 || 0x13 < l.heatLevel >> 16) return;
    if (mech.onGround === 0 || pc.jumpjet_enabled !== 0) return;
    pc.jumpjet_enabled = 1;
  }
}

// --- obstacles -------------------------------------------------------------------

/**
 * +1 or -1: which way the mech turns to face `other` from (x, y, z) - 1 when
 * the bearing to it, less the heading and folded into +/-180, is negative.
 *
 * @mw2 turn_sign_toward 0x0002e060
 * @fidelity exact
 */
export function turnSignToward(mech: MechEntity, other: WorldObject, x: number, y: number, z: number): number {
  const b = vecToRangeBearing((other.posX - x) | 0, (other.posY - y) | 0, (other.posZ - z) | 0).azimuth;
  let e = (b - mech.heading) | 0;
  if (0xb40000 < e) e = (e - 0x1680000) | 0;
  else if (e < -0xb40000) e = (e + 0x1680000) | 0;
  return e < 0 ? 1 : -1;
}

/** Ground no steeper than 40 degrees (normal y >= cos 40 = 0xc41b), or a destructible, is no obstacle. @portOnly the test ai_handle_blocked makes twice */
function passable(hit: WorldObject): boolean {
  if (objectIsGround(hit) !== 0 && 0xc41b <= collision.rayHitNormalY) return true;
  return (hit.type & 0xf0) === 0x50;
}

/**
 * Obstacle avoidance, while the mech can move, is not reversing and is
 * asking for throttle or already avoiding. Until avoidNextCheck it answers
 * whether it is avoiding. Otherwise it probes ahead: the probe length is
 * 5000 * avoidProbeScale >> 16, the scale set from the ground speed when not
 * already avoiding (a vehicle's halved, at least 0x4ccc). Up to four rays,
 * directions 0..3 turned by avoidTurnSign: a hit that is not walkable ground
 * or a destructible latches the obstacle and a turn sign (turn_sign_toward)
 * and adds a quarter of 0x3333333.33 per ray to the turn; a clear first ray
 * ends the avoidance once the heading is within a degree and, still
 * avoiding, looks back the other way from the flank for a half turn. A turn
 * is clamped to +/-0x3333333 into legsPan with throttle 0x400 (0x100 after a
 * clear-then-blocked probe; the player's saved throttle, aiDirection);
 * gamepieceClass 6 stops instead. Rechecks in 10 ticks (the player), 0x5b
 * (avoiding) or 0xb6. Returns 1 when steering round something.
 *
 * @mw2 ai_handle_blocked 0x0002db80
 * @fidelity exact
 */
export function aiHandleBlocked(mech: MechEntity): number {
  const l = mech.loadout!;
  const pc = mech.control!;
  if (l.speed === 0 || (mech.avoidTurnSign === 0 && pc.throttle === 0) || pc.reverseDirection !== 0) return 0;
  if (clock.simTick < mech.avoidNextCheck) return mech.avoidObstacle !== null ? 1 : 0;
  let turn = 0;
  if (mech.avoidTurnSign === 0) {
    // ground speed: the (4 * max + mid + min) / 4 estimate over |velocityX|, 0 and |velocityZ| (0x2dbea..0x2dc23)
    let a = iabs(l.velocityX);
    let d = 0;
    let c = iabs(l.velocityZ);
    if (a < d) [a, d] = [d, a];
    if (a < c) [a, c] = [c, a];
    const v = (Math.imul(a, 4) + d + c) >> 2;
    mech.avoidProbeScale = sdivShl(v, 16, 500000);
    if (mech.gamepieceClass !== 1) mech.avoidProbeScale >>= 1;
    if (mech.avoidProbeScale < imageF64(0x90af4, 19660.8)) mech.avoidProbeScale = 0x4ccc;
  }
  const length = mulr16(mech.avoidProbeScale, 0x13880000) >> 16;
  const ray = new Ray();
  const hit = { v: null as WorldObject | null };
  let k = 0;
  for (; k < 4; k++) {
    mechProbeRay(mech, ray, mech.avoidTurnSign, k, length, 0);
    if (worldRaycast(ray, hit, mech.index) === 0) {
      if (k === 0 && iabs(mechHeadingError(mech)) <= 0x10000) {
        mech.avoidObstacle = null;
        mech.avoidTurnSign = 0;
      }
      if (k === 0 && mech.avoidTurnSign !== 0) {
        mechProbeRay(mech, ray, -mech.avoidTurnSign, 1, length, 1);
        if (worldRaycast(ray, hit, mech.index) !== 0 && !passable(hit.v!)) {
          turn = x87AddTrunc(mech.avoidTurnSign, imageF64(0x90b0c, 26843545.6), 1, turn);
        }
      }
      break;
    }
    if (passable(hit.v!)) break;
    if (mech.avoidTurnSign === 0) {
      mech.avoidTurnSign = turnSignToward(mech, hit.v!, mech.posX, mech.posY, mech.posZ);
      mech.avoidObstacle = hit.v;
    }
    turn = x87AddTrunc(mech.avoidTurnSign, imageF64(0x90afc, 53687091.2), imageF64(0x90b04, 0.25), turn);
  }
  if (turn !== 0) {
    if (0x3333333 < turn) turn = 0x3333333;
    else if (turn < -0x3333333) turn = -0x3333333;
    pc.legsPan = turn;
    let throttle = mechs.playerMechIndex === mech.index ? mech.aiDirection : 0x400;
    if (k !== 0) throttle = 0x100;
    pc.throttle = throttle;
    if (mech.gamepieceClass === 6) {
      pc.throttle = 0;
      pc.legsPan = 0;
    }
  }
  const now = clock.simTick;
  if (mechs.playerMechIndex === mech.index) mech.avoidNextCheck = (now + 10) | 0;
  else mech.avoidNextCheck = (now + (mech.avoidObstacle === null ? 0xb6 : 0x5b)) | 0;
  return turn !== 0 ? 1 : 0;
}

/**
 * `fild word sign; fmul qword a; fmul qword b; fild dword acc; faddp; trunc;
 * fistp` - acc + sign * a * b. With sign +/-1 and these constants every
 * product and sum is far from an integer, so double arithmetic gives the
 * x87's answer; the truncation is x87MulTrunc's.
 *
 * @portOnly the x87 sequence at 0x2dd19 and 0x2de29
 */
function x87AddTrunc(sign: number, a: number, b: number, acc: number): number {
  return x87MulTrunc(1, i16(sign) * a * b + acc);
}

/**
 * The blocked-mech test: blockedSteps set, not deliberately reversing, no
 * committed behaviour and not already avoiding (behaviour 10).
 *
 * @mw2 ai_blocked_ends_behaviour 0x0002e820
 * @fidelity exact
 */
export function aiBlockedEndsBehaviour(l: MechLoadout): number {
  const e = l.entity!;
  return l.blockedSteps !== 0 && e.control!.reverseDirection !== 1 && e.behaviourCommitted === 0 && e.aiBehaviour !== 10 ? 1 : 0;
}

// --- line of fire -------------------------------------------------------------

/** The shared tail of both line-of-fire tests: nothing hit, or the hit IS the target. @portOnly */
function hitIsTarget(mech: MechEntity, ray: Ray): boolean {
  rayNormalise(ray);
  const hit = { v: null as WorldObject | null };
  if (worldRaycast(ray, hit, mech.index) === 0 || hit.v === null) return true;
  const th = mech.targetHandle;
  const cls = (hit.v.type >> 8) & 0xff;
  if ((cls & 1) !== 0 && (th & 0x200) !== 0) return hit.v.index === (th & 0xff);
  if ((cls & 2) !== 0 && (th & 0x400) !== 0) return hit.v.index === (th & 0xff);
  return false;
}

/**
 * The shot check: with checkArc, the torso must face within 90 degrees of
 * the bearing to the target; then a ray from the mech's position to the
 * target must hit nothing, or the target itself.
 *
 * @mw2 ai_has_line_of_fire 0x0002bf20
 * @fidelity exact
 */
export function aiHasLineOfFire(mech: MechEntity, checkArc: number): boolean {
  const a = cmod((((mech.heading + mech.aimAngle) | 0) - mech.desiredHeading + 0x1680000) | 0, 0x1680000);
  if (checkArc !== 0 && !(0x10dffff < a || a < 0x5a0001)) return false;
  const ray = new Ray();
  raySetPoints(ray, mech.posX, mech.posY, mech.posZ, mech.targetX, mech.targetY, mech.targetZ);
  return hitIsTarget(mech, ray);
}

/**
 * The sight check from the mech's x, z at height fromY to the target: nothing
 * in the way, or the target itself.
 *
 * @mw2 mech_has_line_of_fire 0x0002e150
 * @fidelity exact
 */
export function mechHasLineOfFire(mech: MechEntity, fromY: number): boolean {
  const ray = new Ray();
  raySetPoints(ray, mech.posX, fromY, mech.posZ, mech.targetX, mech.targetY, mech.targetZ);
  return hitIsTarget(mech, ray);
}

/**
 * The target is a mech above this one and out of sight from its own height:
 * more than 800 higher, and the mech has jump fuel (>= 0).
 *
 * @mw2 ai_target_hidden_above 0x0002da50
 * @fidelity exact
 */
export function aiTargetHiddenAbove(mech: MechEntity): number {
  if ((mech.targetHandle & 0xf00) !== 0x200) return 0;
  if (mechHasLineOfFire(mech, mech.posY)) return 0;
  return mech.posY < ((mech.targetY - 800) | 0) && -1 < mech.loadout!.jumpFuel ? 1 : 0;
}

// --- firing ---------------------------------------------------------------------

/**
 * 1 when the mech has weapons and none can fire (fireState -1 or no ammo);
 * 0 for an unarmed mech.
 *
 * @mw2 mech_has_no_usable_weapon 0x0002e240
 * @fidelity exact
 */
export function mechHasNoUsableWeapon(l: MechLoadout): number {
  const w = loadoutWeapons(l);
  for (let i = 0; i < l.numWeapons; i++) if (w[i]!.fireState !== -1 && w[i]!.ammo !== 0) return 0;
  return l.numWeapons === 0 ? 0 : 1;
}

/**
 * Where targetDistance falls against a weapon type's ranges: 3 under
 * minRange, 2 under maxRange, 1 at it, 0 beyond.
 *
 * @mw2 weapon_range_band 0x0002c190
 * @fidelity exact
 */
export function weaponRangeBand(mech: MechEntity, type: number): number {
  const wt = weaponTypes()[type]!;
  const d = mech.targetDistance;
  if (d < wt.minRange) return 3;
  if (d < wt.maxRange) return 2;
  return wt.maxRange < d ? 0 : 1;
}

/**
 * The fire decision: from the selected weapon, at most numWeapons steps
 * through the group, the first weapon in range (band 1 or 2), keeping heat
 * under 65%, ready, with ammo, and passing a 1-in-(reload / 0x5b + 1) roll;
 * the others are stepped past. A guided weapon may lock at once (thinkDelay
 * under 5, 1 in thinkDelay + 1) and warns the player it is targeting (sound
 * 0x6f). Returns 1 to fire. The torso-tilt nudge for LRM20 and SRM6 is
 * overwritten by the caller.
 *
 * @mw2 ai_decide_fire 0x0002e980
 * @fidelity exact
 */
export function aiDecideFire(mech: MechEntity): number {
  const l = mech.loadout!;
  const w = loadoutWeapons(l);
  const types = weaponTypes();
  let fire = 0;
  let type = -1;
  for (let k = 0; k < l.numWeapons && fire === 0; k++) {
    const i = l.selectedWeapon;
    if (i < 0) {
      unestablished('ai_decide_fire: selectedWeapon is -1, and the C reads weapons[-1]', 'ai_decide_fire');
      return 0;
    }
    const wp = w[i]!;
    type = wp.type;
    const band = weaponRangeBand(mech, type);
    fire = band === 0 || 2 < band ? 0 : 1;
    if (fire !== 0) {
      fire = 0;
      const wt = types[type]!;
      if (((l.heatLevel + wt.heat) | 0) >> 16 < 0x41 && selectedWeaponReady(l) === 1 && wp.ammo !== 0 && randomRange(((wt.reload / 0x5b) | 0) + 1) === 0) fire = 1;
    }
    if (fire === 0) weaponSelectNextInGroup(l, 1);
  }
  if (fire !== 0) {
    const pc = mech.control!;
    if (type === 0) pc.torso_tilt = (pc.torso_tilt + 0x1e000) | 0;
    else if (type === 4) pc.torso_tilt = (pc.torso_tilt + 0x3c000) | 0;
    if (types[type]!.guided !== 0) {
      if (mech.thinkDelay < 5 && randomRange(mech.thinkDelay + 1) === 0) l.flags = (l.flags | 0x80) & 0xffff;
      if (mech.targetSecondary === ((mechs.playerMechIndex | 0x200) & 0xffff)) soundPlay(0x6f, 100, 0x40, 5, 0x32);
    }
  }
  return fire;
}

/**
 * Aim and fire, with `bearing` the heading error the caller steers by. On
 * each think (every r * 0x16 ticks, r below thinkDelay): within 10 degrees
 * of the torso's aim - and at the player always, anyone else 1 in 3 - it
 * re-aims at targetSecondary and, when r is 0, asks ai_decide_fire; with
 * aiCapabilities 0x10 it also needs a line of fire. Firing sets weapon_fire
 * and returns 1. Every call steps the torso pan toward the bearing and the
 * tilt toward torsoTilt, with no lead (r is 0 whenever it counts).
 *
 * @mw2 ai_pilot_update 0x0002e860
 * @fidelity exact
 */
export function aiPilotUpdate(mech: MechEntity, bearing: number): number {
  let fired = 0;
  let r = 0;
  if (mech.nextThinkTick <= clock.simTick) {
    r = randomRange(mech.thinkDelay);
    mech.nextThinkTick = (clock.simTick + Math.imul(r, 0x16)) | 0;
    const d = (bearing - mech.aimAngle) | 0;
    if (d < 0xa0000 && -0xa0000 < d && ((mech.targetSecondary & 0xff) === mechs.playerMechIndex || randomRange(3) === 0)) {
      aiBearingToTarget(mech, mech.targetSecondary);
      if (r === 0 && aiDecideFire(mech) !== 0 && ((mech.aiCapabilities & 0x10) === 0 || aiHasLineOfFire(mech, 1))) {
        fired = 1;
        mech.control!.weapon_fire = 1;
      }
    }
  }
  if (fired === 0) r = 0;
  const pc = mech.control!;
  pc.torso_pan = Math.imul(aiStepTorsoPan(mech, bearing, r), 0x2d00);
  pc.torso_tilt = Math.imul(aiStepTorsoTilt(mech, r), -0xf00);
  return fired;
}

// --- behind --------------------------------------------------------------------

/**
 * Behaviour 1's spot: which of eight 45-degree sectors around targetSecondary
 * (0 in front) the mech stands in, then where to go - from the front (0, 1,
 * 7) a rear quarter on the same side (0: 2 or 6 at random, the other when
 * THIS mech's own claim byte for it is set); from beside or behind the first
 * of 2, 3, 4 (or 6, 5, 4) no one has claimed on the target, else 4.
 * Returns sector * 2.
 *
 * @mw2 ai_behind_pick_sector 0x0002e6f0
 * @fidelity exact
 */
export function aiBehindPickSector(mech: MechEntity): number {
  const t = mechs.mechTable[mech.targetSecondary & 0xff]!;
  const saved = t.targetHandle;
  aiBearingToTarget(t, (mech.index | 0x200) & 0xffff);
  const a = cmod((mechHeadingError(t) + 0x1680000) | 0, 0x1680000);
  aiBearingToTarget(t, i16(saved));
  let s = (sdivShl(a, 16, 0x2d0000) + 0x8000) >> 16;
  if (7 < s) s = 0;
  if (s === 0 || s === 1 || s === 7) {
    if (s === 0) {
      s = randomRange(2) === 0 ? 6 : 2;
      quirk('ai_behind_pick_sector: the front case tests the chooser\'s own behindSectorClaims, not the target\'s', 'ai_behind_pick_sector');
      if (mech.behindSectorClaims[s] !== 0) s = s === 2 ? 6 : 2;
    }
    if (s === 1) s = 3;
    if (s === 7) s = 5;
  } else if (s < 5) {
    let found = false;
    s = 2;
    while (s < 5 && !found) {
      if (t.behindSectorClaims[s] === 0) found = true;
      s++;
    }
    s--;
  } else {
    let found = false;
    s = 6;
    while (3 < s && !found) {
      if (t.behindSectorClaims[s] === 0) found = true;
      s--;
    }
    s++;
  }
  return s * 2;
}
