/**
 * What the AI asks of an object handle, (type << 8) | index: how far to
 * engage it, whether it is destroyed or identified, the scene object behind
 * it, and the symbolic designators (agp_enemy, agp_myleader, ...) resolved
 * to concrete handles.
 */
import type { MechEntity, WorldObject } from '../../generated/classes.gen.ts';
import { unestablished } from '../../core/provenance.ts';
import { groupIdentifyTarget } from '../../mission/objectives.ts';
import { groupGetLeader, mechAllegiance, mechsSameAllegiance } from '../groups/groups.ts';
import { mechs } from '../mech/mechGlobals.ts';
import { things } from '../things/gameThings.ts';
import { worldObjectNode } from '../world/worldRecords.ts';
import { ai } from './aiGlobals.ts';
import { trackedGlobals } from './tracked.ts';

/**
 * A handle's engagement range: a tracked object's own range, a flat 10000
 * for a mech (2) or gamething (4), 100 for anything else; never below 100.
 *
 * @mw2 object_engage_range 0x00022880
 * @fidelity exact
 */
export function objectEngageRange(handle: number): number {
  const type = (handle >> 8) & 0xf;
  let r: number;
  if (type === 1) r = trackedGlobals.trackedObjects[handle & 0xff]!.range;
  else if (type === 2 || type === 4) r = 10000;
  else r = 100;
  return r < 100 ? 100 : r;
}

/**
 * Tests the flags of the object a handle names against an OBJECTIVE-TYPE
 * CODE, not a bit: 1, 2, 4 and 0x1000 ask 'destroyed?' (flags 0x4 on a mech
 * or gamething; a tracked object answers 0), 8 and 0x100 ask 'identified?'
 * (flags 0x20 on all three). Any other code tests `ecx`, whatever the caller
 * left in ECX. A handle with a type of 0x10 or more, or one that resolves to
 * nothing, answers 1.
 *
 * @mw2 object_test_flags 0x00023100
 * @fidelity exact
 */
export function objectTestFlags(handle: number, mask: number, ecx: number): number {
  const index = handle & 0xff;
  const type = (handle >>> 8) & 0xff;
  if (((type * 0x100) & 0xf000) !== 0) return 1;
  let flags: number | null = null;
  if (type === 1) flags = trackedGlobals.trackedObjects[index]!.flags;
  else if (type === 2) {
    const m = mechs.mechTable[index];
    if (!m) {
      unestablished(`object_test_flags: mech handle 0x${handle.toString(16)} names an empty mechTable slot`, 'object_test_flags');
      return 1;
    }
    flags = m.flags;
  } else if (type === 4) flags = things.gameThings[index]!.flags;
  if (flags === null) return 1;
  let test = ecx & 0xffff;
  mask >>>= 0;
  if (mask === 1 || mask === 2 || mask === 4 || mask === 0x1000) {
    if (type === 2 || type === 4) test = 4;
    else if (type === 1) return 0;
  } else if (mask === 8 || mask === 0x100) test = 0x20;
  return (flags & test) === 0 ? 0 : 1;
}

/**
 * The WorldObject behind a mech's node or a gamething's world record node
 * (node.userData), or null.
 *
 * @mw2 object_node_userdata 0x0002e400
 * @fidelity exact
 */
export function objectNodeUserdata(handle: number): WorldObject | null {
  const type = (handle >> 8) & 0xf;
  const index = handle & 0xff;
  let node = null;
  if (type === 2) node = mechs.mechTable[index]!.node;
  else if (type === 4) node = worldObjectNode(things.gameThings[index]!.geomIndex);
  return node ? node.userData : null;
}

/**
 * A target designator to a concrete handle, enumerating the plural ones.
 * `designator` without 0x2000 or 0x4000 is a literal: it comes back once
 * (-1 when its low 12 bits equal prev's). Otherwise, with prev 0xffff the
 * first answer, else (0x2xxx) -1 or (0x4xxx) the next after prev's index:
 * agp_home 0x2100 group_identify_target; agp_rbanchor 0x2101 returnWaypoint;
 * agp_user 0x2200 the player; agp_myleader 0x2201 the group's leader;
 * agp_me 0x2202 the mech; agp_friendly 0x4200 the next mech led by the
 * player (or, under the lairdo cheat, of allegiance 0); agp_enemy 0x4201 the
 * next mech of another side that is not neutral. -1 when exhausted. An
 * answer without a type nibble takes the designator's.
 *
 * Returns the low 16 bits, sign-extended: every caller reads only those (the
 * C's upper half is stack garbage in the agp_friendly walk).
 *
 * @mw2 resolve_target_designator 0x00022f00
 * @fidelity exact
 */
export function resolveTargetDesignator(mech: MechEntity, designator: number, prev: number): number {
  const d = designator | 0;
  const d16 = d & 0xffff;
  prev &= 0xffff;
  if ((d & 0x6000) === 0) return (d16 & 0xfff) === (prev & 0xfff) ? -1 : (d << 16) >> 16;
  let cursor = prev;
  if (prev !== 0xffff) {
    if ((d & 0x2000) !== 0) return -1;
    cursor = prev & 0xff;
  }
  let r = -1;
  if ((d & 0x200) === 0) {
    if ((d & 0x400) === 0 && (d & 0x100) !== 0 && 0x20ff < d16) {
      if (d16 < 0x2101) r = groupIdentifyTarget(mech.groupId);
      else if (d16 === 0x2101) r = mech.returnWaypoint;
    }
  } else if ((d & 0x4000) === 0) {
    if (d16 === 0x2200) r = mechs.playerMechIndex;
    else if (d16 === 0x2201) r = groupGetLeader(mech.groupId);
    else if (d16 === 0x2202) r = mech.index;
  } else if (0x41ff < d16) {
    if (d16 < 0x4201) {
      for (;;) {
        cursor = (cursor + 1) & 0xffff;
        const i = (cursor << 16) >> 16;
        if (mechs.mechCount <= i) break;
        if (groupGetLeader(mechs.mechTable[i]!.groupId) === mechs.playerMechIndex) {
          r = cursor;
          break;
        }
        if (ai.cheatFriendlyAllies !== 0 && mechAllegiance(i) === 0) {
          r = cursor;
          break;
        }
      }
    } else if (d16 === 0x4201) {
      for (;;) {
        cursor = (cursor + 1) & 0xffff;
        const i = (cursor << 16) >> 16;
        if (mechs.mechCount <= i) break;
        if (mechsSameAllegiance(i, mech.index) !== 0) continue;
        if (mechAllegiance(i) !== 2) {
          r = cursor;
          break;
        }
      }
    }
  }
  r = (r << 16) >> 16;
  if (r !== -1 && (r & 0xf00) === 0) r |= ((d >> 8) & 0xffff0f) << 8;
  return (r << 16) >> 16;
}
