/**
 * The AI state machine. aiState (aiStateNames): -1 nothing, 0 idle, 1 avoid,
 * 2 target, 3 attack, 4 flee, 5 follow, 6 recon, 7 patrol, 8 godirect, 9
 * (unnamed), 10 rest, 11 shutdown, 12 dead. A mech changes state only
 * through ai_try_enter_state, and only into a state its rule blocks have
 * rules for. Each think with no rule firing runs aiStateHandlers[aiState]:
 * hold (0, 11), attack (3, the behaviour scheduler) or move (the rest).
 *
 * Also the movement primitives every state and behaviour steers with:
 * throttle by standoff, heading to legsPan, the torso steps, and the
 * temporary waypoints a mech makes for itself.
 */
import type { MechEntity } from '../../generated/classes.gen.ts';
import { LABEL } from '../../generated/labels.gen.ts';
import { cmod, i16, iabs, u16 } from '../../core/int/cint.ts';
import { mulr16 } from '../../core/int/fx16.ts';
import { x87MulTrunc } from '../../core/int/x87.ts';
import { quirk } from '../../core/provenance.ts';
import { randomRange } from '../../core/random.ts';
import { clock } from '../../engine/clock.ts';
import { registerCode } from '../../engine/codePtr.ts';
import { bootImage, imageF64 } from '../../engine/image.ts';
import { logWrite } from '../../engine/logWrite.ts';
import { groupGetLeader, starGetSlotTarget } from '../groups/groups.ts';
import { mechs } from '../mech/mechGlobals.ts';
import { radioLanceMessage } from '../sound/sound.ts';
import { things } from '../things/gameThings.ts';
import { worldObjectGetPos } from '../world/worldRecords.ts';
import { ai } from './aiGlobals.ts';
import { aiBehaviourTick, aiExitBehaviour } from './behaviours.ts';
import { objectEngageRange, objectTestFlags } from './handles.ts';
import { aiHandleBlocked, aiJetsCushionFall, aiPilotUpdate } from './pilot.ts';
import { aiRulesRebuild, aiStateTargetUnclaimed, mechHasRulesForState } from './rules.ts';
import { aiCycleNavpoint, aiValidateCurrentTarget } from './targeting.ts';
import { trackedGlobals, trackedObjectCreate, trackedObjectRemove } from './tracked.ts';

// --- small steps ------------------------------------------------------------

/**
 * value + offset clamped to +/-0x400; with matchSign the offset first takes
 * value's sign.
 *
 * @mw2 ai_bias_clamped 0x00023a40
 * @fidelity exact
 */
export function aiBiasClamped(value: number, offset: number, matchSign: number): number {
  if (matchSign !== 0 && (offset < 0 ? -1 : 1) !== (value < 0 ? -1 : 1)) offset = -offset | 0;
  const r = (value + offset) | 0;
  if (0x400 < r) return 0x400;
  return r < -0x400 ? -0x400 : r;
}

/**
 * The torso pan command for a pan in 16.16 degrees: pan / 0x2d00, biased by
 * delta * 2 and clamped (the caller scales back by 0x2d00).
 *
 * @mw2 ai_step_torso_pan 0x00022970
 * @fidelity exact
 */
export function aiStepTorsoPan(_mech: MechEntity, currentPan: number, delta: number): number {
  return aiBiasClamped((currentPan / 0x2d00) | 0, Math.imul(delta, 2), 1);
}

/**
 * The torso tilt command: torsoTilt / 0xf00, biased by delta * 2, clamped.
 *
 * @mw2 ai_step_torso_tilt 0x000229a0
 * @fidelity exact
 */
export function aiStepTorsoTilt(mech: MechEntity, delta: number): number {
  return aiBiasClamped((mech.torsoTilt / 0xf00) | 0, Math.imul(delta, 2), 1);
}

/**
 * Throttle by standoff: 0x400 beyond twice it, 0 inside it, 0x333 between;
 * a moving throttle is cut to (0x4000000 - |legsPan| * 2/3) >> 16 (at least
 * 0x66) while the legs turn harder than 45; halved above 65% heat; below
 * 0x66 it is 0.
 *
 * @mw2 ai_choose_throttle 0x000228d0
 * @fidelity exact
 */
