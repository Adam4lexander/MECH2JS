/**
 * Hook slots 2 and 3 of the standard mech class: the CONTROL TICK
 * (mech_std_tick_ai), which turns controls into the ramp targets
 * mech_std_tick_terrain integrates and runs the life cycle and heat, and
 * the PLAYER TICK (mech_std_tick_player), the cockpit requests, death and
 * ejection. The upstream annotations on both functions give the full rules
 * and units; this file follows them line by line.
 *
 * Units: angles and angular rates 16.16 degrees (rates per second), ramps[4]
 * the throttle with 0x400 as neutral, ramps[2] forward speed, heatLevel
 * 16.16 percent, ticks at 182 Hz.
 */
import { fixedCos } from '../../core/angle/trig.ts';
import { mulr16, mulDiv64 } from '../../core/int/fx16.ts';
import { mulr29 } from '../../core/int/i64.ts';
import { quirk } from '../../core/provenance.ts';
import { randomNext, randomRange } from '../../core/random.ts';
import type { MechEntity, MechLoadout } from '../../generated/classes.gen.ts';
import { clock } from '../../engine/clock.ts';
import { registerCode } from '../../engine/codePtr.ts';
import { cameraGlobals } from '../camera/viewer.ts';
import { messagePost } from '../cockpit/messages.ts';
import { effectSpawnAt, effectSpawnOnMount } from '../effects/effects.ts';
import { groupGetLeader, mechAllegiance } from '../groups/groups.ts';
import { net } from '../net/netplay.ts';
import { soundCuePlay, soundPlay, soundPlayAt } from '../sound/sound.ts';
import { destructiblesRegisterSubtree } from '../things/destructibles.ts';
import { detailRecordReleaseNode } from '../world/detailRecords.ts';
import { paletteStartFade } from '../world/palettes.ts';
import { planet } from '../world/planet.ts';
import { sceneNodeGetWorldPos } from '../../engine/scene/sceneGraph.ts';
import { mechAnimClearRequest, mechAnimSelectGait } from './animTask.ts';
import { aiRulesRun, groupAssignObjectiveTask } from './laterPhases.ts';
import {
  aiCycleFriendly,
  aiCycleGamepiece,
  aiCycleGamething,
  aiCycleNavpoint,
  aiCycleTarget,
  aiTargetNearestEnemy,
  aiValidateCurrentTarget,
  playerTargetReticle,
} from '../ai/targeting.ts';
import { mechDamageSlot, mechEject, mechOnDestroyed } from './damage.ts';
import { mechUpdateMissileLock, mechWeaponsTick, weaponCycleGroup, weaponCycleNext, weaponJettisonAmmo } from '../weapons/weapons.ts';
import { loadoutAmmo, loadoutSections, loadoutWeapons } from './loadout.ts';
import { mechs } from './mechGlobals.ts';
import { mechRuntime } from './mechRuntime.ts';
import { unestablished, divergence } from '../../core/provenance.ts';
import { resolveCode } from '../../engine/codePtr.ts';
import { bootImage } from '../../engine/image.ts';
import { LABEL } from '../../generated/labels.gen.ts';

const viewerPos = () => cameraGlobals.viewerPosition ?? cameraGlobals.mainViewer;

/** C's (int)x / 1024 (truncating) - the `(x + (x >> 31) * -0x400 - ...) >> 10` idiom */
const div1024 = (x: number) => ((x / 1024) | 0);

/**
 * Sets cameraMode; once the player is out, every request is replaced by
 * ejectCameraMode (made 1 the first time).
 *
 * @mw2 camera_set_mode 0x00039400
 * @fidelity exact
 */
export function cameraSetMode(mode: number): void {
  const c = cameraGlobals;
  if (mechRuntime.playerOut !== 0) {
    mode = c.ejectCameraMode;
    if (c.ejectCameraMode === -1) {
      mode = 1;
      c.ejectCameraMode = 1;
    }
  }
  c.cameraMode = mode;
}

/**
 * The player's death flash: the ZAPPED palette for two seconds.
 *
 * @mw2 death_flash 0x00028910
 * @fidelity exact
 */
