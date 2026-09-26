/**
 * How a group's AI is tasked: its current objective re-tasks every member
 * (group_apply_objective); each pass its leader answers requests and, for a
 * non-player group, sends one more member at the objective's next uncovered
 * target (group_assign_objective_task); a member's team-target rule asks
 * the leader to dispatch a responder; and the player's lance orders.
 */
import type { MechEntity } from '../../generated/classes.gen.ts';
import { i16, u16 } from '../../core/int/cint.ts';
import { quirk, unestablished } from '../../core/provenance.ts';
import { objectiveRecordAddress, objectiveRestraint, objectiveTargetHandle, objectives } from '../../mission/objectives.ts';
import { missionTables } from '../../mission/tables/missionTables.ts';
import { ai } from '../ai/aiGlobals.ts';
import { objectTestFlags, resolveTargetDesignator } from '../ai/handles.ts';
import { mechHasNoUsableWeapon } from '../ai/pilot.ts';
import { aiSetStateRuleBlock, mechHasRulesForState } from '../ai/rules.ts';
import { aiTryEnterState } from '../ai/states.ts';
import { trackedObjectRemove } from '../ai/tracked.ts';
import { nukeDetonate } from '../effects/effects.ts';
import { mechs } from '../mech/mechGlobals.ts';
import { radioLanceMessage } from '../sound/sound.ts';
import { groupCollectMembers, groupElectLeader, groupGetLeader, starAssignSlots } from './groups.ts';

/** aiFlags from Objective.restraint: 1 -> 0x42, 2 -> 0x41, else 0x40. @portOnly the mapping both taskers inline */
function restraintFlags(restraint: number): number {
  if (restraint === 1) return 0x42;
  return restraint === 2 ? 0x41 : 0x40;
}

/** The lowest set bit of an objective type's low word, 16 when none. @portOnly */
function lowestBit(type: number): number {
  let b = 0;
  while (b < 0x10 && (type & 0xffff & (1 << b)) === 0) b++;
  return b;
}

/** stateStack[pendingCount] = entry - one past a one-deep stack, which nothing reads (a pendingCount of 2 would reach gpsParams). @portOnly */
function stateStackPoke(m: MechEntity, entry: number): void {
  if (m.pendingCount >= m.stateStack.length) {
    unestablished(`stateStack[${m.pendingCount}] lies past the two-entry stack`, 'group_apply_objective');
    return;
  }
  m.stateStack[m.pendingCount] = entry >>> 0;
}

/**
 * Re-tasks a group from its current objective (none: type 0x200). Type 0x400
 * sends every AI member to rest (10), 0x800 or 0x10 to shutdown (11), any
 * other to follow (5) the leader, the leader itself idling. Each AI member
 * also gets the objective's rule block in slot 2 (by the type's lowest bit)
 * and aiFlags 0-1 from Objective.restraint (+ 0x40). A member with a saved
 * state has the order written past its stack instead, so it resumes the
 * saved state. Once the player's group has had an objective other than
 * 0x10, its members' states are left alone (0x96018).
 *
 * @mw2 group_apply_objective 0x00023aa0
 * @fidelity exact
 */
export function groupApplyObjective(group: number): void {
  let leader = groupGetLeader(group);
  let target = 0;
  if (i16(leader) === -1) {
    leader = groupElectLeader(group);
    if (i16(leader) === -1) return;
  }
  const members: MechEntity[] = [];
  const n = groupCollectMembers(group, members, 1);
  if (n === 0) return;
  const cur = objectives.groupCurrentObjective[group]!;
  const type = cur === -1 ? 0x200 : objectives.objectiveTables[group]!.objectives[cur]!.type & 0xffff;
  let state: number;
  if (type === 0x400) state = 10;
  else if (type === 0x800 || type === 0x10) state = 0xb;
  else {
    target = (leader | 0x200) & 0xffff;
    state = 5;
  }
  const flags = restraintFlags(objectiveRestraint(group, cur));
  const bit = lowestBit(type);
  for (let k = 0; k < n; k++) {
    const m = members[k]!;
    if (m.controlSource !== 2) continue;
    aiSetStateRuleBlock(m, 2, bit + 1, i16(leader));
    if (i16(leader) === mechs.playerMechIndex && ai.dat00096018 !== 0) continue;
    if (i16(leader) === m.index && state === 5) {
      if (m.pendingCount === 0) aiTryEnterState(m, 0, 0, 0);
      else stateStackPoke(m, 0);
    } else if (m.pendingCount !== 0) stateStackPoke(m, (target << 16) | state);
    else aiTryEnterState(m, state, target, 0);
    m.aiFlags = ((m.aiFlags & 0xfffc) | flags) & 0xffff;
    if (m.returnWaypoint === 0) {
      trackedObjectRemove(m.index, 0);
      m.returnWaypoint = 0x1000;
    }
  }
  if (groupGetLeader(group) === mechs.playerMechIndex && type !== 0x10) ai.dat00096018 = 1;
}

