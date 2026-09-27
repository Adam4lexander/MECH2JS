/**
 * The two star records the star screen edits - playerStar (0x840dc) and
 * opponentStar (0x8415c), with currentStar (0x841dc) pointing at the one
 * being edited - and what carries them across a mission: stars_save_to_prm /
 * stars_restore_from_prm, and star_launch_prepare, which turns them into
 * MW2's -of= / -oe= options and the star files.
 * (decompiled/mw2shell/src/mechlab/star_select.c, sound/shell_sound.c)
 *
 * A StarRecord (0x80) is {formation, selected, maxMechs, memberCount,
 * maxTonnage, members[3]}; a member (0x24) is {chassis (-1 unused),
 * mekName[16], pilotName[16]}.
 */
import { SHELL_LABEL } from '../../generated/shell/labels.gen.ts';
import { fieldOffset, mem, structSize } from '../memory.ts';
import { chassisEntry, chassisIndexOf, starFilesWrite } from './starFiles.ts';

const PLAYER = SHELL_LABEL.playerStar;
const OPPONENT = SHELL_LABEL.opponentStar;
const STAR_SIZE = structSize('StarRecord');
const MEMBER_SIZE = structSize('StarMember');
const F = {
  formation: fieldOffset('StarRecord', 'formation'),
  selected: fieldOffset('StarRecord', 'selected'),
  maxMechs: fieldOffset('StarRecord', 'maxMechs'),
  memberCount: fieldOffset('StarRecord', 'memberCount'),
  maxTonnage: fieldOffset('StarRecord', 'maxTonnage'),
  members: fieldOffset('StarRecord', 'members'),
  mekName: fieldOffset('StarMember', 'mekName'),
  pilotName: fieldOffset('StarMember', 'pilotName'),
};

/** The star record currentStar points at. */
export function currentStar(): number {
  return mem().u32(SHELL_LABEL.currentStar);
}

/** @portOnly the address of a star record's member */
export function starMember(star: number, i: number): number {
  return star + F.members + i * MEMBER_SIZE;
}

/** @portOnly a star record's fields, for the screens and tests */
export function readStar(star: number): {
  formation: number;
  selected: number;
  maxMechs: number;
  memberCount: number;
  maxTonnage: number;
  members: Array<{ chassis: number; mekName: string; pilotName: string }>;
} {
  const m = mem();
  return {
    formation: m.i32(star + F.formation),
    selected: m.i32(star + F.selected),
    maxMechs: m.i32(star + F.maxMechs),
    memberCount: m.i32(star + F.memberCount),
    maxTonnage: m.i32(star + F.maxTonnage),
    members: [0, 1, 2].map((i) => {
      const a = starMember(star, i);
      return { chassis: m.i32(a), mekName: m.cstr(a + F.mekName, 16), pilotName: m.cstr(a + F.pilotName, 16) };
    }),
  };
}

/**
 * Picks the star to edit (0 the player's, 1 the opponent's; -1 keeps the
 * current one) and sets its formation, maxMechs and memberCount (both
 * clamped to 3) and Keshik maximum tonnage - each unless -1.
 *
 * @mw2shell star_configure 0x0003ab50
 * @fidelity exact
 */
export function starConfigure(star: number, formation: number, maxMechs: number, memberCount: number, maxTonnage: number): void {
  const m = mem();
  if (star >= 0) m.setI32(SHELL_LABEL.currentStar, star === 0 ? PLAYER : OPPONENT);
  const s = currentStar();
  if (formation >= 0) m.setI32(s + F.formation, formation);
  if (maxMechs >= 0) m.setI32(s + F.maxMechs, Math.min(maxMechs, 3));
  if (memberCount >= 0) m.setI32(s + F.memberCount, Math.min(memberCount, 3));
  if (maxTonnage >= 0) m.setI32(s + F.maxTonnage, maxTonnage);
}

/**
 * Edits a member of the current star (index < 0: the selected one; else it
 * becomes selected). The pilot name is copied in; the MEK name is matched
 * by its first three letters against chassisTable. No match: the last
 * member (not the first) is dropped (-1), else 1 past the end, 0 inside. A
 * chassis heavier than the star's Keshik maximum is refused (0). Otherwise
 * the name is stored (a 3-letter name gets '00std'), the chassis set, and
 * a member added at the end grows the star up to maxMechs (-1).
 *
 * @mw2shell star_set_member 0x0003a8a0
 * @fidelity exact
 */
