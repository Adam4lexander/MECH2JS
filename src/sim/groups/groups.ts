/**
 * Groups (stars / lances): leaders, star slots and membership, and the
 * mission-start pass that numbers every star. groupTable and formationTable
 * live in sim/mech/mechGlobals.ts.
 *
 * Importing this module also installs the owner-affiliation lookup that
 * poly_resolve_code uses while a mech's or gamething's mesh is built.
 */
import type { MechEntity } from '../../generated/classes.gen.ts';
import type { StarFormation } from '../../generated/classes.gen.ts';
import { divergence, unestablished } from '../../core/provenance.ts';
import { transformPoint } from '../../core/math/matrix.ts';
import { sceneNodeSetEuler, sceneNodeSetOrigin, sceneNodeTransform, sceneNodeWalk } from '../../engine/scene/sceneGraph.ts';
import { setPolyOwnerAffiliation } from '../../engine/scene/wtboLoader.ts';
import { missionTables } from '../../mission/tables/missionTables.ts';
import { mechs, GROUP_COUNT } from '../mech/mechGlobals.ts';
import { things } from '../things/gameThings.ts';
import { formations, starFormationCopy } from './formations.ts';

/**
 * Every group: no leader recorded (0), formation 0, and formationTable
 * reset to a copy of formationPresets[0].
 *
 * @mw2 group_reset 0x0002ade0
 * @fidelity exact
 */
export function groupReset(): void {
  const m = mechs;
  for (let i = 0; i < GROUP_COUNT; i++) {
    m.groupTable[i]!.leaderMechIndex = 0;
    m.groupTable[i]!.formation = 0;
    starFormationCopy(formations.formationPresets[0]!, m.formationTable[i]!);
  }
}

/**
 * The group's leader, or 0 (not -1) for an index of 16 or more.
 *
 * @mw2 group_get_leader 0x0002b180
 * @fidelity exact
 */
export function groupGetLeader(group: number): number {
  return group < GROUP_COUNT ? mechs.groupTable[group]!.leaderMechIndex : 0;
}

/**
 * The flat int view formationTable[g].slotX / slotZ / slotHeading form in C,
 * so an index past a five-slot array reads the next one as the original does.
 */
function formationInt(f: StarFormation, i: number): number {
  if (i >= 0 && i < 5) return f.slotX[i]!;
  if (i >= 5 && i < 10) return f.slotZ[i - 5]!;
  if (i >= 10 && i < 15) return f.slotHeading[i - 10]!;
  unestablished(`formation slot ${i}: outside the StarFormation record`, 'group_set_leader');
  return 0;
}

/**
 * Makes `mech` the group's leader (or -1: none) and re-bases the group's
 * formation on the leader's star slot: every slot's x and z has the
 * leader's slot offset subtracted. Returns 1 when a leader was stored.
 *
 * @mw2 group_set_leader 0x0002af50
 * @fidelity exact
 */
export function groupSetLeader(group: number, mech: number): number {
  const m = mechs;
  if (mech === -1) {
    m.groupTable[group]!.leaderMechIndex = -1;
    return 0;
  }
  if (mech < m.mechCount && group < GROUP_COUNT) {
    m.groupTable[group]!.leaderMechIndex = mech;
    const f = m.formationTable[group]!;
    const slot = m.mechTable[mech]!.starSlot;
    const dx = formationInt(f, slot);
    const dz = formationInt(f, slot + 5);
    for (let k = 0; k < 5; k++) {
      f.slotX[k] = (f.slotX[k]! - dx) | 0;
      f.slotZ[k] = (f.slotZ[k]! - dz) | 0;
    }
    return 1;
  }
  return 0;
}

/**
 * mechTable[mech].starSlot = slot, when mech < mechCount and slot < 5
 * (unsigned compares). Returns 1 if it did.
 *
 * @mw2 mech_set_star_slot 0x0002af20
 * @fidelity exact
 */
export function mechSetStarSlot(mech: number, slot: number): number {
  if (mech >>> 0 < mechs.mechCount >>> 0 && slot >>> 0 < 5) {
    mechs.mechTable[mech]!.starSlot = slot;
    return 1;
  }
  return 0;
}