export function aiChooseThrottle(mech: MechEntity, standoff: number): number {
  let t: number;
  if (Math.imul(standoff, 2) < mech.targetDistance) t = 0x400;
  else if (mech.targetDistance < standoff) t = 0;
  else t = 0x333;
  const pan = iabs(mech.control!.legsPan);
  if (t !== 0 && 0x2d < pan >> 16) {
    // fild |legsPan|; fmul qword [0x909cd] (2/3); clib_fp_trunc; fistp - the product rounded to a double (53-bit precision)
    const scaled = x87MulTrunc(pan, imageF64(0x909cd, 2 / 3));
    t = ((0x4000000 - scaled) | 0) >> 16;
    if (t < 0x66) t = 0x66;
  }
  if (0x41 < mech.loadout!.heatLevel >> 16) t >>= 1;
  return t < 0x66 ? 0 : t;
}

/**
 * The heading error (desiredHeading - heading, folded once into +/-180) as a
 * leg turn: legsPan = +/-0x3333333 beyond 45 degrees, otherwise
 * (degrees << 16) / 45 * 0x3333333 >> 16, rounded. Returns the error.
 *
 * @mw2 ai_steer_heading 0x000229e0
 * @fidelity exact
 */
export function aiSteerHeading(mech: MechEntity): number {
  let error = (mech.desiredHeading - mech.heading) | 0;
  if (0xb40000 < error) error = (error - 0x1680000) | 0;
  else if (error < -0xb40000) error = (error + 0x1680000) | 0;
  const degrees = cmod(error >> 16, 0x168);
  const pc = mech.control!;
  if (0x2d < degrees) pc.legsPan = 0x3333333;
  else if (degrees < -0x2d) pc.legsPan = -0x3333333;
  else pc.legsPan = mulr16(((degrees << 16) / 0x2d) | 0, 0x3333333);
  return error;
}

/**
 * The travelling states' torso sweep (gamepieceClass 1 only): every 0x40
 * ticks (0x20 with throttle) torso_pan steps 5 degrees in aiDirection's way,
 * reversing past 45; behaviourTimer is the due tick.
 *
 * @mw2 ai_torso_scan 0x00024710
 * @fidelity exact
 */
export function aiTorsoScan(mech: MechEntity): void {
  const pc = mech.control!;
  const period = pc.throttle === 0 ? 0x40 : 0x20;
  if (mech.gamepieceClass !== 1) return;
  const now = clock.simTick;
  if (((period + now) | 0) < mech.behaviourTimer) mech.behaviourTimer = (period + now) | 0;
  if (mech.behaviourTimer <= now) {
    pc.torso_pan = (pc.torso_pan + (mech.aiDirection === 0 ? -0x50000 : 0x50000)) | 0;
    if (0x2d0000 < iabs(pc.torso_pan)) mech.aiDirection = mech.aiDirection === 0 ? 1 : 0;
    mech.behaviourTimer = (now + period) | 0;
  }
}

// --- waypoints ----------------------------------------------------------------

/**
 * Removes every temporary waypoint this mech owns (flags bit 0, targetHandle
 * the mech) except the one returnWaypoint names.
 *
 * @mw2 mech_reclaim_waypoints 0x000233b0
 * @fidelity exact
 */
export function mechReclaimWaypoints(mech: MechEntity): void {
  const g = trackedGlobals;
  if (g.trackedObjectCount === -1) return;
  for (let i = 0; i < g.trackedObjectCount; i++) {
    const t = g.trackedObjects[i]!;
    if ((t.flags & 1) === 0 || ((mech.index | 0x200) >>> 0) !== t.targetHandle >>> 0) continue;
    if ((mech.returnWaypoint & 0x1000) !== 0 || (mech.returnWaypoint & 0xff) !== i) trackedObjectRemove(mech.index, i | 0x100);
  }
}

/**
 * Seeds targetHandle with `startHandle`, steps to a usable navpoint (twice if
 * the first is returnWaypoint) and makes it targetPrimary.
 *
 * @mw2 ai_select_navpoint 0x00023590
 * @fidelity exact
 */
export function aiSelectNavpoint(mech: MechEntity, startHandle: number): void {
  mech.targetHandle = i16(startHandle);
  aiCycleNavpoint(mech, 1, 1);
  if (mech.targetHandle >>> 0 === mech.returnWaypoint) aiCycleNavpoint(mech, 1, 1);
  mech.targetPrimary = u16(mech.targetHandle);
}

/**
 * Four waypoints at the objective's engage range on the cardinal directions
 * around targetPrimary (a gamething: 25000), at its height, then targetPrimary
 * becomes the first usable one.
 *
 * @mw2 ai_ring_target_with_navpoints 0x00023420
 * @fidelity exact
 */
