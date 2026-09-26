/**
 * The behaviour scheduler an attacking AI mech (aiState 3) runs. Behaviours
 * (aiBehaviourNames): 0 stupid, 1 behind, 2 achick, 3 asrp, 4 ajmpin, 5 adfa,
 * 6 kama, 7 wchick, 8 wbackp, 9 wpeek, 10 avoid, 11 sprint, 12 circle; 0xff
 * none. With none running the next is chosen - a posted pendingBehaviour, a
 * forced avoid or peek, or a random successor of the last from the
 * gamepieceClass's transition table - and entered; otherwise the current one
 * ticks until its timer, its own end test, a blocked mech or a posted
 * request ends it.
 *
 * During a behaviour the enemy sits in targetSecondary and targetPrimary is
 * free to be a movement goal (a waypoint); ai_exit_behaviour puts the enemy
 * back.
 */
import { BehaviourTransition, type MechEntity } from '../../generated/classes.gen.ts';
import { LABEL } from '../../generated/labels.gen.ts';
import { i16, i8, u8 } from '../../core/int/cint.ts';
import { quirk, unestablished } from '../../core/provenance.ts';
import { randomRange } from '../../core/random.ts';
import { transformPoint } from '../../core/math/matrix.ts';
import { clock } from '../../engine/clock.ts';
import { bootImage, imageF64, imageI32 } from '../../engine/image.ts';
import { sceneNodeTransform } from '../../engine/scene/sceneGraph.ts';
import { mechs } from '../mech/mechGlobals.ts';
import { things } from '../things/gameThings.ts';
import { worldObjectGetPos, worldObjectNode } from '../world/worldRecords.ts';
import { ai, type BehaviourSet } from './aiGlobals.ts';
import { aiBearingToTarget, mechCanJump, mechHeadingError } from './aiGeometry.ts';
import { objectNodeUserdata } from './handles.ts';
import {
  aiBehindPickSector,
  aiBlockedEndsBehaviour,
  aiHandleBlocked,
  aiJetsCushionFall,
  aiPilotUpdate,
  aiTargetHiddenAbove,
  aiUpdateJumpjets,
  mechHasLineOfFire,
  mechHasNoUsableWeapon,
} from './pilot.ts';
import { aiChooseThrottle, aiRingTargetWithNavpoints, aiSelectNavpoint, aiSteerHeading, aiTryEnterState, mechReclaimWaypoints } from './states.ts';
import { trackedGlobals, trackedObjectCreate } from './tracked.ts';

/** The transition rows ai_behaviour_init points each set at (MW2Types typeBehaviourTransitions). */
const TRANSITIONS_MECH = 0x963f4;
const TRANSITIONS_IDLE = 0x964de;
const TRANSITIONS_HELICOPTER = 0x964f0;
const TRANSITIONS_TRANSPORT = 0x96502;
const TRANSITIONS_ELEMENTAL = 0x96514;

/** `count` BehaviourTransition rows at `addr`. @portOnly */
function readTransitions(addr: number, count: number): BehaviourTransition[] {
  const exe = bootImage();
  const rows: BehaviourTransition[] = [];
  for (let r = 0; r < count; r++) {
    const t = new BehaviourTransition();
    if (exe) {
      const a = addr + r * 18;
      t.from = exe.i16(a);
      t.choiceCount = exe.i16(a + 2);
      for (let k = 0; k < 7; k++) t.choices[k] = exe.i16(a + 4 + k * 2);
    }
    rows.push(t);
  }
  return rows;
}

function behaviourSet(rowCount: number, nonStartRows: number, rowsAddress: number): BehaviourSet {
  return { rowCount, nonStartRows, rows: readTransitions(rowsAddress, rowCount), rowsAddress };
}

/**
 * Resets a mech's behaviour state - none running, no avoidance, no sector
 * claims - forces aiSkillLevel into 1..4 and derives aiCapabilities bits
 * 0..6 from it (level 1 the most capable), and the first time fills the
 * behaviour sets: class 1 the 13-row mech table (7 rows that cannot start),
 * 5 helicopter (circle), 8 transport (behind), the rest idle (stupid), and
 * the Elemental set.
 *
 * @mw2 ai_behaviour_init 0x0002c5f0
 * @fidelity exact
 */