/**
 * mission_results_update's hook when a group's current objective changes.
 *
 * @mw2 group_objective_changed 0x00023a90
 * @fidelity exact
 */
export function groupObjectiveChanged(group: number): void {
  groupApplyObjective(group);
}

/**
 * Sends a group member after `target` (state 2, pushing its current state):
 * none for a designator (0xf000 bits) or a leaderless group. Under objective
 * INDEX 4 every member not already on a target, armed and engaging goes.
 * Otherwise one: the non-leader free of aiFlags 0-1, not in state 2 or 3,
 * armed and engaging, whose loadoutRating is closest to a mech target's (or
 * smallest); failing that the leader under the same conditions. The one
 * sent gets aiFlags 0x20 in place of 0x40. Returns 1 when someone went.
 *
 * @mw2 group_dispatch_responder 0x00023ff0
 * @fidelity exact
 */
export function groupDispatchResponder(group: number, target: number): number {
  if ((target & 0xf000) !== 0) return 0;
  const leader = groupGetLeader(group);
  if (leader === -1) return 0;
  const members: MechEntity[] = [];
  const n = groupCollectMembers(group, members, 1);
  if (n === 0) return 0;
  const rating = ((target >> 8) & 0xf) === 2 ? mechs.mechTable[target & 0xff]!.loadoutRating : 0;
  const cur = objectives.groupCurrentObjective[group]!;
  const available = (m: MechEntity) => m.aiState !== 2 && m.aiState !== 3 && mechHasNoUsableWeapon(m.loadout!) === 0 && m.engageEnabled !== 0;
  if (cur === 4) {
    let sent = 0;
    // Objective.membersPerTarget is tested on every pass but never counted down
    let quota = objectives.objectiveTables[group]!.objectives[cur]!.membersPerTarget;
    if (quota === 0) quota = n;
    for (let k = 0; k < n && quota !== 0; k++) {
      const m = members[k]!;
      if (available(m)) {
        aiTryEnterState(m, 2, u16(target), 1);
        sent = 1;
      }
    }
    return sent;
  }
  let best = -1;
  let bestDiff = 0x7fff;
  for (let k = 0; k < n; k++) {
    const m = members[k]!;
    if (leader === m.index || (m.aiFlags & 3) !== 0 || !available(m)) continue;
    const d = (m.loadoutRating - rating) | 0;
    const diff = (d ^ (d >> 31)) - (d >> 31);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = m.index;
    }
  }
  let chosen: MechEntity | null;
  if (best === -1) {
    chosen = mechs.mechTable[leader]!;
    if ((chosen.aiFlags & 3) !== 0 || !available(chosen)) chosen = null;
  } else chosen = mechs.mechTable[best]!;
  if (!chosen) return 0;
  aiTryEnterState(chosen, 2, u16(target), 1);
  chosen.aiFlags = (chosen.aiFlags & 0xffbf) | 0x20;
  return 1;
}

/**
 * A request to a group: none or code 0 re-applies its objective, code 7
 * dispatches a responder at the request's argument.
 *
 * @mw2 group_handle_request 0x00023fc0
 * @fidelity exact
 */
export function groupHandleRequest(group: number, request: number[] | null): void {
  if (request === null || request[0] === 0) groupApplyObjective(group);
  else if (request[0] === 7) groupDispatchResponder(group, u16(request[1]!));
}

/**
 * Mission start: per group, number the star and apply its objective.
 *
 * @mw2 groups_start_mission 0x000218d0
 * @fidelity partial
 * @divergence no monochrome debug display to clear (monoDebugPresent / project_file_sub_04afff)
 */
export function groupsStartMission(): void {
  const n = missionTables.missionTableCount;
  for (let g = 0; g < n; g++) {
    starAssignSlots(g);
    groupHandleRequest(g, null);
  }
}

/**
 * mech_has_no_usable_weapon as group_assign_objective_task calls it for a
 * following member: with the MechEntity where the MechLoadout belongs
 * (0x244ac: EAX is the member, never its +0x20). The entity's +0xa8 -
 * aimRangeSeek.lastTick, a tick - stands for numWeapons and its +0x54 - posY
 * - for the weapons pointer. With no 'weapons' the answer is exact; with
 * some, the original reads the memory at address posY, which the port
 * cannot see, and it answers 0 (a usable weapon) here.
 *
 * @portOnly the misdirected call inside group_assign_objective_task
 */