export function deathFlash(): void {
  paletteStartFade(0x11, 0x16c, 1);
}

/**
 * A destroyed mech reaching the ground: its nodes become debris, it stops
 * being simulated (loadout flags 0x100), and the crash sounds.
 *
 * @mw2 mech_crash_to_ground 0x00020b10
 * @fidelity exact
 */
export function mechCrashToGround(l: MechLoadout): void {
  const e = l.entity!;
  destructiblesRegisterSubtree(e.node, detailRecordReleaseNode, 999);
  l.flags = (l.flags | 0x100) & 0xffff;
  const v = viewerPos();
  soundPlayAt(e.posX - v.posX, e.posY - v.posY, e.posZ - v.posZ, 0xb5, cameraGlobals.cockpitViewActive);
}

/**
 * Every weapon mid-burst or holding goes back to ready; the netplay fire
 * flags clear.
 *
 * @mw2 mech_weapons_cancel_bursts 0x00052020
 * @fidelity partial
 * @divergence the two netplay weapon-fired arrays it zeroes are not kept by the port
 */
export function mechWeaponsCancelBursts(l: MechLoadout): void {
  const w = loadoutWeapons(l);
  for (let i = 0; i < 10; i++) {
    const fs = w[i]!.fireState;
    if (fs === 2 || fs === 3) w[i]!.fireState = 1;
  }
}

/**
 * Jump-jet exhaust at both leg nodes, and the jet or low-fuel sound.
 *
 * @mw2 mech_jump_jet_effects 0x00028ae0
 * @fidelity exact
 */
export function mechJumpJetEffects(l: MechLoadout): void {
  const e = l.entity!;
  const p = [0, 0, 0];
  for (const i of [6, 7]) {
    const n = l.sectionNodes[i];
    if (n) {
      e.mountNode = n;
      effectSpawnOnMount(0x19, e);
      const w = sceneNodeGetWorldPos(n);
      p[0] = w[0]!;
      p[1] = w[1]!;
      p[2] = w[2]!;
    }
  }
  const v = viewerPos();
  const dx = p[0]! - v.posX;
  const dy = p[1]! - v.posY;
  const dz = p[2]! - v.posZ;
  if (mechs.playerMechIndex === e.index && l.jumpFuel < 0x1c7 && 0x1c7 < l.jumpFuel + clock.tickDelta) soundPlay(0xde, 100, 0x40, 5, 0x50);
  else soundPlayAt(dx, dy, dz, 0xdf, cameraGlobals.cockpitViewActive);
}

/**
 * The wreck's explosions: the first call a blast at the mech, later calls a
 * 21-in-100 chance of one scattered around it.
 *
 * @mw2 mech_death_update 0x000289f0
 * @fidelity exact
 */
export function mechDeathUpdate(l: MechLoadout): void {
  const e = l.entity!;
  let x = e.posX;
  const y = e.posY;
  let z = e.posZ;
  let id: number;
  if (l.stateTimer === 0) id = 0xd;
  else {
    if (0x14 < randomRange(100)) return;
    x = (x + ((randomNext() / 2) | 0)) | 0;
    z = (z + ((randomNext() / 2) | 0)) | 0;
    if (randomRange(100) < 0x3c) {
      effectSpawnAt(3, x, y, z, x, y, z);
      return;
    }
    id = 0x10b;
  }
  effectSpawnAt(id, x, y, z, x, y, z);
}

/**
 * Overheating's end: the first ammo bin cooks off, or the mech is destroyed.
 *
 * @mw2 mech_heat_meltdown 0x00024ec0
 * @fidelity exact
 */
export function mechHeatMeltdown(l: MechLoadout): void {
  if (l.ammo) {
    const sections = loadoutSections(l);
    const code = loadoutAmmo(l)[0]!.slotCode & 0xffff;
    for (let i = 0; i < 8; i++) {
      const s = sections[i]!;
      if (((s.flags & 0xffff) >> 8) & 0x20) continue;
      for (let k = 0; k < s.numSlots; k++) {
        if (s.slots[k] === code) {
          mechDamageSlot(l, i + 1, k, 0);
          return;
        }
      }
    }
    if (mechRuntime.autoEjectEnabled !== 0 || mechs.playerMechIndex !== l.entity!.index) l.status = 5;
  }
  if (l.entity!.index === mechs.playerMechIndex) soundCuePlay(0, -1);
  mechOnDestroyed(l);
}

