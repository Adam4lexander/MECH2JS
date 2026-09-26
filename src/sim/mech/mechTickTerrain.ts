/**
 * Hook slot 1 of the standard mech class: the MOVEMENT TICK
 * (mech_std_tick_terrain). It steps the five control ramps, turns them into
 * acceleration - ground traction, or jump-jet lift, thrust and drag -
 * integrates, moves with collision, lands, slides on slopes, turns, and
 * aims the weapons and torso. The upstream annotation gives the rules step
 * by step; this follows it and the C line by line.
 *
 * Units: positions cm; velocities 16.16 cm per 182 Hz tick (1 m/s = 36010);
 * accelerations 16.16 cm per tick squared (1 g = 0x794); angles 16.16
 * degrees; ramps[3] degrees per second; tickDelta the ticks this frame.
 */
import { fixedAsin, fixedCos, fixedSin } from '../../core/angle/trig.ts';
import { cmod } from '../../core/int/cint.ts';
import { mulDiv64, mulr16 } from '../../core/int/fx16.ts';
import { mulShr, sdivShl } from '../../core/int/i64.ts';
import { rampStep } from '../../core/ramp.ts';
import { Ray, type MechEntity, type MechLoadout, type WorldObject } from '../../generated/classes.gen.ts';
import { clock } from '../../engine/clock.ts';
import { registerCode } from '../../engine/codePtr.ts';
import { raySetLength } from '../../engine/collision/ray.ts';
import { sceneNodeGetWorldPos, sceneNodeSetEuler, sceneNodeSetOrigin, sceneNodeWalk } from '../../engine/scene/sceneGraph.ts';
import { viewShakeImpulse } from '../camera/cameraUpdate.ts';
import { cameraGlobals } from '../camera/viewer.ts';
import { net } from '../net/netplay.ts';
import { soundPlay, soundPlayAt } from '../sound/sound.ts';
import { mechAimRange, mechUpdateAimRange, weaponBuildFireRay } from '../weapons/aim.ts';
import { collision, mechMoveStep, worldGroundHeightNear } from '../world/collision.ts';
import { lighting } from '../world/environment.ts';
import { planet } from '../world/planet.ts';
import { mechApplyDamage, mechCollisionDamage, obstacleCollisionDamage } from './damage.ts';
import { mechs } from './mechGlobals.ts';
import { mechRuntime } from './mechRuntime.ts';
import { mechCrashToGround } from './mechTickAi.ts';

/** The octagonal length max + (mid + min) / 4, as (4 max + mid + min) >> 2. */
function oct3(x: number, y: number, z: number): number {
  let a = x < 0 ? -x | 0 : x;
  let b = y < 0 ? -y | 0 : y;
  let c = z < 0 ? -z | 0 : z;
  if (a < b) [a, b] = [b, a];
  if (a < c) [a, c] = [c, a];
  return ((Math.imul(a, 4) + b + c) | 0) >> 2;
}

/**
 * The landing thump: a view kick for the player, and sound 0xe5 (hard) or
 * 0xe6 (soft), switched at the fall-damage threshold.
 *
 * @mw2 mech_play_landing 0x00028be0
 * @fidelity exact
 */
export function mechPlayLanding(l: MechLoadout, vy: number): void {
  const e = l.entity!;
  if (mechs.playerMechIndex === e.index) viewShakeImpulse(0, -vy | 0, 0);
  const v = cameraGlobals.viewerPosition ?? cameraGlobals.mainViewer;
  soundPlayAt(e.posX - v.posX, e.posY - l.rideHeight - v.posY, e.posZ - v.posZ, (-0x102763 < vy ? 1 : 0) + 0xe5, cameraGlobals.cockpitViewActive);
}

/**
 * Horizontal drag under directional jets: a(L) = -(c2 L + c1) L along -v/L,
 * zero unless L, K and jetDeltaY are all positive (see the upstream note).
 * Returns [dragX, dragZ].
 */
function jetDrag(l: MechLoadout, vx: number, vz: number): [number, number] {
  // L: the horizontal octagonal speed; the decompiler dropped the unreachable y term (0x26bb6)
  const a = vx < 0 ? -vx | 0 : vx;
  const b = vz < 0 ? -vz | 0 : vz;
  let m = a;
  let extra = 0;
  if (a < 0) {
    m = 0;
    extra = a;
  }
  let mx = m;
  let mn = b;
  if (m < b) {
    mx = b;
    mn = m;
  }
  const L = ((Math.imul(mx, 4) + extra + mn) | 0) >> 2;
  const K = Number(BigInt.asIntN(32, (BigInt(l.speed | 0) * 0x1400n) / 2n));
  if (L < 1 || K < 1 || l.jetDeltaY < 1) return [0, 0];
  const KK = mulr16(K, K);
  const q = sdivShl(l.jetDeltaY, 16, K);
  const u58 = (l.jetDeltaY - ((q / 3) | 0)) | 0;
  const denom = (KK - ((Math.imul(K, 3) / 4) | 0)) | 0;
  const c2 = sdivShl(u58, 16, denom);
  const u14 = (l.jetDeltaY - mulr16(c2, KK)) | 0;
  const c1 = sdivShl(u14, 16, K);
  const aL = -mulr16((mulr16(c2, L) + c1) | 0, L) | 0;
  return [mulDiv64(aL, vx, L), mulDiv64(aL, vz, L)];
}

