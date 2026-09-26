/**
 * The create hooks - MechEntity.hooks[0], run once per gamepiece by
 * mech_dispatch_hook0 after the mission has loaded (main: sim_load_by_name,
 * day_cycle_init, ..., mech_dispatch_hook0). They take (entity, index), not
 * the loadout the other slots take.
 *
 *   mech_std_create  classes 1, 2, 4, 5, 6, 8 (mechs, vehicles, aircraft)
 *   mech_alt_create  class 3 (the artillery turrets)
 *   door_create      class 7 (doors)
 */
import type { MechEntity, MechLoadout } from '../../generated/classes.gen.ts';
import { sdivShl } from '../../core/int/i64.ts';
import { rampStart } from '../../core/ramp.ts';
import { registerCode } from '../../engine/codePtr.ts';
import { clock } from '../../engine/clock.ts';
import { sceneNodeGetWorldEuler, sceneNodeGetWorldPos, sceneNodeLinkSubtree, sceneNodeTranslate, sceneNodeWalk } from '../../engine/scene/sceneGraph.ts';
import { planet } from '../world/planet.ts';
import { mechAiSetup } from './aiSetup.ts';
import { hudWidgetsInstall } from '../cockpit/hud.ts';
import { mechs } from './mechGlobals.ts';
import { thingNodeQueuePop } from './spawn.ts';

/**
 * A new mech's animation fields: animTarget -1, gaitBand 0, and step sound
 * 0x103 for every mech but the player's (whose comes from the ASND chunk).
 *
 * @mw2 mech_anim_init 0x0001f460
 * @fidelity exact
 */
export function mechAnimInit(e: MechEntity): void {
  if (mechs.playerMechIndex !== e.index) e.animSoundId = 0x103;
  e.gaitBand = 0;
  e.animTarget = -1;
}

/** Lift by rideHeight, walk, read the pose back into the entity, zero the torso angles - the part all three create hooks share. */
function placeOnNode(l: MechLoadout): void {
  const e = l.entity!;
  sceneNodeTranslate(e.node!, 0, l.rideHeight, 0);
  sceneNodeWalk(e.node!);
  const eu = sceneNodeGetWorldEuler(l.entity!.node!);
  l.entity!.pitch = eu.pitch;
  l.entity!.heading = eu.yaw;
  l.entity!.roll = eu.roll;
  const p = sceneNodeGetWorldPos(l.entity!.node!);
  l.entity!.posX = p[0];
  l.entity!.posY = p[1];
  l.entity!.posZ = p[2];
}

/**
 * Hook 0 of the standard classes: pops the torso and weapon-aim nodes,
 * installs the HUD for the player, starts the five control ramps (torso pan
 * 0.2 s for the player, 0.6 s for anyone else; tilt 0.2; speed 0.2; turn 0.3;
 * throttle 0.2 from 0x400), clears the run state, lifts the node by
 * rideHeight and reads the pose back, initialises the animation, links the
 * node into the world, sets the controls (autopilot at 80% throttle for the
 * player under -R), runs mech_ai_setup, and divides speed by the mission's
 * gravity in g.
 *
 * @mw2 mech_std_create 0x000266e0
 * @fidelity partial
 * @divergence mech_ai_setup's rule tables are Phase 5 stubs; the loadout dwords at +0x90 and +0xf0 (header padding, no port fields) are zeroed in the original
 */
export const mechStdCreate = registerCode('mech_std_create', 0x266e0, (entity: MechEntity): void => {
  const l = entity.loadout;
  if (!l) return;
  const t = clock.simTick;
  l.torsoNode = thingNodeQueuePop();
  l.weaponAimNode = thingNodeQueuePop();
  if (mechs.playerMechIndex === l.entity!.index) hudWidgetsInstall();
  rampStart(l.ramps[0]!, 0, 0, l.entity!.index === mechs.playerMechIndex ? 0.2 : 0.6, t);
  rampStart(l.ramps[2]!, 0, 0, 0.2, t);
  rampStart(l.ramps[3]!, 0, 0, 0.3, t);
  rampStart(l.ramps[1]!, 0, 0, 0.2, t);
  rampStart(l.ramps[4]!, 0x400, 0x400, 0.2, t);
  l.selectedWeapon = 0;
  l.heatLevel = 0;
  l.selectedWeaponCopy = 0;
  l.blockedSteps = 0;
  l.status = 0;
  l.stateTimer = 0;
  // +0x90 = 0: no port field
  l.heatThisTick = 0;
  l.weaponCycleLock = 0;
  l.autopilotEngaged = 0;
  l.velocityX = 0;
  l.velocityY = 0;
  l.velocityZ = 0;
  l.stepVelocityX = 0;
  l.stepVelocityY = 0;
  l.stepVelocityZ = 0;
  // +0xf0 = 0: no port field
  l.throttleScale = 0x10000;
  l.flags = (l.flags | 0x2000) & 0xffff;
  placeOnNode(l);
  const e = l.entity!;
  e.torsoRoll = 0;
  e.aimAngle = e.torsoRoll;
  e.torsoPitch = e.torsoRoll;
  const c = e.control!;
  c.advance_target = 0;
  c.previous_target = 0;
  c.reset_target = 0;
  c.nearest_enemy = 0;
  c.nextObjective = 0;
  mechAnimInit(e);
  sceneNodeLinkSubtree(e.node!);
  if (mechs.keepPlayerControls === 0 || mechs.playerMechIndex !== e.index) {
    c.autopilot = 0;
    c.throttle = 0;
    c.advance_nav = 0;
  } else {
    c.throttle = 0x333;
    c.autopilot = 1;
    c.advance_nav = 1;
    mechs.DAT_00096eec = 1;
  }
  mechAiSetup(e);
  l.speed = sdivShl(l.speed, 16, planet.gravitySetting);
});