/**
 * The heat model: heatThisTick in, dissipation out, then the ladder of
 * warnings, shutdown and meltdown. See the upstream note for the rules.
 *
 * @mw2 mech_heat_update 0x00024f90
 * @fidelity exact
 */
export function mechHeatUpdate(l: MechLoadout): void {
  const e = l.entity!;
  const r = mechRuntime;
  const t = clock.simTick;
  if ((e.flags & 2) !== 0 || (e.flags & 4) !== 0) return;
  if (mechs.simOptions.heatTracking === 0 && mechs.playerMechIndex === e.index) {
    l.heatLevel = 0;
    l.heatThisTick = 0;
    return;
  }
  const net = (l.heatThisTick - Math.imul(l.heatDissipation << (l.status === 3 ? 1 : 0), clock.tickDelta)) | 0;
  l.heatLevel = (l.heatLevel + net) | 0;
  if (l.heatLevel < 0) l.heatLevel = 0;
  const h = l.heatLevel >> 16;
  const isPlayer = mechs.playerMechIndex === e.index;
  if ((l.flags & 4) !== 0 && (l.flags & 8) === 0 && l.status !== 3 && !(((t - l.stateTimer) | 0) < 0x445)) {
    l.stateTimer = t;
    l.status = 3;
    if (isPlayer) soundCuePlay(0xd, -1);
    return;
  }
  if (h >= 0x65 && (l.flags & 8) !== 0) {
    if ((!isPlayer || mechs.simOptions.invulnerability === 0) && Math.imul(clock.tickDelta, 500) !== 0 && randomRange(Math.imul(clock.tickDelta, 500)) === 0) mechHeatMeltdown(l);
    return;
  }
  if (h >= 0x65 && l.status === 3) {
    if (0x71c < ((t - l.stateTimer) | 0)) mechHeatMeltdown(l);
    return;
  }
  if (h >= 0x51 && (l.flags & 4) === 0) {
    l.stateTimer = t;
    l.flags = (l.flags | 4) & 0xffff;
    if (((l.flags >> 8) & 0x10) === 0 && isPlayer) {
      l.flags = (l.flags | 0x1000) & 0xffff;
      soundCuePlay(3, -1);
      soundPlay(0xe9, 100, 0x40, 5, 0x50);
    }
    return;
  }
  if (h >= 0x42) {
    if (isPlayer && r.heatWarningLatch === 0 && 0 < net) {
      r.heatWarningTick = t;
      r.heatWarningLatch = 1;
      soundCuePlay(0, -1);
      soundPlay(0xe9, 100, 0x40, 5, 0x50);
    }
    return;
  }
  if ((l.flags & 4) === 0) {
    if (r.heatWarningLatch !== 0 && 0x2d8 < ((t - r.heatWarningTick) | 0) && e.index === mechs.playerMechIndex) r.heatWarningLatch = 0;
    l.flags &= ~0x1000 & 0xffff;
  } else {
    if (l.status === 3 && 0x2d8 < ((t - l.stateTimer) | 0)) {
      l.status = 0;
      l.flags &= ~0x4 & 0xffff;
    }
    if ((l.flags & 8) !== 0) l.flags &= ~0xc & 0xffff;
  }
}

/**
 * Logs an attack on the player's side of the table and makes it the mech's
 * state: aiState 3 (attack), targetSecondary the target.
 *
 * @mw2 ai_log_attack 0x00023650
 * @fidelity partial
 * @divergence the AI log line is not written
 */
export function aiLogAttack(attackerIndex: number, targetIndex: number): void {
  if (attackerIndex === mechs.playerMechIndex || net.netRole !== 0) {
    const a = mechs.mechTable[attackerIndex]!;
    a.aiState = 3;
    a.targetSecondary = (targetIndex | 0x200) & 0xffff;
  }
}

