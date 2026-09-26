/**
 * The per-tick hooks the gamepiece classes point at (MechEntity.hooks[1..5]).
 * They are registered here so gamepieceClasses() resolves every address in
 * the table: the turret class (3) and the door class (7) have their hooks
 * here; the standard class's slots 1 to 3 live with their bodies.
 *
 * Slot arguments are the drivers' (sim/mech/hooks.ts): (loadout, index) for
 * slots 1, 2 and 5, (loadout) for 3 and 4.
 */
import type { MechLoadout } from '../../generated/classes.gen.ts';
import { fixedCos, fixedSin } from '../../core/angle/trig.ts';
import { mulr16 } from '../../core/int/fx16.ts';
import { sdivShl } from '../../core/int/i64.ts';
import { quirk, unestablished } from '../../core/provenance.ts';
import { rampStep } from '../../core/ramp.ts';
import { randomRange } from '../../core/random.ts';
import { clock } from '../../engine/clock.ts';
import { registerCode } from '../../engine/codePtr.ts';
import { vec3Normalise } from '../../engine/collision/ray.ts';
import { sceneNodeGetWorldPos, sceneNodeSetEuler, sceneNodeSetOrigin, sceneNodeWalk } from '../../engine/scene/sceneGraph.ts';
import { objectives } from '../../mission/objectives.ts';
import { aiValidateCurrentTarget } from '../ai/targeting.ts';
import { trackedGlobals } from '../ai/tracked.ts';
import { missionEventNop } from '../things/gameThingDamage.ts';
import { mechUpdateMissileLock, mechWeaponsTick } from '../weapons/weapons.ts';
import { playerCockpitFrame, playerCockpitRelease } from '../cockpit/hud.ts';
import { mechs } from './mechGlobals.ts';
// hook slots 1, 2 and 3 of the standard class live with their bodies
import { mechAiThink, mechDeathUpdate, mechHeatUpdate } from './mechTickAi.ts';
import './mechTickTerrain.ts';

/**
 * Hook 4 of the standard classes (the player's mech only): player_cockpit_frame
 * when the loadout is non-null.
 *
 * @mw2 mech_std_cockpit 0x00028660
 * @fidelity exact
 */
export const mechStdCockpit = registerCode('mech_std_cockpit', 0x28660, (l: MechLoadout | null): void => {
  if (l) playerCockpitFrame(l);
});

/**
 * Hook 5 of the standard classes, once after the mission loop: for the
 * player's mech, player_cockpit_release.
 *
 * @mw2 mech_std_cockpit_release 0x00028670
 * @fidelity exact
 */
export const mechStdCockpitRelease = registerCode('mech_std_cockpit_release', 0x28670, (l: MechLoadout | null, _index: number): void => {
  if (l && mechs.playerMechIndex === l.entity!.index) playerCockpitRelease();
});

/**
 * Hook 1 of class 3 (turrets): steps the pan and tilt ramps into the aim
 * node's pitch and the torso node's yaw (aimAngle), and walks the node.
 *
 * @mw2 mech_alt_tick_terrain 0x0002ec80
 * @fidelity exact
 */
export const mechAltTickTerrain = registerCode('mech_alt_tick_terrain', 0x2ec80, (l: MechLoadout | null, _index: number): void => {
  if (!l) return;
  const t = clock.simTick;
  l.heatThisTick = 0;
  rampStep(l.ramps[0]!, t);
  rampStep(l.ramps[1]!, t);
  if (l.weaponAimNode) sceneNodeSetEuler(l.weaponAimNode, l.ramps[1]!.current, 0, 0, 0);
  const e = l.entity!;
  if (l.torsoNode) {
    e.torsoPitch = 0;
    e.aimAngle = l.ramps[0]!.current;
    e.torsoRoll = 0;
    sceneNodeSetEuler(l.torsoNode, e.torsoPitch, e.aimAngle, e.torsoRoll, 0);
  }
  sceneNodeWalk(e.node!);
});