export function aiBehaviourInit(mech: MechEntity): void {
  mech.aiBehaviour = 0xff;
  mech.prevBehaviour = 0xff;
  mech.pendingBehaviour = 0;
  mech.avoidObstacle = null;
  mech.avoidTurnSign = 0;
  mech.avoidProbeScale = 1;
  mech.avoidNextCheck = 0;
  mech.behindSectorClaims.fill(0);
  if (mech.aiSkillLevel === 0 || 4 < mech.aiSkillLevel) mech.aiSkillLevel = 1;
  const lvl = mech.aiSkillLevel;
  const isMech = mech.gamepieceClass === 1;
  let bits = 0;
  if (lvl < 4) bits |= 1;
  if (lvl < 4) bits |= 2;
  if (lvl < 3) bits |= 4;
  if (isMech && lvl < 6) bits |= 8;
  if (lvl < 5) bits |= 0x10;
  if (isMech && lvl < 2) bits |= 0x20;
  if (lvl < 6) bits |= 0x40;
  // each bit is cleared in the low byte and ORed back in turn; the upper bits are kept
  mech.aiCapabilities = (mech.aiCapabilities & ~0x7f) | bits;
  if (ai.aiBehaviourSetsReady !== 0) return;
  for (let i = 0; i < 8; i++) {
    const cls = i + 1;
    if (cls === 1) {
      ai.aiBehaviourSets[i] = behaviourSet(0xd, 7, TRANSITIONS_MECH);
      ai.aiBehaviourSetElemental = behaviourSet(0xd, 7, TRANSITIONS_ELEMENTAL);
    } else if (cls === 5) ai.aiBehaviourSets[i] = behaviourSet(1, 0, TRANSITIONS_HELICOPTER);
    else if (cls === 8) ai.aiBehaviourSets[i] = behaviourSet(1, 0, TRANSITIONS_TRANSPORT);
    else ai.aiBehaviourSets[i] = behaviourSet(1, 0, TRANSITIONS_IDLE);
  }
  ai.aiBehaviourSetsReady = 1;
}

/** jumpFuel >= 6, working jets and heat below maxHeat - the test several behaviours inline. @portOnly */
function canJumpBelow(mech: MechEntity, maxHeat: number): boolean {
  const l = mech.loadout!;
  return !(l.jumpFuel < 6 || l.jetDeltaY === 0 || maxHeat <= l.heatLevel >> 16);
}

/**
 * The next behaviour. A posted pendingBehaviour wins (-2: flee instead -
 * aiState 4, aiFlags 1 - and none). A mech (class 1) that is blocked and not
 * reversing, committed or avoiding avoids (10); with no mech target it is
 * stupid (0); able to jump (heat under 20%, aiCapabilities 2) at a target
 * hidden above that it could see from the target's height, it peeks (9
 * after stupid, else wbackp or stupid at random). Otherwise a start row at
 * random, or a random successor of prevBehaviour; then after ajmpin with
 * aiBlocked 1 adfa; ajmpin only when it can jump (else draw again) and not
 * past the torso arc (then stupid); asrp needs a 10-degree torso arc (else
 * achick); adfa only when airborne (else stupid).
 *
 * @mw2 ai_choose_behaviour 0x0002c880
 * @fidelity exact
 */
export function aiChooseBehaviour(mech: MechEntity): number {
  const l = mech.loadout!;
  let s = -1;
  const set = l.tons === 1 ? ai.aiBehaviourSetElemental : ai.aiBehaviourSets[mech.gamepieceClass - 1];
  if (!set) {
    unestablished(`ai_choose_behaviour: no behaviour set for gamepieceClass ${mech.gamepieceClass}`, 'ai_choose_behaviour');
    return 0;
  }
  do {
    aiBearingToTarget(mech, mech.targetPrimary);
    if (mech.pendingBehaviour !== 0) {
      if (mech.pendingBehaviour === -2) {
        aiTryEnterState(mech, 4, mech.targetSecondary, 0);
        mech.aiFlags = 1;
      } else s = i16(mech.pendingBehaviour);
      mech.pendingBehaviour = 0;
      break;
    }
    if (mech.gamepieceClass === 1) {
      const e = l.entity!;
      if (l.blockedSteps !== 0 && e.control!.reverseDirection !== 1 && e.behaviourCommitted === 0 && e.aiBehaviour !== 10) return 10;
      if (((mech.targetSecondary >> 8) & 2) === 0) return 0;
      if (canJumpBelow(mech, 0x14) && (mech.aiCapabilities & 2) !== 0 && aiTargetHiddenAbove(mech) !== 0 && mechHasLineOfFire(mech, mech.targetY)) {
        s = mech.prevBehaviour === 0 ? 9 : 0;
        if (s === 0 && randomRange(2) !== 0) return 8;
        break;
      }
    }
    if (mech.prevBehaviour === 0xff) s = set.rows[i16(randomRange(set.rowCount - set.nonStartRows))]!.from;
    else {
      let row = 0;
      for (let r = 0; r < set.rowCount; r++) {
        if (i8(mech.prevBehaviour) === set.rows[r]!.from) {
          row = r;
          break;
        }
      }
      const t = set.rows[row]!;
      s = t.choices[randomRange(t.choiceCount)]!;
    }
    if (mech.prevBehaviour === 4 && mech.aiBlocked === 1) return 5;
    if (s === 4 && !(canJumpBelow(mech, 0x14) && (mech.aiCapabilities & 2) !== 0)) s = -1;
    if (s === 4 && l.torsoPanLimit < mechHeadingError(mech)) s = 0;
    if (s === 3 && l.torsoPanLimit < 0xa0000) s = 2;
    if (s === 5 && mech.onGround !== 0) s = 0;
  } while (s === -1);
  return s;
}