/**
 * 0 friendly, 1 enemy, 2 neutral - the mech's group's allegiance.
 *
 * @mw2 mech_allegiance 0x0002b240
 * @fidelity exact
 */
export function mechAllegiance(mechIndex: number): number {
  return mechs.groupTable[mechs.mechTable[mechIndex]!.groupId]!.allegiance & 0xff;
}

/**
 * The group's members whose flags miss 6 (loose) or 0x16, into out; returns
 * how many.
 *
 * @mw2 group_collect_members 0x00023f50
 * @fidelity exact
 */
export function groupCollectMembers(group: number, out: MechEntity[], loose: number): number {
  const mask = loose === 0 ? 0x16 : 6;
  const g = mechs.groupTable[group]!;
  let n = 0;
  for (let k = 0; k < g.memberCount; k++) {
    const e = mechs.mechTable[memberAt(group, k)]!;
    if ((mask & e.flags) === 0) out[n++] = e;
  }
  return n;
}

/**
 * MechGroup.members is five ints at +0x12, groups 0x26 apart; the C indexes
 * `groupIndex * 0x26 + 0xfb576 + k * 4` unchecked, so k past 4 would read the
 * next group's leaderMechIndex, memberCount and so on.
 */
function memberAt(group: number, k: number): number {
  if (k < 5) return mechs.groupTable[group]!.members[k]!;
  unestablished(`group ${group} member ${k}: past the five-member star`, 'MechGroup.members');
  return 0;
}

/**
 * Picks a new leader: the first usable member (loose collect, flags & 6
 * clear) that is not the current leader, stored with group_set_leader - or
 * -1 when there is none but members exist. Returns it.
 *
 * @mw2 group_elect_leader 0x00021c70
 * @fidelity exact
 */
export function groupElectLeader(group: number): number {
  const current = groupGetLeader(group);
  let leader = -1;
  const found: MechEntity[] = [];
  const n = groupCollectMembers(group, found, 1);
  if (n !== 0) {
    for (let i = 0; i < n; i++) {
      const e = found[i]!;
      if (e.index !== current && (e.flags & 6) === 0) {
        leader = e.index;
        break;
      }
    }
    groupSetLeader(group, leader);
  }
  return leader;
}

/**
 * Numbers a star: elects a leader if it has none, then gives the leader
 * slot 0 and every other live mech-class member 1, 2, 3... in table order.
 * Returns 0 when no leader can be had.
 *
 * @mw2 star_assign_slots 0x0002b1a0
 * @fidelity exact
 */
export function starAssignSlots(group: number): number {
  let leader = group < GROUP_COUNT ? (mechs.groupTable[group]!.leaderMechIndex << 16) >> 16 : 0;
  if (leader === -1) {
    leader = (groupElectLeader(group) << 16) >> 16;
    if (leader === -1) return 0;
  }
  let next = 1;
  const g = mechs.groupTable[group]!;
  for (let k = 0; ((k << 16) >> 16) < g.memberCount; k++) {
    const e = mechs.mechTable[memberAt(group, k)]!;
    if (e.gamepieceClass === 1 && (e.flags & 6) === 0) {
      if (e.index === leader) e.starSlot = 0;
      else e.starSlot = next++;
    }
  }
  return 1;
}

/**
 * Where a mech should stand: its own position and heading if it leads its
 * star, otherwise its star slot's formation offset (slotX, 0, slotZ) put
 * through the leader node's world transform, with the slot's heading as it
 * is - not rotated by the leader's. transform_point's y result lands in a
 * discarded local. Returns [x, z, heading], or null when mechIndex is out of
 * range (the original returns 0 and writes nothing).
 *
 * @mw2 star_get_slot_target 0x0002b0b0
 * @fidelity exact
 */