/** aiStateHandlers (0x9601c): 13 code pointers indexed by aiState */
function aiStateHandler(state: number): ((e: MechEntity, target: number) => void) | null {
  const exe = bootImage();
  if (!exe || state < 0 || state > 12) return null;
  return resolveCode(exe.u32(LABEL.aiStateHandlers + state * 4)) as ((e: MechEntity, target: number) => void) | null;
}

/**
 * The per-mech AI decision step: group work for leaders, then the rules or
 * the state handler for AI mechs; for the player, walking into an enemy
 * counts as attacking it.
 *
 * @mw2 mech_ai_think 0x00021510
 * @fidelity partial
 * @divergence the AI debug log (mission_log_sub_0214a0) and the per-pass global at 0xf4ab4 are not kept; the AI itself is Phase 5 (the rules and state handlers are stubs)
 */
export function mechAiThink(e: MechEntity): void {
  if (e.aiState === 0xc) return;
  if (groupGetLeader(e.groupId) === e.index) groupAssignObjectiveTask(e.groupId);
  if (e.controlSource === 2) {
    if (aiRulesRun(e) === 0) {
      const h = aiStateHandler(e.aiState);
      if (h) h(e, (e.targetPrimary << 16) >> 16);
      else divergence(`aiStateHandlers[${e.aiState}] is not ported (Phase 5)`, 'mech_ai_think');
    }
    e.targetHandle = (e.targetSecondary << 16) >> 16;
    aiValidateCurrentTarget(e);
  } else if (e.loadout!.blockedSteps !== 0 && e.blockedByMech !== -1) {
    if (mechAllegiance(e.blockedByMech) === 1) aiLogAttack(e.index, mechs.mechTable[e.blockedByMech]!.index);
  }
}

/**
 * The player's autopilot along the nav points.
 *
 * @mw2 autopilot_drive 0x00024ca0
 * @fidelity stub
 * @divergence Phase 4/5: it steers with the AI's ai_steer_heading and ai_handle_blocked and cycles nav points; while engaged the port only reports it
 */
export function autopilotDrive(l: MechLoadout): void {
  if (l.autopilotEngaged !== 0) unestablished('the autopilot is engaged, and autopilot_drive is not ported', 'autopilot_drive');
}

/**
 * Hook slot 2: the control tick. See the upstream annotation.
 *
 * @mw2 mech_std_tick_ai 0x00027780
 * @fidelity partial
 * @divergence its AI, weapons, targeting, damage, effects and sound callees are later-phase stubs (sim/mech/laterPhases.ts, sound, effects); the order of every call is the original's
 */
