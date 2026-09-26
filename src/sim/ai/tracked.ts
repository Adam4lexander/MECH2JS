/**
 * trackedObjects: 128 points the AI and the HUD can aim at - navpoints (the
 * NAVP chunk, fixed positions), objects (NAVO, a position or a scene node to
 * follow) and the temporary waypoints mechs create for themselves
 * (tracked_object_create). A handle to entry i is 0x100 | i.
 *
 * The NAVP and NAVO branches that fill entries are the interpreter's
 * (mission/vm/chunkExec.ts).
 */
import { TrackedObject } from '../../generated/classes.gen.ts';
import { LABEL } from '../../generated/labels.gen.ts';
import { u16 } from '../../core/int/cint.ts';
import { registerGlobals } from '../../engine/globals.ts';
import { imageI32 } from '../../engine/image.ts';
import { mechs } from '../mech/mechGlobals.ts';

export const TRACKED_OBJECT_COUNT = 0x80;

function bootTracked() {
  return {
    /** TrackedObject[128], zero in the image */
    trackedObjects: Array.from({ length: TRACKED_OBJECT_COUNT }, () => new TrackedObject()),
    /** 0x96288: live entries; the creators refuse at 128 (and at -1) */
    trackedObjectCount: imageI32(LABEL.trackedObjectCount, 0),
  };
}

export const trackedGlobals = registerGlobals('tracked', bootTracked(), () => {
  Object.assign(trackedGlobals, bootTracked());
});

/**
 * Appends a temporary waypoint owned by a mech: in use, flags 0x401 (bit 0:
 * removable by its owner), the given position, targetHandle mechIndex |
 * 0x200, the mech's group, range 3000, no node and the name "!". Returns its
 * index, or -1 when the table is full.
 *
 * @mw2 tracked_object_create 0x00029c90
 * @fidelity exact
 */
export function trackedObjectCreate(mechIndex: number, x: number, y: number, z: number): number {
  const g = trackedGlobals;
  const n = g.trackedObjectCount;
  if (!(n < TRACKED_OBJECT_COUNT && n !== -1)) return -1;
  const t = g.trackedObjects[n]!;
  t.inUse = 1;
  t.flags = 0x401;
  t.x = x | 0;
  t.y = y | 0;
  t.z = z | 0;
  t.targetHandle = (mechIndex | 0x200) >>> 0;
  const group = mechs.mechTable[mechIndex]!.groupId;
  t.range = 3000;
  t.followNode = null;
  t.name = '!';
  t.groupId = group;
  g.trackedObjectCount = n + 1;
  return n;
}

/**
 * Removes a mech's temporary waypoint: refuses (-1) unless `handle` has the
 * 0x100 type bit, names a live entry, the entry has flags bit 0 and belongs
 * to `targetMechIndex`. Shifts the later entries down and decrements every
 * mech's targetPrimary, targetSecondary, targetHandle (not the player's) and
 * returnWaypoint that pointed past the removed entry. Returns the new count.
 *
 * @mw2 tracked_object_remove 0x00029d10
 * @fidelity exact
 */
export function trackedObjectRemove(targetMechIndex: number, handle: number): number {
  const g = trackedGlobals;
  if ((handle & 0x100) === 0) return -1;
  const idx = handle & 0xff;
  if (g.trackedObjectCount <= idx) return -1;
  const e = g.trackedObjects[idx]!;
  if ((e.flags & 1) === 0 || ((targetMechIndex | 0x200) >>> 0) !== e.targetHandle >>> 0) return -1;
  // a 0x15-dword copy of each following record over its predecessor
  for (let i = idx; i < g.trackedObjectCount - 1; i++) copyTracked(g.trackedObjects[i]!, g.trackedObjects[i + 1]!);
  const m = mechs;
  for (let i = 0; i < m.mechCount; i++) {
    const mech = m.mechTable[i];
    if (!mech) continue;
    if ((mech.targetPrimary & 0x100) !== 0 && idx < (mech.targetPrimary & 0xff)) mech.targetPrimary = u16(mech.targetPrimary - 1);
    if ((mech.targetSecondary & 0x100) !== 0 && idx < (mech.targetSecondary & 0xff)) mech.targetSecondary = u16(mech.targetSecondary - 1);
    if ((mech.targetHandle & 0x100) !== 0 && idx < (mech.targetHandle & 0xff) && m.playerMechIndex !== mech.index) mech.targetHandle = (mech.targetHandle - 1) >>> 0;
    if ((mech.returnWaypoint & 0x100) !== 0 && idx < (mech.returnWaypoint & 0xff)) mech.returnWaypoint = u16(mech.returnWaypoint - 1); // a dword decrement at +0x166; the low word is >= 1, so +0x168 never borrows
  }
  g.trackedObjectCount = (g.trackedObjectCount - 1) | 0;
  return g.trackedObjectCount;
}

/** The whole-record copy tracked_object_remove shifts entries with. @portOnly */
function copyTracked(dst: TrackedObject, src: TrackedObject): void {
  dst.inUse = src.inUse;
  dst.followNode = src.followNode;
  dst.targetHandle = src.targetHandle;
  dst.groupId = src.groupId;
  dst.range = src.range;
  dst.heading = src.heading;
  dst.x = src.x;
  dst.y = src.y;
  dst.z = src.z;
  dst.flags = src.flags;
  dst.seenByGroups = src.seenByGroups;
  dst.name = src.name;
  dst.field_0x3e = src.field_0x3e;
}