/**
 * Starts aiBehaviour: parks the enemy in targetSecondary, clears the scratch
 * fields, a 50 s default life, then per behaviour: stupid 8..12 s; behind
 * picks a sector, 20 s; asrp a random weave side; ajmpin stops, commits and
 * enables the jets, 5 s; adfa commits and notes the distance; wchick a
 * sidestep waypoint 100 m to one side of itself; wbackp reverses 10..20 s;
 * wpeek stops turning and commits; avoid backs off 8 s (or, still blocked by
 * something that is not a mech after an avoid, forward 4 s); sprint commits,
 * enables the jets and fires the left one (aiDirection was just zeroed), 2 s;
 * circle rings the target, 100 s.
 *
 * @mw2 ai_enter_behaviour 0x0002cbf0
 * @fidelity exact
 */
export function aiEnterBehaviour(mech: MechEntity): void {
  const pc = mech.control!;
  mech.aiBlocked = 0;
  mech.targetSecondary = mech.targetPrimary;
  mech.aiDirection = 0;
  mech.targetDistanceAtDecision = 0;
  mech.aiDeadline = 0;
  mech.behaviourTimer = (clock.simTick + 0x238c) | 0;
  mech.behaviourCommitted = 0;
  const now = clock.simTick;
  switch (mech.aiBehaviour) {
    case 0:
      mech.behaviourTimer = (clock.simTick + Math.imul(randomRange(5) + 8, 0xb6)) | 0;
      return;
    case 1:
      mech.aiBlocked = -1;
      mech.behaviourTimer = (now + 0xe38) | 0;
      return;
    case 3:
      mech.aiDirection = randomRange(2) === 0 ? -1 : 1;
      return;
    case 4:
      pc.throttle = 0;
      pc.legsPan = 0;
      mech.behaviourCommitted = 1;
      pc.jumpjet_enabled = 1;
      mech.behaviourTimer = (clock.simTick + 0x38e) | 0;
      return;
    case 5:
      if (clock.tickDelta !== 0) mech.targetDistanceAtDecision = mech.targetDistance;
      mech.behaviourCommitted = 1;
      return;
    case 7: {
      let dir: number;
      if (mech.targetDistance < 4000) dir = randomRange(2) === 0 ? 0xc : 4;
      else dir = randomRange(2) === 0 ? 0xf : 3;
      aiGotoPointNearTarget(mech, mech.index | 0x200, dir, 10000);
      return;
    }
    case 8:
      mech.behaviourTimer = (clock.simTick + Math.imul(randomRange(0xb) + 10, 0xb6)) | 0;
      pc.reverseDirection = 1;
      return;
    case 9:
      mech.aiDirection = 0;
      pc.legsPan = 0;
      mech.behaviourCommitted = 1;
      return;
    case 10:
      if (mech.loadout!.blockedSteps === 0 || mech.prevBehaviour !== 10 || mech.blockedByMech !== -1) {
        pc.reverseDirection = 1;
        mech.behaviourTimer = (clock.simTick + 0x5b0) | 0;
      } else mech.behaviourTimer = (clock.simTick + 0x2d8) | 0;
      return;
    case 0xb:
      pc.legsPan = 0;
      mech.behaviourCommitted = 1;
      quirk('ai_enter_behaviour: sprint reads aiDirection after zeroing it, so it always fires the left jet', 'ai_enter_behaviour');
      if (mech.aiDirection === 0 || mech.aiDirection === 2) pc.jumpjet_fire_left = 1;
      else pc.jumpjet_fire_forward = 1;
      pc.jumpjet_enabled = 1;
      mech.behaviourTimer = (clock.simTick + 0x16c) | 0;
      return;
    case 0xc:
      mech.behaviourTimer = (clock.simTick + 0x4718) | 0;
      aiRingTargetWithNavpoints(mech);
      return;
    default:
      return;
  }
}