export function aiRingTargetWithNavpoints(mech: MechEntity): void {
  let r = objectEngageRange(i16(mech.targetPrimary));
  const idx = mech.targetPrimary & 0xff;
  const type = (mech.targetPrimary >> 8) & 0xf;
  let p: [number, number, number];
  if (type === 1) {
    const t = trackedGlobals.trackedObjects[idx]!;
    p = [t.x, t.y, t.z];
  } else if (type === 2) {
    const m = mechs.mechTable[idx]!;
    p = [m.posX, m.posY, m.posZ];
  } else if (type === 4) {
    p = worldObjectGetPos(things.gameThings[idx]!.geomIndex);
    r = 25000;
  } else return;
  const [x, y, z] = p;
  trackedObjectCreate(mech.index, (x - r) | 0, y, z);
  trackedObjectCreate(mech.index, x, y, (z - r) | 0);
  trackedObjectCreate(mech.index, (x + r) | 0, y, z);
  trackedObjectCreate(mech.index, x, y, (z + r) | 0);
  mech.targetHandle = 0x100;
  aiCycleNavpoint(mech, 1, 1);
  if (mech.targetHandle >>> 0 === mech.returnWaypoint) aiCycleNavpoint(mech, 1, 1);
  mech.targetPrimary = u16(mech.targetHandle);
}

/**
 * Follow: reclaim the old slot waypoint, then a fresh one at the mech's
 * formation slot (star_get_slot_target) becomes targetPrimary. The waypoint's
 * y is the slot's HEADING - star_get_slot_target's heading output is passed
 * where tracked_object_create takes y (0x235f1..0x23612).
 *
 * @mw2 ai_follow_formation_slot 0x000235e0
 * @fidelity exact
 */
export function aiFollowFormationSlot(mech: MechEntity): void {
  mechReclaimWaypoints(mech);
  const slot = starGetSlotTarget(mech.index);
  if (!slot) return;
  const [x, z, heading] = slot;
  quirk('ai_follow_formation_slot: the slot waypoint takes the slot heading as its y', 'ai_follow_formation_slot');
  const i = trackedObjectCreate(mech.index, x, heading, z);
  if (i === -1) return;
  const t = trackedGlobals.trackedObjects[i]!;
  t.flags = (t.flags | 1) & 0xffff;
  t.targetHandle = (mech.index | 0x200) >>> 0;
  mech.targetPrimary = u16(i | 0x100);
}

// --- entering a state -----------------------------------------------------------

/**
 * Clears weapon_fire and runs the exit of the state being left: 2 radios
 * message 10 when its target is destroyed (with aiFlags 0x10); 3 ends the
 * behaviour and zeroes legsPan, torso_tilt and torso_pan, then as 6 radios
 * when the target is identified; 7 radios when it is destroyed, then as 5
 * reclaims waypoints. aiFlags then loses 0x10 - except leaving state 2 with
 * a live target, where the low byte is ORed back as it was.
 *
 * @mw2 ai_run_combat_state 0x00022a90
 * @fidelity exact
 */
export function aiRunCombatState(mech: MechEntity): void {
  const pc = mech.control!;
  pc.weapon_fire = 0;
  let keep = 0;
  const radio = () => {
    if ((mech.aiFlags & 0x10) !== 0) radioLanceMessage(10, mech.starSlot);
  };
  const st = mech.aiState;
  if (st === 2) {
    if (objectTestFlags(mech.targetSecondary, 2, 0) === 0) keep = mech.aiFlags & 0xff;
    else radio();
  } else if (st === 3 || st === 6) {
    if (st === 3) {
      aiExitBehaviour(mech);
      pc.legsPan = 0;
      pc.torso_tilt = 0;
      pc.torso_pan = 0;
    }
    if (objectTestFlags(mech.targetSecondary, 8, 0) !== 0) radio();
  } else if (st === 7 || st === 5) {
    if (st === 7 && objectTestFlags(mech.targetSecondary, 4, 0) !== 0) radio();
    mechReclaimWaypoints(mech);
  }
  mech.aiFlags = ((mech.aiFlags & 0xffef) | keep) & 0xffff;
}

/** aiStateNames' name for a state (the {char *, int} table at 0x95bd0, entry state + 1). @portOnly */
function aiStateName(state: number): string {
  const exe = bootImage();
  if (!exe) return String(state);
  const p = exe.u32(LABEL.aiStateNames + 8 + Math.imul(state, 8));
  return p ? exe.cstrAt(p, 32) : '';
}

