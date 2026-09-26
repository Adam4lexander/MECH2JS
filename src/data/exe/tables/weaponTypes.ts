/**
 * The weapon stats table: 31 WeaponType records of 0x58 bytes at 0x9ee58,
 * located through ai_decide_fire (which indexes it by type * 0x58). Field
 * meanings and units are the WeaponType schema's (mw2_types.h).
 */
import type { ExeImage } from '../ExeImage.ts';
import { readArray } from '../../../engine/schema/read.ts';
import type { RawWeaponType } from '../../../generated/structs.gen.ts';

export const WEAPON_TABLE = 0x9ee58;
export const WEAPON_COUNT = 31;

export type WeaponType = RawWeaponType;

/**
 * @mw2data weaponTypes 0x0009ee58
 * @fidelity exact
 */
export function readWeaponTypes(exe: ExeImage): WeaponType[] {
  return readArray<WeaponType>(exe, 'WeaponType', WEAPON_TABLE, WEAPON_COUNT);
}