/**
 * Ends aiBehaviour: its cleanup (behind reclaims its waypoints and gives back
 * its sector claim; wchick and circle reclaim; wbackp and avoid stop
 * reversing; adfa and sprint cut their jets), then for all: jets off, the
 * scratch fields cleared, prevBehaviour = aiBehaviour, the enemy back in
 * targetPrimary, no behaviour, and the bearing refreshed on the enemy.
 *
 * @mw2 ai_exit_behaviour 0x0002ced0
 * @fidelity exact
 */
export function aiExitBehaviour(mech: MechEntity): void {
  const pc = mech.control!;
  switch (mech.aiBehaviour) {
    case 1:
      mechReclaimWaypoints(mech);
      if (((mech.targetSecondary >> 8) & 2) !== 0) {
        const c = mechs.mechTable[mech.targetSecondary & 0xff]!.behindSectorClaims;
        const k = (mech.aiDirection / 2) | 0;
        c[k] = u8(c[k]! - 1);
      }
      break;
    case 4:
      pc.jumpjet_enabled = 0;
      break;
    case 5:
      pc.jumpjet_enabled = 0;
      pc.jumpjet_fire_forward = 0;
      pc.jumpjet_fire_backward = 0;
      break;
    case 7:
    case 0xc:
      mechReclaimWaypoints(mech);
      break;
    case 8:
    case 10:
      pc.reverseDirection = 0;
      break;
    case 0xb:
      pc.jumpjet_fire_forward = 0;
      pc.jumpjet_fire_backward = 0;
      pc.jumpjet_fire_left = 0;
      pc.jumpjet_fire_right = 0;
      pc.jumpjet_enabled = 0;
      break;
    case 9:
      pc.jumpjet_enabled = 0;
      break;
    default:
      break;
  }
  pc.jumpjet_enabled = 0;
  mech.aiDeadline = 0;
  mech.aiBlocked = 0;
  mech.prevBehaviour = mech.aiBehaviour;
  mech.behaviourTimer = 0;
  mech.targetPrimary = mech.targetSecondary;
  mech.aiDirection = 0;
  mech.aiBehaviour = 0xff;
  aiBearingToTarget(mech, mech.targetSecondary);
}

/**
 * The point `dist` from a mech or gamething in probeDirections direction
 * `dir`, in the target's own frame (a gamething without a node: world axes,
 * unrotated). The third output is not a height: a mech target gives its
 * HEADING; a nodeless gamething 0; a gamething with a node leaves it unset.
 * Returns [x, z, yOut].
 *
 * @mw2 point_around_target 0x0002d070
 * @fidelity exact
 * @divergence a gamething with a node leaves the caller's y uninitialised in the C; the port gives 0. A handle that is neither a mech nor a gamething transforms by an uninitialised node pointer; the port reports it and answers [0, 0, 0]
 */
export function pointAroundTarget(targetHandle: number, dir: number, dist: number): [number, number, number] {
  const type = targetHandle & 0xf00;
  const idx = targetHandle & 0xff;
  const d = i16(dir);
  const pdx = imageI32(LABEL.probeDirections + d * 8, 0);
  const pdz = imageI32(LABEL.probeDirections + d * 8 + 4, 0);
  const dd = i16(dist);
  let y = 0;
  let node = null;
  if (type === 0x200) {
    y = mechs.mechTable[idx]!.heading;
    node = mechs.mechTable[idx]!.node;
  } else if (type === 0x400) {
    const geom = things.gameThings[idx]!.geomIndex;
    node = worldObjectNode(geom);
    if (!node) {
      const [x, , z] = worldObjectGetPos(geom);
      return [(x + (pdx === 0 ? 0 : (dd / pdx) | 0)) | 0, (z + (pdz === 0 ? 0 : (dd / pdz) | 0)) | 0, 0];
    }
    unestablished('point_around_target: a gamething with a node leaves y uninitialised (0 here)', 'point_around_target');
  }
  if (!node) {
    unestablished(`point_around_target: handle 0x${targetHandle.toString(16)} is neither a mech nor a gamething, and the C uses an uninitialised node`, 'point_around_target');
    return [0, 0, 0];
  }
  const p = [pdx === 0 ? 0 : (dd / pdx) | 0, 0, pdz === 0 ? 0 : (dd / pdz) | 0];
  transformPoint(sceneNodeTransform(node), p);
  return [p[0]!, p[2]!, y];
}

