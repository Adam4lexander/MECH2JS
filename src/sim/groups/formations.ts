/**
 * Star formations: the 0x20 formationPresets rows the FTBL chunks define by
 * name, and the per-group copy in formationTable that a group flies. GRP and
 * STAR chunks give each group a formation by name.
 */
import { radioFormationChange } from '../sound/voice.ts';
import { StarFormation } from '../../generated/classes.gen.ts';
import { LABEL } from '../../generated/labels.gen.ts';
import type { Chunk } from '../../data/bwd/stream.ts';
import { decodeFtbl } from '../../data/bwd/payloads/ftbl.ts';
import { decodeStar } from '../../data/bwd/payloads/star.ts';
import { registerGlobals } from '../../engine/globals.ts';
import { imageI32 } from '../../engine/image.ts';
import { mechs, GROUP_COUNT } from '../mech/mechGlobals.ts';

export const FORMATION_PRESET_COUNT = 0x20;

export const formations = registerGlobals(
  'formations',
  {
    /** 0xfbc84: the named formations, appended by FTBL chunks */
    formationPresets: Array.from({ length: FORMATION_PRESET_COUNT }, () => new StarFormation()),
    /** 0x96298 */
    formationCount: 0,
    /**
     * 0x9eb94: a formation name that replaces the STAR chunk's for the player's
     * group (-OF=name on the command line, via check_launched_by_shell); null for none
     */
    formationOverridePlayer: null as string | null,
    /** 0x9eb98: the same for every other group (-OE=name) */
    formationOverrideEnemy: null as string | null,
  },
  () => {
    const f = formations;
    f.formationPresets = Array.from({ length: FORMATION_PRESET_COUNT }, () => new StarFormation());
    f.formationCount = imageI32(LABEL.formationCount, 0);
    // both pointers are 0 in the image; only the command line sets them
    f.formationOverridePlayer = null;
    f.formationOverrideEnemy = null;
  },
);

/** The whole 0x4c-byte row copy (rep movsd, 0x13 dwords) the formation setters do. @portOnly */
export function starFormationCopy(from: StarFormation, to: StarFormation): void {
  to.name = from.name;
  to.slotX.set(from.slotX);
  to.slotZ.set(from.slotZ);
  to.slotHeading.set(from.slotHeading);
}

/** Watcom stricmp == 0 on two C strings (ASCII case folding). @portOnly */
function stricmpEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    let x = a.charCodeAt(i);
    let y = b.charCodeAt(i);
    if (x >= 0x41 && x <= 0x5a) x += 0x20;
    if (y >= 0x41 && y <= 0x5a) y += 0x20;
    if (x !== y) return false;
  }
  return true;
}

/**
 * Gives a group the first loaded formation whose name matches (case
 * insensitive): stores its row index in MechGroup.formation and copies the
 * row into formationTable. Returns 1, or 0 when none matches.
 *
 * @mw2 group_set_formation_by_name 0x0002ae30
 * @fidelity exact
 */
export function groupSetFormationByName(group: number, name: string): number {
  if (group < GROUP_COUNT) {
    const f = formations;
    for (let i = 0; i < f.formationCount; i++) {
      if (stricmpEqual(f.formationPresets[i]!.name, name)) {
        mechs.groupTable[group]!.formation = i;
        starFormationCopy(f.formationPresets[i]!, mechs.formationTable[group]!);
        return 1;
      }
    }
  }
  return 0;
}

/**
 * Gives a group formation row `index` (< 0x20). For the player's own group
 * the wingmen are first told over the radio.
 *
 * @mw2 group_set_formation 0x0002aed0
 * @fidelity exact
 */
export function groupSetFormation(group: number, index: number): void {
  if (group < GROUP_COUNT && index < FORMATION_PRESET_COUNT) {
    if (group === mechs.playerGroupIndex) radioFormationChange(index);
    mechs.groupTable[group]!.formation = index;
    starFormationCopy(formations.formationPresets[index]!, mechs.formationTable[group]!);
  }
}

/**
 * GRP (keyword group): sixteen 17-byte formation names from +8, one per
 * group; clears each group's +0xc byte.
 *
 * @mw2 group_formations_load 0x0004dcb0
 * @fidelity exact
 */
export function groupFormationsLoad(c: Chunk): void {
  for (let i = 0; i < GROUP_COUNT; i++) {
    // passed as a pointer: the name runs to its NUL, which may lie in the next record
    groupSetFormationByName(i, c.str(8 + i * 0x11));
    mechs.groupTable[i]!.field_0xc = 0;
  }
}

/**
 * STAR (keyword star): per group in order, its affiliation, its allegiance
 * (also written to affiliationAllegiance at that affiliation) and a
 * formation name - replaced by the command line's -OF / -OE name when set.
 *
 * @mw2 star_table_load 0x0004dbf0
 * @fidelity exact
 */
export function starTableLoad(c: Chunk): void {
  const star = decodeStar(c);
  // (size - 8) / 0x18 as an unsigned divide: a chunk shorter than 8 would give a huge count in C
  const n = Math.floor(((c.size - 8) >>> 0) / 0x18);
  const m = mechs;
  const f = formations;
  for (let i = 0; i < n; i++) {
    const rec = star.groups[i] ?? { affiliation: 0, allegiance: 0 }; // past the chunk: reads as 0, as Chunk does
    const g = m.groupTable[i]!;
    g.affiliation = rec.affiliation;
    g.allegiance = rec.allegiance;
    // an affiliation outside 0..7 would write past the 8-byte table in C; the typed array drops it
    m.affiliationAllegiance[rec.affiliation] = rec.allegiance;
    let name: string;
    if (i === m.playerGroupIndex && f.formationOverridePlayer !== null) name = f.formationOverridePlayer;
    else if (i !== m.playerGroupIndex && f.formationOverrideEnemy !== null) name = f.formationOverrideEnemy;
    // passed as a pointer, so not bounded by the record as decodeStar's name is
    else name = c.str(8 + i * 0x18 + 8);
    groupSetFormationByName(i, name);
    g.field_0xc = 0;
  }
}

/**
 * FTBL (keyword formation): appends one named formation - five (x, z,
 * heading) slots. Refused (0) past 0x20 rows or unless the payload holds
 * exactly five slots.
 *
 * @mw2 formation_table_load 0x0004da50
 * @fidelity exact
 */
export function formationTableLoad(c: Chunk): number {
  const f = formations;
  const i = f.formationCount;
  if (i < FORMATION_PRESET_COUNT && Math.floor(((c.size - 0x18) >>> 0) / 0xc) === 5) {
    const ftbl = decodeFtbl(c);
    const row = f.formationPresets[i]!;
    f.formationCount++;
    row.name = ftbl.name;
    for (let k = 0; k < 5; k++) {
      const s = ftbl.slots[k]!;
      row.slotX[k] = s.x;
      row.slotZ[k] = s.z;
      row.slotHeading[k] = s.heading;
    }
    return 1;
  }
  return 0;
}

/**
 * groupTable[group].formation, or 0 past the sixteen groups.
 *
 * @mw2 group_get_formation 0x0002aeb0
 * @fidelity exact
 */
export function groupGetFormation(group: number): number {
  return 0xf < group ? 0 : mechs.groupTable[group]!.formation;
}