/**
 * Hook 2 of class 3: think; while not running, the ramps and controls go to
 * rest. Running: the weapons, the target (an AI turret keeps none of its
 * own), missile lock, no autopilot, no throttle while overheated, and the
 * torso ramp - a turret with a pan limit only clamped to it (its torso_pan
 * command is not applied), a full-circle one set to the command with its
 * current unwound to within half a turn of it - and tilt from torso_tilt.
 * Then heat and the life cycle (power-up 6..8 s; shutdown restarts at
 * once; destroyed: the wreck's explosions for 10 s).
 *
 * @mw2 mech_alt_tick_ai 0x0002ed20
 * @fidelity exact
 */
export const mechAltTickAi = registerCode('mech_alt_tick_ai', 0x2ed20, (l: MechLoadout, _index: number): void => {
  const e = l.entity!;
  mechAiThink(e);
  const pc = e.control!;
  if (l.status !== 2) {
    l.ramps[0]!.target = 0;
    l.ramps[1]!.target = 0;
    pc.throttle = 0;
    pc.torso_pan = 0;
    pc.torso_tilt = 0;
  } else {
    mechWeaponsTick(l);
    if (e.controlSource === 2) e.targetHandle = 0;
    else if (e.targetHandle !== 0 && (e.targetHandle & 0x1000) === 0 && aiValidateCurrentTarget(e) === 0) e.targetHandle = 0;
    mechUpdateMissileLock(l);
    l.autopilotEngaged = 0;
    pc.autopilot = 0;
    if ((l.flags & 4) !== 0 && (l.flags & 8) === 0) pc.throttle = 0;
    const lim = l.torsoPanLimit;
    const pan = pc.torso_pan;
    let tiltToo = true;
    if (lim < 0x1680000) {
      if (lim < l.ramps[0]!.target) {
        l.ramps[0]!.target = lim;
        l.ramps[1]!.target = pc.torso_tilt;
        tiltToo = false;
      } else if (l.ramps[0]!.target < (-lim | 0)) l.ramps[0]!.target = -lim | 0;
    } else {
      let d = (pan - l.ramps[0]!.current) | 0;
      while (0xb40000 < d) d = (d - 0x1680000) | 0;
      while (d < -0xb40000) d = (d + 0x1680000) | 0;
      l.ramps[0]!.target = pan;
      l.ramps[0]!.current = (pan - d) | 0;
    }
    if (tiltToo) l.ramps[1]!.target = pc.torso_tilt;
  }
  mechHeatUpdate(l);
  const now = clock.simTick;
  switch (l.status) {
    case 0:
      l.status = 1;
      l.stateTimer = (now + 0x444 + randomRange(0x16c)) | 0;
      return;
    case 1:
      if (l.stateTimer < clock.simTick) l.status = 2;
      return;
    case 3:
      l.status = 0;
      return;
    case 4:
      if (l.stateTimer === 0) {
        l.stateTimer = (clock.simTick + 0x71c) | 0;
        missionEventNop();
      }
      if (clock.simTick < l.stateTimer) mechDeathUpdate(l);
      return;
    default:
      return;
  }
});

/**
 * Hook 5 of class 3: push ebp / mov ebp, esp / test eax, eax / pop ebp / ret -
 * nothing.
 *
 * @mw2 mech_alt_hook5 0x0002ef20
 * @fidelity exact
 */
export const mechAltHook5 = registerCode('mech_alt_hook5', 0x2ef20, (_l: MechLoadout | null, _index: number): void => {});

/**
 * Hook 1 of the door class: while running, steps the three position ramps
 * into posX / posY / posZ, places the node and refreshes the heading vector.
 *
 * @mw2 door_tick_move 0x000332f0
 * @fidelity exact
 */
export const doorTickMove = registerCode('door_tick_move', 0x332f0, (l: MechLoadout | null, _index: number): void => {
  if (!l || l.status !== 2) return;
  const t = clock.simTick;
  rampStep(l.ramps[2]!, t);
  rampStep(l.ramps[4]!, t);
  rampStep(l.ramps[3]!, t);
  const e = l.entity!;
  e.posX = l.ramps[2]!.current;
  e.posY = l.ramps[4]!.current;
  e.posZ = l.ramps[3]!.current;
  sceneNodeSetOrigin(e.node!, e.posX, e.posY, e.posZ);
  sceneNodeSetEuler(e.node!, e.pitch, e.heading, e.roll, 0);
  sceneNodeWalk(e.node!);
  e.headingSin = fixedSin(e.heading) >> 0xd;
  e.headingCos = fixedCos(e.heading) >> 0xd;
});