export function starSetMember(index: number, mekName: string | null, pilotName: string | null): number {
  const m = mem();
  const s = currentStar();
  let i: number;
  if (index < 0) i = m.i32(s + F.selected);
  else {
    m.setI32(s + F.selected, index);
    i = index;
  }
  const a = starMember(s, i);
  if (pilotName !== null) m.strcpy(a + F.pilotName, pilotName);
  if (mekName !== null) {
    const row = chassisIndexOf(mekName);
    const count = m.i32(s + F.memberCount);
    if (row < 0) {
      if (i !== 0 && i + 1 === count) {
        m.setI32(s + F.memberCount, count - 1);
        return -1;
      }
      return count <= i ? 1 : 0;
    }
    if (m.i32(s + F.maxTonnage) < chassisEntry(row).tonnage) return 0;
    m.strncpy(a + F.mekName, mekName, 8);
    m.setU8(a + F.mekName + 8, 0);
    if (mekName.length === 3) m.strcat(a + F.mekName, m.cstr(SHELL_LABEL.stdSuffix));
    m.setI32(a, row);
  }
  const count = m.i32(s + F.memberCount);
  if (i === count && count < m.i32(s + F.maxMechs)) m.setI32(s + F.memberCount, count + 1);
  return -1;
}

const PRM = SHELL_LABEL.prmBlock;

/**
 * Parks both stars in mw2prm.cfg's block, and whether the player's is the
 * current one.
 *
 * @mw2shell stars_save_to_prm 0x0003a810
 * @fidelity exact
 */
export function starsSaveToPrm(): void {
  const m = mem();
  m.setI32(PRM + fieldOffset('PrmBlock', 'currentStarIsPlayer'), currentStar() === PLAYER ? 1 : 0);
  m.copy(PRM + fieldOffset('PrmBlock', 'savedPlayerStar'), PLAYER, STAR_SIZE);
  m.copy(PRM + fieldOffset('PrmBlock', 'savedOpponentStar'), OPPONENT, STAR_SIZE);
}

/**
 * The inverse: currentStar from the saved flag, then both records back.
 *
 * @mw2shell stars_restore_from_prm 0x0003a850
 * @fidelity exact
 */
export function starsRestoreFromPrm(): void {
  const m = mem();
  m.setI32(SHELL_LABEL.currentStar, m.i32(PRM + fieldOffset('PrmBlock', 'currentStarIsPlayer')) === 0 ? OPPONENT : PLAYER);
  m.copy(PLAYER, PRM + fieldOffset('PrmBlock', 'savedPlayerStar'), STAR_SIZE);
  m.copy(OPPONENT, PRM + fieldOffset('PrmBlock', 'savedOpponentStar'), STAR_SIZE);
}

/** formationNames holds {display name, MW2 option} pairs: the option of formation f. */
function formationOption(f: number): string {
  return mem().ptrStr(SHELL_LABEL.formationNames + (f * 2 + 1) * 4) ?? '';
}

/**
 * Appends " -of=<player formation>" to the command line in the prm block
 * and, when the opponent's star has members, " -oe=<its formation>" (MW2's
 * formationOverridePlayer / formationOverrideEnemy); then writes the star
 * files for both.
 *
 * @mw2shell star_launch_prepare 0x0003abb0
 * @fidelity exact
 */
export function starLaunchPrepare(): void {
  const m = mem();
  const cl = PRM + fieldOffset('PrmBlock', 'commandLine');
  m.strcat(cl, m.cstr(SHELL_LABEL.optionFormationPlayer));
  m.strcat(cl, formationOption(m.i32(PLAYER + F.formation)));
  if (m.i32(OPPONENT + F.memberCount) !== 0) {
    m.strcat(cl, m.cstr(SHELL_LABEL.optionFormationEnemy));
    m.strcat(cl, formationOption(m.i32(OPPONENT + F.formation)));
  }
  starFilesWrite(m.i32(PLAYER + F.memberCount), starMember(PLAYER, 0), m.i32(OPPONENT + F.memberCount), starMember(OPPONENT, 0));
}