function noUsableWeaponOnEntity(m: MechEntity): number {
  quirk('group_assign_objective_task passes the MechEntity to mech_has_no_usable_weapon', 'group_assign_objective_task');
  const count = m.aimRangeSeek.lastTick;
  if (count <= 0) return count === 0 ? 0 : 1;
  unestablished('group_assign_objective_task: mech_has_no_usable_weapon reads memory at the entity\'s posY; taken as a usable weapon', 'group_assign_objective_task');
  return 0;
}

/**
 * The group step its leader runs each pass. First the leader's request
 * (7: dispatch a responder at leaderRequestArg), cleared. Then, not for the
 * player's group: the current objective (a non-zero type without 0xe10)
 * picks its first target that is still to be done (object_test_flags by the
 * type) and not yet covered by membersPerTarget members (every member when
 * 0) already on it in the state the type calls for; the first non-leader
 * member that is idle, or following and armed (the leader when idle and
 * armed) gets the objective's rule block and is sent there - destroy (1, 2)
 * and identify (8) target (2), protect (4) patrol (7), 0x20 / 0x100 / 0x200
 * / 0x400 godirect (8), avoid (0x2000) flee (4), immediate (0x1000) sets
 * off a nuke on it and idles - or has the order written past its saved
 * state; aiFlags gain the restraint bits.
 *
 * object_test_flags gets the objective record's address in ECX (0x2435b);
 * for the types it has no code for (0x20, 0x2000) it tests the flags against
 * that address's low word, as here.
 *
 * @mw2 group_assign_objective_task 0x00024250
 * @fidelity exact
 */
export function groupAssignObjectiveTask(group: number): void {
  const leader = groupGetLeader(group);
  if (leader === -1) return;
  const L = mechs.mechTable[leader]!;
  if (L.leaderRequest !== 0) {
    if (i16(L.leaderRequest) === 7) groupDispatchResponder(group, L.leaderRequestArg);
    L.leaderRequest = 0;
  }
  if (leader === mechs.playerMechIndex) return;
  const cur = objectives.groupCurrentObjective[group]!;
  if (cur === -1) return;
  const o = objectives.objectiveTables[group]!.objectives[cur]!;
  const mask = o.type >>> 0;
  if (mask === 0 || (mask & 0xe10) !== 0) return;
  const members: MechEntity[] = [];
  const n = groupCollectMembers(group, members, 0);
  if (n === 0) return;
  const ecx = objectiveRecordAddress(group, cur) & 0xffff;
  let found = 0;
  for (let i = 0; i < (o.targetCount & 0xff) && found === 0; i++) {
    let need = o.membersPerTarget === 0 ? n : o.membersPerTarget;
    found = objectiveTargetHandle(group, cur, i);
    if (objectTestFlags(found, mask, ecx) !== 0) {
      found = 0;
      continue;
    }
    for (let k = 0; k < n && need !== 0; k++) {
      const m = members[k]!;
      if (i16(m.targetSecondary) !== found) continue;
      if (onObjective(mask, m.aiState)) need--;
    }
    if (need === 0) found = 0;
  }
  if (found === 0) return;
  let pick: MechEntity | null = null;
  for (let k = 0; k < n; k++) {
    const m = members[k]!;
    const s = m.aiState;
    if ((s === 0 || (s === 5 && noUsableWeaponOnEntity(m) === 0)) && m !== L) {
      pick = m;
      break;
    }
  }
  if (!pick) {
    if (L.aiState !== 0 || mechHasNoUsableWeapon(L.loadout!) !== 0) return;
    pick = L;
  }
  for (let b = 0; b < 0x10; b++) {
    if ((mask & (1 << b)) !== 0) {
      aiSetStateRuleBlock(pick, 2, b + 1, i16(groupGetLeader(group)));
      break;
    }
  }
  const flags = restraintFlags(o.restraint);
  let state = 0xffff;
  if (mask === 1 || mask === 2 || mask === 8) state = 2;
  else if (mask === 4) state = 7;
  else if (mask === 0x20 || mask === 0x100 || mask === 0x200 || mask === 0x400) state = 8;
  else if (mask === 0x1000) {
    nukeDetonate(pick);
    state = 0;
  } else if (mask === 0x2000) state = 4;
  if (state === 0xffff) return;
  if (pick.pendingCount === 0) aiTryEnterState(pick, state, found, 0);
  else stateStackPoke(pick, (found << 16) | state);
  pick.aiFlags = (pick.aiFlags | flags) & 0xffff;
}