/** targetDesignatorNames (0x95cb0, 7 entries) through lookup_name_by_value. @portOnly */
function designatorName(value: number): string {
  const exe = bootImage();
  if (!exe) return '';
  for (let i = 0; i < 7; i++) if (exe.i32(0x95cb0 + i * 8 + 4) === i16(value)) return exe.cstrAt(exe.u32(0x95cb0 + i * 8), 32);
  return '';
}

/** The kind column of the state log line: 'nav' (0x100), 'mech' (0x200) or 'gt'. @portOnly */
function handleKind(h: number): string {
  if (((h >> 8) & 1) !== 0) return 'nav';
  return ((h >> 8) & 2) !== 0 ? 'mech' : 'gt';
}

/**
 * Commits a state: clears flags 0x10 (and loadout status) left by a
 * shutdown; for the player's group, any state but 3 keeps only aiFlags 0-1.
 * Entry actions: 2 reschedules the think within 10 * 0x12 ticks and, when
 * leaving patrol without a return point, drops one where the mech stands; 4
 * aiFlags 1; 5 takes a formation slot; 7 rings the objective with navpoints;
 * 11 aiFlags 1, then as -1 and 10 raises flags 0x10 and loadout status bits
 * 3, then as 0 stops (throttle 0, targetDistance 0). Then aiState = state and
 * the state line is logged.
 *
 * @mw2 ai_apply_state 0x00022bd0
 * @fidelity exact
 */
export function aiApplyState(mech: MechEntity, state: number): void {
  const s = i16(state);
  if ((mech.flags & 0x10) !== 0) {
    mech.flags &= 0xffef;
    mech.loadout!.status = 0;
  }
  if (u16(state) !== 3 && mechs.mechTable[mechs.playerMechIndex]!.groupId === mech.groupId) mech.aiFlags &= 3;
  switch (s) {
    case 2: {
      mech.nextThinkTick = (clock.simTick + Math.imul(randomRange(10), 0x12)) | 0;
      quirk('ai_apply_state: the patrol return point is gated on the leader of group (groupId != playerMechIndex)', 'ai_apply_state');
      if (groupGetLeader(mech.groupId !== mechs.playerMechIndex ? 1 : 0) !== 0 && mech.aiState === 7 && (mech.returnWaypoint & 0x1000) !== 0) {
        const i = trackedObjectCreate(mech.index, mech.posX, mech.posY, mech.posZ);
        if (i !== -1) {
          const t = trackedGlobals.trackedObjects[i]!;
          t.flags = (t.flags | 1) & 0xffff;
          t.targetHandle = (mech.index | 0x200) >>> 0;
          mech.returnWaypoint = u16(i | 0x100);
        }
      }
      break;
    }
    case 4:
      mech.aiFlags = 1;
      break;
    case 5:
      aiFollowFormationSlot(mech);
      break;
    case 7:
      aiRingTargetWithNavpoints(mech);
      break;
    case 0xb:
    case -1:
    case 10:
    case 0:
      if (s === 0xb) mech.aiFlags = 1;
      if (s !== 0) {
        mech.flags = (mech.flags | 0x10) & 0xffff;
        mech.loadout!.status |= 3; // or byte ptr [status], 3
      }
      mech.control!.throttle = 0;
      mech.targetDistance = 0;
      break;
    default:
      break;
  }
  ai.dat000f4ab0 = clock.simTick;
  mech.aiState = s;
  aiLogState(mech);
}

/** ai_apply_state's '%6ld : %2d Mech %2d : state %8s %4s %2d, objective %4s %-12s' line. @portOnly the sprintf half of ai_apply_state */
function aiLogState(mech: MechEntity): void {
  const e = mech.loadout!.entity!;
  const tp = e.targetPrimary;
  const ts = e.targetSecondary;
  let secondaryKind = handleKind(ts);
  let objective: string;
  if (((ts >> 8) & 0x60) === 0) objective = String(ts & 0xff);
  else {
    objective = designatorName(ts);
    // the strlen walk ends on the kind string's NUL: a designator prints no kind
    secondaryKind = '';
  }
  const line =
    `${String(clock.simTick).padStart(6)} : ${String(e.groupId).padStart(2)} Mech ${String(e.index).padStart(2)} : state ` +
    `${aiStateName(e.aiState).padStart(8)} ${handleKind(tp).padStart(4)} ${String(tp & 0xff).padStart(2)}, objective ` +
    `${secondaryKind.padStart(4)} ${objective.padEnd(12)}\n`;
  logWrite(line);
}