/**
 * A private waypoint at point_around_target(targetHandle, dir, dist) - its y
 * that function's third output - owned by the mech, then the mech is sent to
 * it (ai_select_navpoint from 0x100).
 *
 * @mw2 ai_goto_point_near_target 0x0002d010
 * @fidelity exact
 */
export function aiGotoPointNearTarget(mech: MechEntity, targetHandle: number, dir: number, dist: number): void {
  const [x, z, y] = pointAroundTarget(targetHandle, dir, dist);
  const i = trackedObjectCreate(mech.index, x, y, z);
  if (i === -1) return;
  const t = trackedGlobals.trackedObjects[i]!;
  t.flags = (t.flags | 1) & 0xffff;
  t.targetHandle = (mech.index | 0x200) >>> 0;
  aiSelectNavpoint(mech, 0x100);
}

// --- the behaviours' ticks -------------------------------------------------------

/**
 * 0 'stupid': charge at 150 m standoff (creeping at 0x66 while turning more
 * than 5 degrees), posting avoid inside 4500; aim and hop.
 *
 * @mw2 ai_behaviour_stupid_tick 0x0002d200
 * @fidelity exact
 */
export function aiBehaviourStupidTick(mech: MechEntity, handle: number): void {
  aiBearingToTarget(mech, handle);
  let e: number;
  if (aiHandleBlocked(mech) === 0) {
    mech.control!.throttle = aiChooseThrottle(mech, 15000);
    e = aiSteerHeading(mech);
    if ((0x50000 < e || e < -0x50000) && mech.control!.throttle === 0) mech.control!.throttle = 0x66;
  } else e = mechHeadingError(mech);
  if (mech.targetDistance < 0x1194) mech.pendingBehaviour = 10;
  aiPilotUpdate(mech, e);
  aiUpdateJumpjets(mech);
}

/**
 * 1 'behind''s drive: aim at the enemy; GOING (aiBlocked 0) to the waypoint
 * at a 40 m standoff, switching to FACING when stopped more than 5 degrees
 * off the enemy; FACING turns (at least 0x66 throttle) until within 5
 * degrees, then stops; back to GOING beyond 45 m of the waypoint.
 *
 * @mw2 ai_pursue_target_guarded 0x0002d290
 * @fidelity exact
 */
export function aiPursueTargetGuarded(mech: MechEntity): void {
  const pc = mech.control!;
  aiBearingToTarget(mech, mech.targetSecondary);
  const e = mechHeadingError(mech);
  aiPilotUpdate(mech, e);
  if (mech.aiBlocked === 0) {
    aiBearingToTarget(mech, mech.targetPrimary);
    if (aiHandleBlocked(mech) === 0) {
      aiSteerHeading(mech);
      pc.throttle = aiChooseThrottle(mech, 4000);
    }
    if (pc.throttle === 0 && 0x50000 < ((e ^ (e >> 31)) - (e >> 31) | 0)) mech.aiBlocked = 1;
    aiUpdateJumpjets(mech);
  }
  if (mech.aiBlocked === 1) {
    const f = aiHandleBlocked(mech) === 0 ? aiSteerHeading(mech) : mechHeadingError(mech);
    let turning = false;
    if (0x50000 < f || f < -0x50000) {
      turning = true;
      if (pc.throttle === 0) pc.throttle = 0x66;
    }
    if (turning) aiUpdateJumpjets(mech);
    else pc.throttle = 0;
    aiBearingToTarget(mech, mech.targetPrimary);
    if (0x1194 < mech.targetDistance) mech.aiBlocked = 0;
  }
}

/**
 * 2 'achick' / 3 'asrp': pursue at a 55 m standoff and aim. True (the end)
 * once within 8000 * max(1, closing rate * 65536 / 500000 / 65536): 80 m, or
 * further when closing faster than 7.6 cm a tick.
 *
 * @mw2 ai_pursue_target_timed 0x0002d3b0
 * @fidelity exact
 */