export const mechStdTickAi = registerCode('mech_std_tick_ai', 0x27780, (l: MechLoadout, _index: number): void => {
  const r = mechRuntime;
  const e = l.entity!;
  const pc = e.control!;
  let jetsFiring = 0;
  let local = true;
  if (((l.flags >> 8) & 2) !== 0) return;
  const isPlayer = e.index === mechs.playerMechIndex ? 1 : 0;
  if (mechs.netGameEnabled !== 0 && isPlayer === 0) local = false;
  if (-1 < r.testDamageSlot && -1 < r.testDamageLocation && mechs.playerMechIndex === e.index) {
    mechDamageSlot(l, r.testDamageLocation, r.testDamageSlot, 0);
    r.testDamageSlot = -1;
  }
  mechAiThink(e);
  if (pc.self_destruct !== 0) mechEject(l, 0);
  if (l.status === 2) mechWeaponsTick(l);
  if (l.status === 2 && local) {
    if (pc.advance_nav !== 0) {
      aiCycleNavpoint(e, 1, 0);
      pc.advance_nav = 0;
    }
    if (pc.previous_nav !== 0) {
      aiCycleNavpoint(e, -1, 0);
      pc.previous_nav = 0;
    }
    if (pc.reset_nav !== 0) {
      aiCycleNavpoint(e, 0, 0);
      pc.reset_nav = 0;
    }
    if (pc.advance_target !== 0) {
      aiCycleTarget(e, 1, 8);
      pc.advance_target = 0;
    }
    if (pc.previous_target !== 0) {
      aiCycleTarget(e, -1, 8);
      pc.previous_target = 0;
    }
    if (pc.reset_target !== 0) {
      aiCycleTarget(e, 0, 8);
      quirk('reset_target clears previous_target, not itself', 'mech_std_tick_ai');
      pc.previous_target = 0;
    }
    if (pc.nearest_enemy !== 0) {
      aiTargetNearestEnemy();
      pc.nearest_enemy = 0;
    }
    if (pc.target_friendly !== 0) {
      aiCycleFriendly(1);
      pc.target_friendly = 0;
    }
    if (pc.target_last_shot !== 0) pc.target_last_shot = 0;
    if (pc.nextObjective !== 0) {
      aiCycleTarget(e, 1, 0x10008);
      pc.nextObjective = 0;
    }
    if (pc.advance_gamething !== 0) {
      aiCycleGamething(1);
      pc.advance_gamething = 0;
    }
    if (pc.previous_gamething !== 0) {
      aiCycleGamething(-1);
      pc.previous_gamething = 0;
    }
    if (pc.reset_gamething !== 0) {
      aiCycleGamething(0);
      pc.previous_gamething = 0;
    }
    if (pc.advance_gamepiece !== 0) {
      aiCycleGamepiece(1);
      pc.advance_gamepiece = 0;
    }
    if (pc.previous_gamepiece !== 0) {
      aiCycleGamepiece(-1);
      pc.previous_gamepiece = 0;
    }
    if (pc.reset_gamepiece !== 0) {
      aiCycleGamepiece(0);
      pc.previous_gamepiece = 0;
    }
    if (pc.target_reticle !== 0) {
      playerTargetReticle();
      pc.target_reticle = 0;
    }
    if ((e.targetHandle & 0x1000) === 0) aiValidateCurrentTarget(e);
    mechUpdateMissileLock(l);
    if ((pc.legs_pan_delta !== 0 || r.alignLegsToTorso !== 0) && l.autopilotEngaged !== 0) pc.autopilot = 1;
    if (pc.autopilot !== 0) {
      if (l.autopilotEngaged === 0) {
        l.autopilotEngaged = 1;
        if (mechs.playerMechIndex === e.index) soundCuePlay(0x1d, 1);
      } else {
        l.autopilotEngaged = 0;
        if (mechs.playerMechIndex === e.index) soundCuePlay(0x1d, 2);
      }
    }
    pc.autopilot = 0;
    if (e.controlSource === 0 && l.autopilotEngaged === 0) pc.legsPan = pc.legs_pan_delta;
    if (e.controlSource === 0) autopilotDrive(l);
    if (local) l.ramps[4]!.target = (mulr16(pc.throttle, l.throttleScale) + 0x400) | 0;
    if (e.controlSource !== 2 && local && l.ramps[4]!.target === 0x400 && (pc.legsPan !== 0 || r.alignLegsToTorso !== 0)) l.ramps[4]!.target = 0x480;
  }
  mechAnimSelectGait(e);
  const gravity = planet.gravity;
  // a mech this machine does not simulate skips from here to the not-running step
  if (local) {
    if (l.jumpFuel === -2 && pc.cheatJumpjets !== 0) {
      l.jumpFuel = 0x71c;
      l.jumpCapacity = 3;
      l.jetDeltaY = Math.imul(gravity, 3);
    }
    if (-1 < l.jumpFuel) {
      if (pc.jumpjet_enabled === 0 || l.status !== 2) {
        if (l.jumpFuel < 0x71c) l.jumpFuel = (l.jumpFuel + ((clock.tickDelta / 4) | 0)) | 0;
        else l.jumpFuel = 0x71c;
      } else {
        jetsFiring = 1;
        if (r.cheatInfiniteJumpjets === 0 || isPlayer === 0) l.jumpFuel = (l.jumpFuel - clock.tickDelta) | 0;
        if (l.jumpFuel < 1) l.jumpFuel = 0;
        if (0 < l.jumpFuel) {
          mechJumpJetEffects(l);
          l.heatThisTick = (l.heatThisTick + Math.imul(Math.imul(l.jumpCapacity, 0x180), clock.tickDelta)) | 0;
          e.motionFlags &= 0xfb;
          e.motionFlags &= 0xfe;
        }
      }
    }
    if (jetsFiring === 0) {
      if ((e.motionFlags & 4) === 0) {
        let v = (l.ramps[2]!.current / 10000) | 0;
        if (v === 0 && (isPlayer === 0 || l.throttleScale < 1)) l.ramps[3]!.target = 0;
        else {
          if (0x50 < v) v = 0x50;
          const turnInput = Math.imul(div1024(pc.legsPan), 0x5a);
          quirk('the turn-rate cosine takes the forward speed in km/h as an angle in degrees', 'mech_std_tick_ai');
          // (int64)turnInput * cos >> 29, rounded by bit 28
          l.ramps[3]!.target = mulr29(turnInput, fixedCos(v << 16));
        }
      } else if (l.autopilotEngaged === 0) l.ramps[3]!.target = 0;
    } else {
      let t = 0;
      if (0 < l.jumpFuel) t = Math.imul(div1024(pc.legsPan), 0x5a);
      l.ramps[3]!.target = (t * 2) | 0;
    }
    if (mechs.playerMechIndex === e.index) {
      if (r.alignLegsToTorso !== 0) alignLegsStep(l);
      r.lastPlayerHeading = e.heading;
    }
  }
  if (local && !(net.netRole !== 0 && (e.flags & 1) !== 0 && isPlayer === 0)) {
    let t = (l.ramps[4]!.current - 0x400) | 0;
    if (t < 0x20) t = 0;
    l.ramps[2]!.target = Math.imul(t, l.speed);
    const s = l.ramps[2]!.target;
    if (s !== 0 && e.animState === 2) l.ramps[2]!.target = -(s >> 1) | 0;
    if (jetsFiring === 0 && (e.motionFlags & 2) !== 0) {
      if (r.mascEngaged !== 0 && 0xb6 < ((clock.simTick - r.mascLastRollTick) | 0)) {
        r.mascLastRollTick = clock.simTick;
        if (randomRange(0x3c) === 0xc && mechs.simOptions.invulnerability === 0 && l.status === 2) {
          messagePost('MASC malfunction!', 1, 0x16c);
          soundPlay(0xc9, 100, 0x40, 5, 0x50);
          l.heatLevel = (l.heatLevel + (l.heatLevel >> 2)) | 0;
          r.mascEngaged = 0;
        }
      }
      l.ramps[2]!.duration = 0x5b;
      if (r.mascEngaged !== 0 && mechs.playerMechIndex === e.index) l.ramps[2]!.target = (l.ramps[2]!.target + (l.ramps[2]!.target >> 1)) | 0;
    }
    {
      if (r.alignLegsToTorso === 0) l.ramps[0]!.target = pc.torso_pan;
      const lim = l.torsoPanLimit;
      if (lim < l.ramps[0]!.target) {
        l.ramps[0]!.target = lim;
        pc.torso_pan = lim;
        pc.torso_pan_set = 1;
      } else {
        const tg = l.ramps[0]!.target;
        if (-tg !== lim && tg <= -lim) {
          l.ramps[0]!.target = -lim | 0;
          pc.torso_pan = -l.torsoPanLimit | 0;
          pc.torso_pan_set = 1;
        }
      }
      l.ramps[1]!.target = pc.torso_tilt;
      l.heatThisTick = (l.heatThisTick + mulDiv64((l.ramps[4]!.current - 0x400) | 0, l.heatDissipation, 0x2800)) | 0;
    }
  }
  if (l.status !== 2) {
    mechAnimClearRequest(e);
    l.ramps[4]!.target = 0x400;
    l.ramps[2]!.target = 0;
    l.ramps[0]!.target = 0;
    l.ramps[3]!.target = 0;
    l.ramps[1]!.target = 0;
    pc.throttle = 0;
    pc.throttle_set = 1;
    pc.torso_pan_reset = 1;
    pc.torso_tilt_reset = 1;
    pc.jumpjet_enabled = 0;
    pc.jumpjet_fire_left = 0;
    pc.jumpjet_fire_right = 0;
    pc.jumpjet_fire_forward = 0;
    pc.jumpjet_fire_backward = 0;
    pc.weapon_fire = 0;
    pc.weapon_cycle = 0;
    pc.legs_pan_minus = 0;
    pc.legs_pan_plus = 0;
    pc.reverseDirection = 0;
    pc.advance_nav = 0;
    pc.autopilot = 0;
    mechWeaponsCancelBursts(l);
  }
  mechHeatUpdate(l);
  const now = clock.simTick;
  switch (l.status) {
    case 0: {
      const rr = randomRange(0x16c);
      l.status = 1;
      l.stateTimer = (now + 0x444 + rr) | 0;
      e.flags &= ~0x2000 & 0xffff;
      const v = viewerPos();
      const dx = e.posX - v.posX;
      const dy = e.posY - v.posY;
      const dz = e.posZ - v.posZ;
      if (mechAllegiance(e.index) === 1) {
        if (((mechs.mechTable[mechs.playerMechIndex]!.flags >> 8) & 0x20) !== 0) {
          soundPlayAt(dx, dy, dz, 0x104, cameraGlobals.cockpitViewActive);
          soundCuePlay(0x1a, -1);
        }
      } else soundPlayAt(dx, dy, dz, 0xf7, cameraGlobals.cockpitViewActive === 0 ? 1 : 0);
      break;
    }
    case 1:
      if (l.stateTimer < clock.simTick) {
        l.status = 2;
        e.flags = (e.flags | 0x2000) & 0xffff;
        e.flags &= ~0x10 & 0xffff;
      }
      break;
    case 3:
      e.flags = (e.flags | 0x10) & 0xffff;
      break;
    case 4:
      e.flags &= ~0x2000 & 0xffff;
      if (l.stateTimer === 0) {
        mechDeathUpdate(l);
        l.stateTimer = (clock.simTick + 0x71c) | 0;
      }
      if (clock.simTick < l.stateTimer) mechDeathUpdate(l);
      else l.flags = (l.flags | 0x200) & 0xffff;
      break;
  }
  if (mechs.playerMechIndex === e.index) {
    const tg = l.ramps[0]!.target;
    const cur = l.ramps[0]!.current;
    if ((cur + 0x20000 < tg || tg < cur - 0x20000) && cameraGlobals.cockpitViewActive !== 0) {
      const v = viewerPos();
      soundPlayAt(e.posX - v.posX, e.posY - v.posY, e.posZ - v.posZ, 0x13c, cameraGlobals.cockpitViewActive);
    }
  }
});