export function starGetSlotTarget(mechIndex: number): [number, number, number] | null {
  const m = mechs;
  if (mechIndex >>> 0 >= m.mechCount >>> 0) return null;
  const groupId = m.mechTable[mechIndex]!.groupId;
  const leaderIndex = groupId < GROUP_COUNT ? m.groupTable[groupId]!.leaderMechIndex : 0;
  const slot = m.mechTable[mechIndex]!.starSlot;
  if (mechIndex === leaderIndex) {
    const l = m.mechTable[leaderIndex]!;
    return [l.posX, l.posZ, l.heading];
  }
  const f = m.formationTable[groupId]!;
  const p = [formationInt(f, slot), 0, formationInt(f, slot + 5)];
  const heading = formationInt(f, slot + 10);
  transformPoint(sceneNodeTransform(m.mechTable[leaderIndex]!.node!), p);
  return [p[0]!, p[2]!, heading];
}

/**
 * Puts a star on the ground: the leader's position and heading are set to
 * (x, y, z, heading), then every member of the group, in table order, is
 * moved to its star_get_slot_target at height y - node origin, yaw, walk,
 * and the entity's own pos/heading. The leader's node is only moved when the
 * loop reaches it, so a member listed before its leader is placed relative
 * to the leader node's previous transform (as in the original). Returns 1,
 * or 0 when the group or its leader is out of range.
 *
 * @mw2 star_place_formation 0x0002afe0
 * @fidelity exact
 */
export function starPlaceFormation(group: number, x: number, y: number, z: number, heading: number): number {
  const m = mechs;
  if (!(group < GROUP_COUNT && m.groupTable[group]!.leaderMechIndex >>> 0 < m.mechCount >>> 0)) return 0;
  const leader = m.mechTable[m.groupTable[group]!.leaderMechIndex]!;
  leader.posX = x;
  leader.posZ = z;
  leader.posY = y;
  leader.heading = heading;
  for (let i = 0; i >>> 0 < m.mechCount >>> 0; i++) {
    const e = m.mechTable[i]!;
    if (group === e.groupId) {
      const [tx, tz, th] = starGetSlotTarget(i)!;
      sceneNodeSetOrigin(e.node!, tx, y, tz);
      sceneNodeSetEuler(e.node!, 0, th, 0, 0);
      sceneNodeWalk(e.node!);
      e.posX = tx;
      e.posY = y;
      e.posZ = tz;
      e.heading = th;
    }
  }
  return 1;
}

/**
 * A request to a group: none or code 0 re-applies its current objective
 * (group_apply_objective), code 7 dispatches a responder.
 *
 * @mw2 group_handle_request 0x00023fc0
 * @fidelity stub
 * @divergence Phase 2 (AI): group_apply_objective and group_dispatch_responder are not ported, so the group's AI members are not re-tasked
 */
export function groupHandleRequest(_group: number, _request: number[] | null): void {
  divergence('group_handle_request: objectives are not applied to groups until the AI is ported (Phase 2)', 'group_handle_request');
}

/**
 * Mission start: per group, number the star and apply its objective.
 *
 * @mw2 groups_start_mission 0x000218d0
 * @fidelity partial
 * @divergence no monochrome debug display to clear (monoDebugPresent / project_file_sub_04afff); group_handle_request is a Phase 2 stub
 */
export function groupsStartMission(): void {
  const n = missionTables.missionTableCount;
  for (let g = 0; g < n; g++) {
    starAssignSlots(g);
    groupHandleRequest(g, null);
  }
}

/**
 * The owner affiliation poly_resolve_code adds to placeholder polygon codes:
 * for kind 0x100 (a mech) its group's affiliation, otherwise the gamething's
 * own, with -1 read as 0.
 *
 * @portOnly the lookup half of poly_resolve_code (0x4fde0), installed into engine/scene/wtboLoader.ts
 */
export function polyOwnerAffiliation(kind: number, index: number): number {
  if (kind === 0x100) return mechs.groupTable[mechs.mechTable[index]!.groupId]!.affiliation;
  const a = things.gameThings[index]!.affiliation;
  return a !== -1 ? a : 0;
}
setPolyOwnerAffiliation(polyOwnerAffiliation);