export function aiPursueTargetTimed(mech: MechEntity, handle: number): boolean {
  aiBearingToTarget(mech, handle);
  let e: number;
  if (aiHandleBlocked(mech) === 0) {
    e = aiSteerHeading(mech);
    mech.control!.throttle = aiChooseThrottle(mech, 0x157c);
  } else e = mechHeadingError(mech);
  aiPilotUpdate(mech, e);
  let c = clock.tickDelta;
  if (c !== 0) {
    c = ((mech.targetDistanceAtDecision - mech.targetDistance) / c) | 0;
    mech.targetDistanceAtDecision = mech.targetDistance;
  }
  // (int64)(c << 16) << 16 / 500000, as a double times 2^-16; floored at 1.0; times 8000.0
  const q = Number((BigInt(c << 16) << 16n) / 500000n);
  let f = (q | 0) * imageF64(0x90aa8, 1 / 65536);
  if (f < 1.0) f = 1.0;
  const dist = mech.targetDistance;
  f *= imageF64(0x90ab0, 8000.0);
  aiUpdateJumpjets(mech);
  return dist <= f;
}

/**
 * 6 'kama': drive straight in at the handle (unless blocked by something
 * other than the target, then as the avoidance steers); self-destruct and
 * end once within 2000 slant range.
 *
 * @mw2 ai_check_self_destruct 0x0002d4a0
 * @fidelity exact
 */
export function aiCheckSelfDestruct(mech: MechEntity, handle: number): boolean {
  aiBearingToTarget(mech, handle);
  if (aiHandleBlocked(mech) === 0 || objectNodeUserdata(i16(handle)) === mech.avoidObstacle) {
    aiSteerHeading(mech);
    mech.control!.throttle = aiChooseThrottle(mech, 0);
  }
  const r = mech.targetSlantRange;
  if (r < 0x7d1) mech.control!.self_destruct = 1;
  return r < 0x7d1;
}

/**
 * 7 'wchick': aim and fire at targetSecondary while driving to the sidestep
 * waypoint in targetPrimary at a 30 m standoff; ends within 30 m of it.
 *
 * @mw2 ai_behaviour_wchick_tick 0x0002d550
 * @fidelity exact
 */
export function aiBehaviourWchickTick(mech: MechEntity): boolean {
  aiBearingToTarget(mech, mech.targetSecondary);
  aiPilotUpdate(mech, mechHeadingError(mech));
  aiBearingToTarget(mech, mech.targetPrimary);
  if (aiHandleBlocked(mech) === 0) {
    mech.control!.throttle = aiChooseThrottle(mech, 3000);
    aiSteerHeading(mech);
  }
  aiUpdateJumpjets(mech);
  return mech.targetDistance < 0xbb9;
}

/**
 * 9 'wpeek', a phase machine in aiDirection: 0 - jets on while it can jump
 * (heat under 40%) at a target hidden above, else jets off, phase 1 for a
 * second (and, able to jump under 20% heat, 1 in 4 posts adfa); 1 - jets on
 * until the deadline, then phase 2; 2 - ends on landing.
 *
 * @mw2 ai_behaviour_wpeek_tick 0x0002d5c0
 * @fidelity exact
 */
export function aiBehaviourWpeekTick(mech: MechEntity, handle: number): number {
  aiBearingToTarget(mech, handle);
  aiPilotUpdate(mech, mechHeadingError(mech));
  const phase = mech.aiDirection >>> 0;
  const pc = mech.control!;
  if (phase !== 0) {
    if (phase < 2) {
      const on = clock.simTick <= mech.aiDeadline;
      if (!on) mech.aiDirection = 2;
      pc.jumpjet_enabled = on ? 1 : 0;
      aiSteerHeading(mech);
      return 0;
    }
    return phase === 2 && aiJetsCushionFall(mech) !== 0 ? 1 : 0;
  }
  if (canJumpBelow(mech, 0x28) && aiTargetHiddenAbove(mech) !== 0) {
    pc.jumpjet_enabled = 1;
    return 0;
  }
  pc.jumpjet_enabled = 0;
  mech.aiDirection = 1;
  if (canJumpBelow(mech, 0x14) && randomRange(4) === 0) mech.pendingBehaviour = 5;
  mech.aiDeadline = (clock.simTick + 0xb6) | 0;
  return 0;
}

/**
 * 5 'adfa', death from above: aim; unless phase 2, beyond 1000 the jets burn
 * with forward or back thrust by closing rate (against 9, or 36 beyond 6000)
 * and whether the target is between one and three torso arcs off, ending
 * when the jets give out; within 1000 they cut, advancing the phase if they
 * were on. Answers 1 (end) when on the ground or blocked.
 *
 * @mw2 ai_behaviour_adfa_tick 0x0002d7b0
 * @fidelity exact
 */