/**
 * Hook 2 of the door class: think; while running, when the group's current
 * objective is 'reach' (0x100) with a nav point as its first target, aim
 * the position ramps: at the nav point - or, when it is within one step
 * (speed * tickDelta << 16 / 0x697e98) of the node, at the step-long unit
 * vector toward it, an offset from the WORLD ORIGIN rather than from the
 * door (0x334fc..0x3356c). That 'within' compares 64-bit squared lengths and
 * counts equality on the low dword alone. Not running, the animation fields
 * clear. Then the life cycle: a door runs at once; destroyed, it explodes
 * for 10 s.
 *
 * @mw2 door_tick_ai 0x000333c0
 * @fidelity exact
 */
export const doorTickAi = registerCode('door_tick_ai', 0x333c0, (l: MechLoadout, _index: number): void => {
  const e = l.entity!;
  mechAiThink(e);
  if (l.status === 2) {
    const g = e.groupId;
    const cur = objectives.groupCurrentObjective[g]!;
    e.targetHandle = 0;
    e.control!.autopilot = 0;
    if (cur < 0) unestablished('door_tick_ai: the group has no current objective and the C reads objectives[-1]', 'door_tick_ai');
    else {
      const o = objectives.objectiveTables[g]!.objectives[cur]!;
      if (o.type >>> 0 === 0x100 && (o.targetCount & 0xff) !== 0 && o.targets[0]!.kind === 1) doorAimAt(l, o.targets[0]!.index & 0xff);
    }
  } else {
    e.gaitBand = 0;
    e.animTarget = -1;
  }
  switch (l.status) {
    case 0:
      l.status = 2;
      l.stateTimer = 0;
      return;
    case 1:
    case 3:
      l.status = 2;
      return;
    case 4:
      if (l.stateTimer === 0) {
        l.stateTimer = (clock.simTick + 0x71c) | 0;
        missionEventNop();
      }
      if (clock.simTick < l.stateTimer) mechDeathUpdate(l);
      return;
    default:
      return;
  }
});

/** door_tick_ai's ramp aim at nav point `nav` (0x3345a..0x33581). @portOnly */
function doorAimAt(l: MechLoadout, nav: number): void {
  const [nx, ny, nz] = sceneNodeGetWorldPos(l.entity!.node!);
  const t = trackedGlobals.trackedObjects[nav]!;
  const d = [(t.x - nx) | 0, (t.y - ny) | 0, (t.z - nz) | 0];
  const step = sdivShl(Math.imul(l.speed, clock.tickDelta), 16, 0x697e98);
  const M64 = (1n << 64n) - 1n;
  const sq = (v: number) => BigInt(v) * BigInt(v);
  const dist2 = (sq(d[0]!) + sq(d[1]!) + sq(d[2]!)) & M64;
  const step2 = sq(step) & M64;
  const within = dist2 < step2 || ((dist2 - step2) & 0xffffffffn) === 0n;
  let tx = t.x;
  let ty = t.y;
  let tz = t.z;
  if (within) {
    quirk('door_tick_ai: within a step of the nav point the ramps aim at a step-long offset from the world origin', 'door_tick_ai');
    vec3Normalise(d);
    tx = mulr16(d[0]!, step);
    ty = mulr16(d[1]!, step);
    tz = mulr16(d[2]!, step);
  }
  l.ramps[2]!.target = tx;
  l.ramps[4]!.target = ty;
  l.ramps[3]!.target = tz;
}

/**
 * Hook 5 of the door class: the same seven empty bytes as mech_alt_hook5.
 *
 * @mw2 door_hook5_nop 0x00033620
 * @fidelity exact
 */
export const doorHook5Nop = registerCode('door_hook5_nop', 0x33620, (_l: MechLoadout | null, _index: number): void => {});
