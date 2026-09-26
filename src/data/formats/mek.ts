/**
 * MEK chassis records - the payload of a MEK resource, and the loose
 * MEK\*.MEK user variants - as mech_load_config (0x4c760) reads them.
 *
 *   +0x000  MechChassis header (mw2_types.h): tons, moveSpeed, jump,
 *           heatSinks, numWeapons, numAmmo (ints), then eight MechSection
 *           records of 0x28 (armorFront, armorRear, internal, ushort slots[12],
 *           short numSlots, short flags) - copied into the loadout as 0x50
 *           dwords
 *   +0x158  numWeapons weapon mounts {uint slotCode, int location}
 *   then    numAmmo ammo bins {uint binCode, uint weaponCode}
 *   then    50 bytes the game never reads (see MekRecord.trailer)
 *
 * numWeapons: the loader clamps it to 10 IN THE RECORD before anything else
 * (`if (10 < n) n = 10`, a signed compare) and computes the ammo-bin base
 * after the clamp: +0x158 + clamped * 8. tools/dump_chassis.py puts the bins
 * at +0x158 + unclamped * 8; the loader wins. No shipped record has more than
 * 10 weapons, so the two agree on the data.
 *
 * LOOSE FILES. mech_load_config builds "mek\" + the GPS chunk's name, appends
 * ".mek" when the name has no '.', passes it through screenshot_sub_04c4b0
 * (which prefixes a configured directory) and tries res_load_file FIRST; only
 * when that fails does it load the MEK resource by the chunk's id. Both paths
 * leave the record in the same pointer, which every later read goes through,
 * so a loose MEK file has exactly this format - and overrides the resource.
 * The nine files in the install's MEK directory (xxxnnUSR.MEK) all tile to
 * the byte with the same 50-byte trailer as the resources.
 */

import { cstr } from '../../core/binary/ByteReader.ts';
import { bytesMemory, readStruct } from '../../engine/schema/read.ts';
import type { RawMechChassis } from '../../generated/structs.gen.ts';

export const MEK_HEADER_SIZE = 0x158;
export const MEK_MOUNT_SIZE = 8;
/** mech_load_config's clamp on numWeapons */
export const MEK_MAX_WEAPONS = 10;
/** mech_load_config stops creating ammo bins at this many (local_20 < 0x19) */
export const MEK_MAX_AMMO_BINS = 0x19;
/** bytes after the ammo bins in every record, resource and loose file alike */
export const MEK_TRAILER_SIZE = 50;

export interface MekWeaponMount {
  /** MechWeapon.slotCode; slotCode / 100 is the weaponTypes index */
  slotCode: number;
  /**
   * MechWeapon.sectionIndex (0-based) when >= 0. When negative the loader
   * searches all eight sections' slots for slotCode, the last match winning,
   * and maps a match in section 6 to 1 and in section 7 to 3 (the
   * `iVar11 == 6` / `== 7` tests in the exported mech_load_config); why those
   * two are remapped is not established.
   */
  location: number;
}

export interface MekAmmoBin {
  /** the bin's own slot code (MechAmmoBin.slotCode) */
  binCode: number;
  /** the slotCode of the weapon it feeds; the loader matches it against each mount's slotCode */
  weaponCode: number;
}

export interface MekRecord {
  chassis: RawMechChassis;
  /** chassis.numWeapons after the loader's clamp to 10 */
  numWeaponsLoaded: number;
  weapons: MekWeaponMount[];
  /** offset of the first ammo bin (after the clamp) */
  ammoOffset: number;
  ammo: MekAmmoBin[];
  /** offset just past the last ammo bin */
  end: number;
  /**
   * The bytes after the last ammo bin: 50 in every record. mech_load_config
   * does not read them. They open with NUL-terminated text ('Behemoth CFG #1',
   * 'Primary Config', 'User Variant #1') followed by leftover memory. Which
   * program reads them (the shell's mech lab, presumably) has not been
   * checked, so the field is not named for a meaning.
   */
  trailer: Uint8Array;
  /** the trailer's leading text, up to its first NUL */
  trailerText: string;
}

/**
 * Parses a MEK record. Returns null if it is shorter than the 0x158-byte
 * header. Mounts and bins that would run past the end are dropped (the loader
 * does not check; it reads past the record).
 *
 * @portOnly the parse half of mech_load_config (0x4c760); building the loadout is sim work
 */
export function parseMek(c: Uint8Array): MekRecord | null {
  if (c.length < MEK_HEADER_SIZE) return null;
  const dv = new DataView(c.buffer, c.byteOffset, c.byteLength);
  const chassis = readStruct<RawMechChassis>(bytesMemory(c), 'MechChassis', 0);
  const numWeaponsLoaded = MEK_MAX_WEAPONS < chassis.numWeapons ? MEK_MAX_WEAPONS : chassis.numWeapons;
  const weapons: MekWeaponMount[] = [];
  for (let w = 0; w < numWeaponsLoaded; w++) {
    const o = MEK_HEADER_SIZE + w * MEK_MOUNT_SIZE;
    if (o + 8 > c.length) break;
    weapons.push({ slotCode: dv.getUint32(o, true), location: dv.getInt32(o + 4, true) });
  }
  const ammoOffset = MEK_HEADER_SIZE + numWeaponsLoaded * MEK_MOUNT_SIZE;
  const ammo: MekAmmoBin[] = [];
  for (let a = 0; a < chassis.numAmmo; a++) {
    const o = ammoOffset + a * MEK_MOUNT_SIZE;
    if (o + 8 > c.length) break;
    ammo.push({ binCode: dv.getUint32(o, true), weaponCode: dv.getUint32(o + 4, true) });
  }
  const end = ammoOffset + Math.max(0, chassis.numAmmo) * MEK_MOUNT_SIZE;
  const trailer = c.subarray(Math.min(end, c.length));
  return { chassis, numWeaponsLoaded, weapons, ammoOffset, ammo, end, trailer, trailerText: cstr(trailer) };
}