export function aiBehaviourAdfaTick(mech: MechEntity, handle: number): number {
  aiBearingToTarget(mech, handle);
  const e = mechHeadingError(mech);
  aiPilotUpdate(mech, e);
  let done = mech.onGround === 0 && mech.loadout!.blockedSteps === 0 ? 0 : 1;
  if (mech.aiDirection === 2) return done;
  const a = (e ^ (e >> 31)) - (e >> 31);
  const lim = mech.loadout!.torsoPanLimit;
  const offArc = lim < a && a < Math.imul(lim, 3) ? 1 : 0;
  const pc = mech.control!;
  if (mech.targetDistance < 0x3e9) {
    if (pc.jumpjet_enabled !== 0) mech.aiDirection = (mech.aiDirection + 1) | 0;
    pc.jumpjet_enabled = 0;
    pc.jumpjet_fire_forward = 0;
    pc.jumpjet_fire_backward = 0;
    return done;
  }
  let closing = 0;
  if (clock.tickDelta !== 0) {
    closing = ((mech.targetDistanceAtDecision - mech.targetDistance) / clock.tickDelta) | 0;
    mech.targetDistanceAtDecision = mech.targetDistance;
  }
  const threshold = mech.targetDistance < 0x1771 ? 9 : 0x24;
  if (threshold < closing) {
    pc.jumpjet_fire_forward = offArc;
    pc.jumpjet_fire_backward = offArc === 0 ? 1 : 0;
  } else {
    pc.jumpjet_fire_forward = offArc === 0 ? 1 : 0;
    pc.jumpjet_fire_backward = offArc;
  }
  pc.jumpjet_enabled = 1;
  if (!canJumpBelow(mech, 0x28)) done = 1;
  return done;
}

/**
 * 10 'avoid''s drive: steer (or, not reversing, as the avoidance steers),
 * aim, full throttle, hop.
 *
 * @mw2 ai_pursue_target 0x0002d940
 * @fidelity exact
 */
export function aiPursueTarget(mech: MechEntity, handle: number): void {
  aiBearingToTarget(mech, handle);
  const e = mech.control!.reverseDirection === 0 && aiHandleBlocked(mech) !== 0 ? mechHeadingError(mech) : aiSteerHeading(mech);
  aiPilotUpdate(mech, e);
  mech.control!.throttle = 0x400;
  aiUpdateJumpjets(mech);
}

/**
 * 12 'circle': fire at targetSecondary while orbiting it on a ring of
 * navpoints, re-ringing every 8 s while more than 150 m out; the next
 * navpoint within 30 m. Never ends by itself.
 *
 * @mw2 ai_behaviour_circle_tick 0x0002d990
 * @fidelity exact
 */
export function aiBehaviourCircleTick(mech: MechEntity): number {
  aiBearingToTarget(mech, mech.targetSecondary);
  if (mech.aiDeadline < clock.simTick) {
    if (15000 < mech.targetDistance) {
      mechReclaimWaypoints(mech);
      aiRingTargetWithNavpoints(mech);
    }
    mech.aiDeadline = (clock.simTick + 0x5b0) | 0;
  }
  aiPilotUpdate(mech, mechHeadingError(mech));
  aiBearingToTarget(mech, mech.targetPrimary);
  if (aiHandleBlocked(mech) === 0) {
    mech.control!.throttle = aiChooseThrottle(mech, 3000);
    aiSteerHeading(mech);
  }
  aiUpdateJumpjets(mech);
  if (mech.targetDistance < 0xbb9) aiSelectNavpoint(mech, mech.targetPrimary);
  return 0;
}

/**
 * The scheduler (attack's handler, `handle` the attack target): choose and
 * enter a behaviour when none runs; otherwise tick it (see each behaviour),
 * then the out-of-weapons rule - a disarmed mech that can move and is not
 * committed, in kama or fleeing posts flee or kama (kama needs aiCapabilities
 * 0x20) on 1 in 4, after adfa or when it cannot jump; ajmpin otherwise - and
 * end the behaviour when blocked (mechs), timed out, or a request is posted.
 *
 * @mw2 ai_behaviour_tick 0x0002c210
 * @fidelity exact
 */