/**
 * Moves the mech into `state` if its rule blocks have rules for it (0xffff:
 * never). pushCurrent saves the state being left in stateStack[0] (a one-deep
 * stack); without it pendingCount is cleared. The old state's exit runs, a
 * follow order at agp_myleader makes the leader itself idle instead, the
 * target is resolved (ai_state_target_unclaimed) into both target handles,
 * the state is applied and the rule list rebuilt.
 *
 * @mw2 ai_try_enter_state 0x000232c0
 * @fidelity exact
 */
export function aiTryEnterState(mech: MechEntity, state: number, target: number, pushCurrent: number): void {
  state = u16(state);
  if (state === 0xffff || mechHasRulesForState(mech, state) === 0) return;
  if (pushCurrent === 0) mech.pendingCount = 0;
  else {
    const saved = ((mech.targetSecondary << 16) | (mech.aiState & 0xffff)) >>> 0;
    if (mech.pendingCount === 0) mech.pendingCount = 1;
    mech.stateStack[0] = saved;
  }
  aiRunCombatState(mech);
  let t = u16(target);
  if (state === 5 && t === 0x2201 && groupGetLeader(mech.groupId) === mech.index) {
    state = 0;
    t = 0;
  }
  const resolved = u16(aiStateTargetUnclaimed(mech, i16(t)));
  mech.targetPrimary = resolved;
  mech.targetSecondary = resolved;
  aiApplyState(mech, state);
  aiRulesRebuild(mech);
}

// --- the state handlers (aiStateHandlers, 0x9601c) ----------------------------

/**
 * Idle (0) and shutdown (11): targetDistance 0, nothing else.
 *
 * @mw2 ai_state_hold 0x000224d0
 * @fidelity exact
 */
export const aiStateHold = registerCode('ai_state_hold', 0x224d0, (mech: MechEntity): void => {
  mech.targetDistance = 0;
});

/**
 * Every other live state: aim at the target, cushion falls, then per state -
 * 2 target: trigger released, drive at the engage range and aim; 4 flee:
 * turn about and run at full throttle; 5 follow: sweep the torso, drive, and
 * re-take the formation slot; 6-8 recon / patrol / godirect: sweep and drive;
 * 1, 9, 10: throttle 0x333 for an AI-driven mech.
 *
 * @mw2 ai_state_move 0x00022500
 * @fidelity exact
 */
export const aiStateMove = registerCode('ai_state_move', 0x22500, (mech: MechEntity, target: number): void => {
  mech.targetHandle = i16(target);
  aiValidateCurrentTarget(mech);
  aiJetsCushionFall(mech);
  const range = objectEngageRange(i16(target));
  ai.dat000f4ab0 = clock.simTick;
  const pc = mech.control!;
  const drive = () => {
    if (aiHandleBlocked(mech) === 0) {
      pc.throttle = aiChooseThrottle(mech, range);
      aiSteerHeading(mech);
    }
  };
  switch (mech.aiState) {
    case 2: {
      pc.weapon_fire = 0;
      let e: number;
      if (aiHandleBlocked(mech) === 0) {
        pc.throttle = aiChooseThrottle(mech, range);
        e = aiSteerHeading(mech);
      } else {
        e = (mech.desiredHeading - mech.heading) | 0;
        if (0xb40000 < e) e = (e - 0x1680000) | 0;
        else if (e < -0xb40000) e = (e + 0x1680000) | 0;
      }
      aiPilotUpdate(mech, e);
      return;
    }
    case 4:
      mech.desiredHeading = cmod((mech.desiredHeading + 0xb40000) | 0, 0x1680000);
      if (aiHandleBlocked(mech) === 0) {
        pc.throttle = 0x400;
        aiSteerHeading(mech);
      }
      ai.dat000f4ab0 = (ai.dat000f4ab0 + 0xb6) | 0;
      return;
    case 5:
      aiTorsoScan(mech);
      drive();
      aiFollowFormationSlot(mech);
      ai.dat000f4ab0 = (ai.dat000f4ab0 + 0xb6) | 0;
      return;
    case 6:
    case 7:
    case 8:
      aiTorsoScan(mech);
      drive();
      ai.dat000f4ab0 = (ai.dat000f4ab0 + 0xb6) | 0;
      return;
    default:
      if (mech.controlSource === 2) pc.throttle = 0x333;
      return;
  }
});

/**
 * Attack (3): trigger released, then the behaviour scheduler.
 *
 * @mw2 ai_state_attack 0x00022690
 * @fidelity exact
 */
export const aiStateAttack = registerCode('ai_state_attack', 0x22690, (mech: MechEntity, target: number): void => {
  mech.control!.weapon_fire = 0;
  aiBehaviourTick(mech, i16(target));
});