/**
 * Hook 0 of class 3 (the turrets): the torso and aim nodes, two 0.8 s ramps,
 * run state cleared, numWeapons forced to 10, flags 0x2000, the node lifted
 * and read back, controls off, mech_ai_setup, and speed 0.
 *
 * @mw2 mech_alt_create 0x0002eb00
 * @fidelity partial
 * @divergence mech_ai_setup's rule tables are Phase 2; the loadout dword at +0xf0 (no port field) is zeroed in the original
 */
export const mechAltCreate = registerCode('mech_alt_create', 0x2eb00, (entity: MechEntity): void => {
  const l = entity.loadout;
  if (!l) return;
  const t = clock.simTick;
  l.torsoNode = thingNodeQueuePop();
  l.weaponAimNode = thingNodeQueuePop();
  rampStart(l.ramps[0]!, 0, 0, 0.8, t);
  rampStart(l.ramps[1]!, 0, 0, 0.8, t);
  l.selectedWeapon = 0;
  l.heatLevel = 0;
  l.selectedWeaponCopy = 0;
  l.numWeapons = 10;
  l.blockedSteps = 0;
  l.flags = 0x2000;
  l.status = 0;
  l.stateTimer = 0;
  l.heatThisTick = 0;
  l.weaponCycleLock = 0;
  l.autopilotEngaged = 0;
  l.velocityY = 0;
  // +0xf0 = 0: no port field
  placeOnNode(l);
  const e = l.entity!;
  e.torsoRoll = 0;
  e.aimAngle = e.torsoRoll;
  e.torsoPitch = e.torsoRoll;
  e.gaitBand = 0;
  e.animTarget = -1;
  sceneNodeLinkSubtree(e.node!);
  e.control!.autopilot = 0;
  e.control!.throttle = 0;
  e.control!.advance_nav = 0;
  mechAiSetup(e);
  l.speed = 0;
});

/**
 * Hook 0 of class 7 (doors): run state cleared, throttleScale 1.0, the node
 * lifted and read back, and three 0.3 s ramps seeded with the door's
 * position (ramps[2] x, ramps[4] y, ramps[3] z) - the door's position from
 * then on. Animation fields cleared, node linked, heading vector (1, 0),
 * mech_ai_setup.
 *
 * @mw2 door_create 0x00033140
 * @fidelity partial
 * @divergence mech_ai_setup's rule tables are Phase 2; the loadout dword at +0xf0 (no port field) is zeroed in the original
 */
export const doorCreate = registerCode('door_create', 0x33140, (entity: MechEntity): void => {
  const l = entity.loadout;
  if (!l) return;
  const t = clock.simTick;
  l.selectedWeapon = 0;
  l.heatLevel = 0;
  l.throttleScale = 0x10000;
  l.selectedWeaponCopy = 0;
  l.numWeapons = 0;
  l.blockedSteps = 0;
  l.flags = 0;
  l.status = 0;
  l.stateTimer = 0;
  l.heatThisTick = 0;
  l.weaponCycleLock = 0;
  l.autopilotEngaged = 0;
  l.velocityY = 0;
  // +0xf0 = 0: no port field
  placeOnNode(l);
  rampStart(l.ramps[2]!, l.entity!.posX, l.entity!.posX, 0.3, t);
  rampStart(l.ramps[4]!, l.entity!.posY, l.entity!.posY, 0.3, t);
  rampStart(l.ramps[3]!, l.entity!.posZ, l.entity!.posZ, 0.3, t);
  const e = l.entity!;
  e.torsoRoll = 0;
  e.aimAngle = e.torsoRoll;
  e.torsoPitch = e.torsoRoll;
  e.gaitBand = 0;
  e.animTarget = -1;
  e.animSoundId = -1;
  sceneNodeLinkSubtree(e.node!);
  e.headingSin = 0;
  e.headingCos = 0x10000;
  mechAiSetup(e);
});