/**
 * FEET_TO_TORSO: the legs turn at +/-55 deg/s toward the torso while the
 * torso twist is counter-rotated by each tick's heading change; done when
 * the twist is within a degree. (mech_std_tick_ai, 0x27d6f..0x27f0a)
 */
function alignLegsStep(l: MechLoadout): void {
  const r = mechRuntime;
  const e = l.entity!;
  let h = e.heading;
  // both headings folded into +/-180 degrees, then made to agree across the seam
  if (h >> 16 >= 0xb5) h = -(0x1680000 - h) | 0;
  else if (h >> 16 < -0xb4) h = (h + 0x1680000) | 0;
  const hi = h >> 16;
  if (r.lastPlayerHeading >> 16 >= 0xb5) r.lastPlayerHeading = -(0x1680000 - r.lastPlayerHeading) | 0;
  else if (r.lastPlayerHeading >> 16 < -0xb4) r.lastPlayerHeading = (r.lastPlayerHeading + 0x1680000) | 0;
  const li = r.lastPlayerHeading >> 16;
  if (hi >= 0x5b && li <= -0x5b) h = -(0x1680000 - h) | 0;
  else if (0x5a < li && hi < -0x5a) h = (h + 0x1680000) | 0;
  const pan = l.ramps[0]!.current;
  if (pan < -0xffff || 0xffff < pan) {
    l.ramps[3]!.target = pan < 1 ? -0x370000 : 0x370000;
    const d = (h - r.lastPlayerHeading) | 0;
    if (d !== 0) {
      const v = (l.ramps[0]!.current - d) | 0;
      l.ramps[0]!.target = v;
      l.ramps[0]!.current = v;
    }
  } else {
    l.ramps[3]!.target = 0;
    l.ramps[0]!.target = 0;
    l.ramps[3]!.current = 0;
    l.ramps[0]!.current = 0;
    mechs.playerControls.torso_pan_reset = 1;
    r.alignLegsToTorso = 0;
    e.control!.torso_pan = 0;
  }
}