/** Whether a member in `state` counts as working an objective of type `mask`. @portOnly the switch at 0x2438a..0x2443d */
function onObjective(mask: number, state: number): boolean {
  switch (mask) {
    case 1:
    case 2:
      return state === 2 || state === 3;
    case 4:
      return state === 7;
    case 8:
      return state === 2;
    case 0x20:
    case 0x100:
    case 0x200:
    case 0x400:
      return state === 8;
    case 0x1000:
      return true;
    case 0x2000:
      return state === 4;
    default:
      return false;
  }
}

// --- the player's lance --------------------------------------------------------

/**
 * The mech in the player's group holding star slot `slot`, or -1.
 *
 * @mw2 lance_mech_for_slot 0x00023760
 * @fidelity exact
 */
export function lanceMechForSlot(slot: number): number {
  const g = mechs.mechTable[mechs.playerMechIndex]!.groupId;
  for (let i = 0; i < mechs.mechCount; i++) if (g === mechs.mechTable[i]!.groupId && slot === mechs.mechTable[i]!.starSlot) return i;
  return -1;
}

/**
 * Puts each mech of the handle set `recipients` into the ordered state:
 * skipping the target itself and the player, counting the dead and those
 * without rules for it; order 3 toggles engageEnabled and clears aiFlags
 * 0-1; any other clears aiFlags, enters the state at the target (pushing
 * the current one, except for patrol), then aiFlags 0x11 (order 2) or 0x12
 * (follow also turning engaging off). Returns the count skipped.
 *
 * @mw2 lance_order_apply 0x000237d0
 * @fidelity exact
 */
export function lanceOrderApply(from: MechEntity, recipients: number, order: number, target: number): number {
  let h = -1;
  let skipped = 0;
  order = u16(order);
  target = u16(target);
  for (;;) {
    do {
      h = resolveTargetDesignator(from, i16(recipients), h & 0xffff);
      if (u16(h) === 0xffff) return skipped;
    } while ((h & 0x200) === 0);
    if (u16(h) === target) {
      skipped++;
      continue;
    }
    const m = mechs.mechTable[i16(h & 0xff)]!;
    if (mechs.playerMechIndex === m.index) continue;
    if (m.aiState === 0xc || mechHasRulesForState(m, order) === 0) skipped++;
    else if (order === 3) {
      m.engageEnabled = m.engageEnabled === 0 ? 1 : 0;
      m.aiFlags &= 0xfffc;
    } else {
      m.aiFlags = 0;
      aiTryEnterState(m, order, target, order !== 7 ? 1 : 0);
      if (order === 2) m.aiFlags |= 0x11;
      else {
        if (order === 5) m.engageEnabled = 0;
        m.aiFlags |= 0x12;
      }
    }
  }
}

/**
 * One order to one lance slot: 2 target and 7 patrol at the player's target
 * (target refuses a navpoint), 5 follow agp_myleader, 8 godirect agp_home,
 * 3 attack and 11 shutdown with no target; any other order, an empty slot,
 * or no target, is refused. The player's own slot orders the whole star
 * (agp_friendly); then the acknowledgement is radioed. Returns 1 when
 * issued.
 *
 * @mw2 lance_order_issue 0x00023920
 * @fidelity exact
 */
export function lanceOrderIssue(slot: number, order: number): number {
  const p = mechs.mechTable[mechs.playerMechIndex]!;
  const who = lanceMechForSlot(slot);
  if (who === -1) return 0;
  let target = 0x1000;
  let ack = -1;
  switch (u16(order)) {
    case 2:
      if (p.targetHandle !== 0) target = u16(p.targetHandle);
      if ((target & 0x100) !== 0) target = 0xffff;
      ack = 1;
      break;
    case 5:
      target = 0x2201;
      ack = 2;
      break;
    case 7:
      if (p.targetHandle !== 0) target = u16(p.targetHandle);
      ack = 3;
      break;
    case 8:
      target = 0x2100;
      ack = 4;
      break;
    case 0xb:
      ack = 9;
      target = 0;
      break;
    case 3:
      ack = -1;
      target = 0;
      break;
    default:
      break;
  }
  if ((target & 0x1000) !== 0) return 0;
  const recipients = who === mechs.playerMechIndex ? 0x4200 : (slot | 0x200) & 0xffff;
  lanceOrderApply(p, recipients, u16(order), target);
  if (ack !== -1) radioLanceMessage(ack, slot);
  return 1;
}

/**
 * How many members the player's group has.
 *
 * @mw2 ai_combat_sub_0246b0 0x000246b0
 * @fidelity exact
 */
export function aiCombatSub0246b0(): number {
  return mechs.groupTable[mechs.mechTable[mechs.playerMechIndex]!.groupId]!.memberCount;
}