/**
 * Hook slot 1: the movement tick.
 *
 * @mw2 mech_std_tick_terrain 0x00026990
 * @fidelity exact
 */
export const mechStdTickTerrain = registerCode('mech_std_tick_terrain', 0x26990, (l: MechLoadout | null, _index: number): void => {
  if (!l) return;
  const e = l.entity!;
  const hitObject: { v: WorldObject | null } = { v: null };
  const hitMech: { v: MechEntity | null } = { v: null };
  let simulate = 1;
  if (l.status === 4 && e.onGround !== 0) return;
  if (((l.flags >> 8) & 1) !== 0) return;
  l.heatThisTick = 0;
  const isPlayer = e.index === mechs.playerMechIndex;
  if (mechs.netGameEnabled !== 0 && !isPlayer) simulate = 0;
  if (simulate !== 0) {
    const t = clock.simTick;
    const td = clock.tickDelta;
    const pc = e.control!;
    const gravity = planet.gravity;
    rampStep(l.ramps[0]!, t);
    rampStep(l.ramps[1]!, t);
    rampStep(l.ramps[3]!, t);
    rampStep(l.ramps[4]!, t);
    rampStep(l.ramps[2]!, t);
    let velX = l.velocityX;
    const vy0 = l.velocityY;
    let velZ = l.velocityZ;
    let ax = 0;
    let az = 0;
    let ay = -gravity | 0;
    let dragX = 0;
    let dragZ = 0;
    const jetsHeld = !(pc.jumpjet_enabled === 0 || l.jumpFuel < 1);
    if (e.onGround === 0 || jetsHeld) {
      [dragX, dragZ] = jetDrag(l, velX, velZ);
    } else {
      // traction toward ramps[2] along the heading, with a 45-tick time constant
      let s = l.ramps[2]!.current;
      if (s < 0x20 && -0x20 < s) s = 0;
      const wx = mulr16(s, e.headingSin);
      const wz = mulr16(s, e.headingCos);
      if (td < 0x2d) {
        ax = (((wx - l.velocityX) | 0) / 0x2d) | 0;
        az = (((wz - l.velocityZ) | 0) / 0x2d) | 0;
      } else if (td < 1) {
        ax = 0;
        az = 0;
      } else {
        ax = (((wx - l.velocityX) | 0) / td) | 0;
        az = (((wz - l.velocityZ) | 0) / td) | 0;
      }
    }
    if (pc.jumpjet_enabled === 0 || l.jumpFuel < 1 || l.status !== 2) {
      if (vy0 === 0 && e.onGround !== 0) ay = 0;
    } else {
      velX = l.velocityX;
      velZ = l.velocityZ;
      let lift = 0;
      if (0 < vy0) lift = (mulr16(Math.imul((gravity - l.jetDeltaY) | 0, 0xe38), vy0) / lighting.jetClimbLimit) | 0;
      ay = (ay + lift + l.jetDeltaY) | 0;
      const sn = e.headingSin;
      const cs = e.headingCos;
      const j = l.jetDeltaY;
      const holdOrCoast = () => (vy0 < 1 ? 0 : -gravity | 0);
      if (pc.legsPan === 0) {
        if (pc.jumpjet_fire_left !== 0) {
          ay = holdOrCoast();
          ax = (ax + ((dragX - mulr16(cs, j)) | 0)) | 0;
          az = (az + mulr16(sn, j) + dragZ) | 0;
        } else if (pc.jumpjet_fire_right !== 0) {
          ay = holdOrCoast();
          ax = (ax + mulr16(cs, j) + dragX) | 0;
          az = (az + ((dragZ - mulr16(sn, j)) | 0)) | 0;
        } else if (pc.jumpjet_fire_forward !== 0 || pc.jumpjet_fire_backward !== 0) {
          ay = holdOrCoast();
          let tx = mulr16(sn, j);
          let tz = mulr16(cs, j);
          if (pc.jumpjet_fire_forward === 0) {
            tx = -tx | 0;
            tz = -tz | 0;
          }
          az = (az + tz + dragZ) | 0;
          ax = (ax + tx + dragX) | 0;
        }
      } else ay = holdOrCoast();
    }
    // integrate: v' = v + a dt; step = (a dt / 2 + v) dt >> 16
    const axd = Math.imul(ax, td);
    const ayd = Math.imul(ay, td);
    const azd = Math.imul(az, td);
    const nvx = (velX + axd) | 0;
    let stepX = mulShr(((axd >> 1) + velX) | 0, td, 16);
    let velY = (vy0 + ayd) | 0;
    let stepY = mulShr(((ayd >> 1) + vy0) | 0, td, 16);
    const nvz = (velZ + azd) | 0;
    let stepZ = mulShr(((azd >> 1) + velZ) | 0, td, 16);
    velX = nvx < 0x1000 && -0x1000 < nvx ? 0 : nvx;
    velZ = nvz < 0x1000 && -0x1000 < nvz ? 0 : nvz;
    l.stepVelocityX = velX;
    l.stepVelocityY = velY;
    l.stepVelocityZ = velZ;
    const out = { x: e.posX, y: e.posY, z: e.posZ };
    hitMech.v = null;
    e.blockedByMech = -1;
    let clearance: number;
    if (mechMoveStep(l, hitObject, hitMech, stepX, stepY, stepZ, out) === 0) {
      if (isPlayer) mechRuntime.dat000fb534 = 0;
      collision.groundNormalX = 0;
      collision.groundNormalY = 0;
      collision.groundNormalZ = 0;
      e.groundHeight = worldGroundHeightNear(out.x, out.y, out.z);
      clearance = (out.y - l.rideHeight - e.groundHeight) | 0;
    } else {
      // re-check the displacement actually achieved, from the old position
      stepX = (out.x - e.posX) | 0;
      stepY = (out.y - e.posY) | 0;
      stepZ = (out.z - e.posZ) | 0;
      velX = l.velocityX;
      velY = l.velocityY;
      velZ = l.velocityZ;
      const firstBlocked = l.blockedSteps;
      // DIVERGENCE, an uninitialised local (checked 2026-09-26). The recheck's
      // hit object is [ebp+0x4e], which nothing here initialises: the prologue
      // zeroes only hitObject and hitMech (0x269ab). mech_move_step leaves it
      // unwritten when it returns blocked from a solid obstacle sphere
      // (0x1fd97) or a zero step with blockedSteps set (0x1fdd6), and the
      // compare at 0x27112 then reads stack residue: the mech sticks (reset to
      // the old position) when the residue differs from hitObject, and slides
      // when it matches. The slot lies at main's esp - 0x64, the depth every
      // hook1 runs at (mech_dispatch_hook1 calls them all at one esp), so it
      // holds whatever last reached that depth - for the player, first in the
      // dispatch, the last task task_list_run ran. An ANIM track step leaves
      // there the ebx that scene_node_rebuild_subtree pushes: 0 for pitch and
      // roll rotations and x / z moves, the step's value for yaw and y moves
      // (0x1ad72..0x1ad93, 0x1e400); object tasks and other paths leave
      // other values. The port takes the residue as null, the slide - the
      // common case for mech animations. Measured in the port: AI mechs meet
      // the case about once in ten minutes; the player pushing into a solid
      // obstacle sphere (the training missions' 3 m posts) on up to 1 frame
      // in 6, where the original may stick instead of sliding round.
      const recheck: { v: WorldObject | null } = { v: null };
      if (mechMoveStep(l, recheck, hitMech, stepX, stepY, stepZ, { x: 0, y: 0, z: 0 }) !== 0) {
        if (recheck.v !== hitObject.v) {
          out.x = e.posX;
          out.y = e.posY;
          out.z = e.posZ;
        }
        velX = (velX * 2) | 0;
        l.velocityX = velX;
        velY = (velY * 2) | 0;
        l.velocityY = velY;
        velZ = (velZ * 2) | 0;
        l.velocityZ = velZ;
      }
      l.blockedSteps = firstBlocked;
      if (l.status === 4) {
        mechCrashToGround(l);
        e.onGround = 1;
        return;
      }
      collision.groundNormalX = 0;
      collision.groundNormalY = 0;
      collision.groundNormalZ = 0;
      e.groundHeight = worldGroundHeightNear(out.x, out.y, out.z);
      clearance = (out.y - l.rideHeight - e.groundHeight) | 0;
      if ((collision.rayHitNormalY | 0) < 0xb506 || 999 < clearance || clearance < -9999) {
        // a wall
        // mech_move_step writes hitMech on a mech hit (TS cannot see the write through the call)
        const other = hitMech.v as MechEntity | null;
        if (!other) obstacleCollisionDamage(l, hitObject.v);
        else mechCollisionDamage(l, other.loadout);
        if (isPlayer && cameraGlobals.cockpitViewActive !== 0 && mechRuntime.dat000fb534 === 0) {
          mechRuntime.dat000fb534 = 1;
          let sp = oct3(l.stepVelocityX, l.stepVelocityY, l.stepVelocityZ);
          if (200000 < sp) {
            // the original reads hitObject->type here even when an obstacle hit left hitObject unset (a null read)
            const id = other ? 0xf0 : hitObject.v && ((hitObject.v.type >> 8) & 2) !== 0 ? 200 : 0xe5;
            if (1500000 < sp) sp = 1500000;
            soundPlay(id, mulDiv64(sp, 200, 1500000), 0x40, 5, 0x32);
            viewShakeImpulse(collision.rayHitNormalX, collision.rayHitNormalY, collision.rayHitNormalZ);
          }
        }
      } else {
        // a walkable surface: land on it
        clearance = -1;
        l.blockedSteps = 0;
      }
    }
    e.onGround = 0;
    if (l.rideHeight < clearance) {
      e.motionFlags &= 0xfe;
      e.motionFlags |= 4;
      if (isPlayer && mechRuntime.dat00096208 !== 0) mechRuntime.dat00096204 = 1;
    } else {
      e.motionFlags &= 0xfb;
      if (clearance < 1) {
        e.onGround = 1;
        if (clearance < 0) {
          if (velY < -0x56276) {
            if (l.status === 4) {
              mechCrashToGround(l);
              return;
            }
            mechPlayLanding(l, velY);
          }
          if (velY < -0x102762 && mechs.simOptions.collisionDamage !== 0) {
            const d = Math.imul(sdivShl((velY + 0x102762) | 0, 16, -0x204ec4), 0x32);
            mechApplyDamage(l, d, 8);
            mechApplyDamage(l, d, 7);
          }
          velY = 0;
          l.velocityY = 0;
          out.y = (e.groundHeight + l.rideHeight) | 0;
        }
      }
    }
    // slope: gravity * (the slope along the heading) feeds the forward speed
    const gnX = collision.groundNormalX;
    const gnZ = collision.groundNormalZ;
    if ((gnX !== 0 || gnZ !== 0) && simulate !== 0 && e.onGround !== 0) {
      const s = (mulr16(e.headingCos, gnZ) + mulr16(e.headingSin, gnX)) | 0;
      const th = lighting.slopeThreshold;
      if (th < s || s < -th) l.ramps[2]!.current = (l.ramps[2]!.current + mulr16(mulr16(gravity, s), td)) | 0;
    }
    if (net.netRole === 0 || (e.flags & 1) === 0 || isPlayer) {
      e.posX = out.x;
      e.posY = out.y;
      e.posZ = out.z;
      e.heading = (e.heading + ((Math.imul(l.ramps[3]!.current, td) / 0xb6) | 0)) | 0;
      e.heading = cmod(e.heading, 0x1680000);
      l.velocityX = velX;
      l.velocityY = velY;
      l.velocityZ = velZ;
      sceneNodeSetOrigin(e.node!, e.posX, e.posY, e.posZ);
      sceneNodeSetEuler(e.node!, e.pitch, e.heading, e.roll, 0);
    }
  }
  // the aim, for every mech
  if (isPlayer) mechUpdateAimRange(e);
  const half = l.ramps[1]!.current >> 1;
  if (l.weaponAimNode) {
    const ray = new Ray();
    weaponBuildFireRay(e, ray);
    raySetLength(ray, mechAimRange(e));
    const p = sceneNodeGetWorldPos(l.weaponAimNode);
    const dx = (ray.endX - p[0]) | 0;
    const dy = (ray.endY - p[1]) | 0;
    const dz = (ray.endZ - p[2]) | 0;
    const len = oct3(dx, dy, dz);
    const el = len === 0 ? 0 : fixedAsin(sdivShl(dy, 29, len));
    sceneNodeSetEuler(l.weaponAimNode, (-half - el) | 0, 0, 0, 0);
  }
  if (l.torsoNode) {
    e.torsoPitch = ((l.flags >> 8) & 0x20) === 0 ? 0 : half;
    e.aimAngle = l.ramps[0]!.current;
    e.torsoRoll = 0;
    sceneNodeSetEuler(l.torsoNode, e.torsoPitch, e.aimAngle, e.torsoRoll, 1);
  }
  sceneNodeWalk(e.node!);
  e.headingSin = fixedSin(e.heading) >> 0xd;
  e.headingCos = fixedCos(e.heading) >> 0xd;
});