/**
 * Hook slot 3 (the player's mech only): weapon and group cycling, ammo
 * jettison, MASC, the reactor requests, the death flash and the ejection
 * timer.
 *
 * @mw2 mech_std_tick_player 0x00028320
 * @fidelity partial
 * @divergence weapon cycling and jettison are Phase 3 stubs; sounds and cues are Phase 7
 */
export const mechStdTickPlayer = registerCode('mech_std_tick_player', 0x28320, (l: MechLoadout | null): void => {
  const r = mechRuntime;
  if (!l) return;
  const st = l.status >>> 0;
  if (st < 4) {
    if (st === 2) {
      const pc = l.entity!.control!;
      if (r.dat00096200 !== 0) {
        r.dat00096200 = 0;
        if (l.weaponCycleLock === 0) {
          soundPlay(0xfd, 0x32, 0x40, 5, 0x32);
          weaponCycleNext(l);
        }
      }
      if (pc.weapon_cycle !== 0 && l.weaponCycleLock === 0) {
        soundPlay(0xfd, 0x32, 0x40, 5, 0x32);
        weaponCycleNext(l);
      }
      if (pc.weapon_cycle_group !== 0) weaponCycleGroup();
      if (r.jettisonAmmoRequest !== 0) {
        r.jettisonAmmoRequest = 0;
        weaponJettisonAmmo(l);
      }
      if (r.mascToggleRequest !== 0) {
        r.mascToggleRequest = 0;
        if ((l.flags & 0x10) === 0) messagePost('Not equipped with MASC!', 1, 0x16c);
        else {
          const on = r.mascEngaged === 0;
          if (on) {
            r.mascEngaged = 1;
            soundPlay(0xcb, 100, 0x40, 5, 0x50);
          } else {
            r.mascEngaged = 0;
            soundPlay(0xca, 100, 0x40, 5, 0x50);
          }
          soundCuePlay(0x1f, on ? 1 : 0);
        }
      }
    }
  } else if (st < 5) {
    if (r.dat00096220 !== 0) return;
    r.dat00096220 = 1;
    deathFlash();
    r.playerOut = 1;
    cameraSetMode(1);
    return;
  } else if (st === 5) {
    if (r.dat0009621c === 0) {
      r.dat0009621c = 1;
      l.stateTimer = (clock.simTick + 0x38e) | 0;
      return;
    }
    if (clock.simTick < l.stateTimer) {
      cameraSetMode(4);
      return;
    }
    r.playerOut = 1;
    return;
  }
  if (r.reactorRequest < 0) {
    if (r.reactorRequest !== -1) return;
    if (l.status !== 3) {
      soundCuePlay(0xd, -1);
      const e = l.entity!;
      const v = viewerPos();
      soundPlayAt(e.posX - v.posX, e.posY - v.posY, e.posZ - v.posZ, 0xf2, cameraGlobals.cockpitViewActive);
      l.status = 3;
      r.reactorRequest = 0;
    }
  } else if (0 < r.reactorRequest) {
    if (r.reactorRequest !== 1) return;
    if (((l.flags & 4) === 0 || (l.flags & 8) !== 0) && l.status === 3) {
      messagePost('Powering up...', 1, 0x16c);
      l.status = 0;
      l.entity!.flags &= ~0x10 & 0xffff;
      r.reactorRequest = 0;
    }
  }
});