export function aiBehaviourTick(mech: MechEntity, handle: number): void {
  const l = mech.loadout!;
  let end = false;
  if (mech.aiBehaviour === 0xff) {
    const b = u8(aiChooseBehaviour(mech));
    mech.aiBehaviour = b;
    if (b === 0xff) return;
    aiEnterBehaviour(mech);
    return;
  }
  const h = i16(handle);
  const now = () => clock.simTick;
  switch (mech.aiBehaviour) {
    case 0:
      aiJetsCushionFall(mech);
      aiBehaviourStupidTick(mech, h);
      break;
    case 1: {
      if (mech.aiDeadline <= now()) {
        mechReclaimWaypoints(mech);
        const t = mechs.mechTable[mech.targetSecondary & 0xff]!;
        if (mech.aiDirection !== 0) {
          const k = (mech.aiDirection / 2) | 0;
          t.behindSectorClaims[k] = u8(t.behindSectorClaims[k]! - 1);
        }
        mech.aiDeadline = (now() + 0x222) | 0;
        if (mech.aiBlocked === -1) {
          const dir = aiBehindPickSector(mech);
          mech.aiBlocked = 0;
          mech.aiDirection = i16(dir);
        }
        aiGotoPointNearTarget(mech, mech.targetSecondary, i16(mech.aiDirection), 15000);
        const k = (mech.aiDirection / 2) | 0;
        t.behindSectorClaims[k] = u8(t.behindSectorClaims[k]! + 1);
      }
      aiJetsCushionFall(mech);
      aiPursueTargetGuarded(mech);
      break;
    }
    case 2:
      aiJetsCushionFall(mech);
      end = aiPursueTargetTimed(mech, h);
      break;
    case 3:
      aiJetsCushionFall(mech);
      end = aiPursueTargetTimed(mech, h);
      if (aiHandleBlocked(mech) === 0) mech.control!.legsPan = (mech.control!.legsPan + Math.imul(mech.aiDirection, 0x1c20000)) | 0;
      if (mech.aiDeadline <= now()) {
        mech.aiDeadline = (now() + 0x222) | 0;
        mech.aiDirection = -mech.aiDirection | 0;
      }
      break;
    case 4:
      aiBearingToTarget(mech, h);
      aiPilotUpdate(mech, mechHeadingError(mech));
      end = !(mech.posY < ((mech.targetY + 2000) | 0));
      break;
    case 5:
      if (aiBehaviourAdfaTick(mech, h) === 0 && 0 < l.jumpFuel) break;
      end = true;
      break;
    case 6:
      end = aiCheckSelfDestruct(mech, h);
      break;
    case 7:
      aiJetsCushionFall(mech);
      end = aiBehaviourWchickTick(mech);
      break;
    case 8: {
      aiJetsCushionFall(mech);
      aiBearingToTarget(mech, h);
      aiPilotUpdate(mech, aiSteerHeading(mech));
      // EDX holds loadout->blockedSteps across ai_update_jumpjets, which preserves it (0x2c480..0x2c49c)
      const blocked = l.blockedSteps;
      mech.control!.throttle = 0x400;
      aiUpdateJumpjets(mech);
      end = blocked !== 0;
      break;
    }
    case 9:
      end = aiBehaviourWpeekTick(mech, h) !== 0;
      break;
    case 10:
      aiPursueTarget(mech, h);
      break;
    case 0xb:
      aiBearingToTarget(mech, h);
      aiPilotUpdate(mech, mechHeadingError(mech));
      break;
    case 0xc:
      aiJetsCushionFall(mech);
      end = aiBehaviourCircleTick(mech) !== 0;
      break;
    default:
      break;
  }
  if (l.speed !== 0 && mechHasNoUsableWeapon(l) !== 0 && mech.behaviourCommitted === 0 && mech.aiBehaviour !== 6 && mech.aiState !== 4) {
    if (randomRange(4) === 0 || mech.prevBehaviour === 5 || mechCanJump(mech, 0x28) === 0) {
      mech.pendingBehaviour = randomRange(2) === 0 ? -2 : 6;
      if ((mech.aiCapabilities & 0x20) === 0) mech.pendingBehaviour = -2;
    } else {
      mech.pendingBehaviour = 4;
      mech.aiBlocked = 1;
    }
  }
  if (mech.gamepieceClass === 1 && aiBlockedEndsBehaviour(l) !== 0) end = true;
  if (mech.behaviourTimer !== 0 && mech.behaviourTimer <= clock.simTick) end = true;
  if (mech.pendingBehaviour !== 0) end = true;
  if (end) aiExitBehaviour(mech);
}
