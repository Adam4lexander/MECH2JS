/**
 * The visual effect table: 32 EffectType records of 0x1c bytes at 0x9f900,
 * indexed by the low byte of an effect code in effect_spawn (0x51060), which
 * refuses rows above 0x1f. Field meanings and units are the EffectType
 * schema's (mw2_types.h): lifetime in 182 Hz ticks, soundChance a percentage
 * with -1 meaning always.
 */
import type { ExeImage } from '../ExeImage.ts';
import { readArray } from '../../../engine/schema/read.ts';
import type { RawEffectType } from '../../../generated/structs.gen.ts';

export const EFFECT_TABLE = 0x9f900;
export const EFFECT_COUNT = 32;
export const EFFECT_STRIDE = 0x1c;
/** Rows from here on are placed on effectMountNode (effect_spawn_on_mount) and not counted in the crowding test. */
export const EFFECT_FIRST_MOUNT_ROW = 0x17;

export type EffectType = RawEffectType;

/**
 * effect_spawn's row switch, transcribed from its body (0x51060) and checked
 * against it: row -> [flag, variant row], tested in order, first match wins.
 * The flags are Projectile.impactFlags << 8. Rows 3 and 4 also spawn code
 * 0x10b behind themselves; row 5's 0x100 variant is placed at the second
 * position argument. The function itself is not ported here.
 */
export const EFFECT_VARIANTS: ReadonlyMap<number, ReadonlyArray<readonly [flag: number, row: number]>> = new Map<number, ReadonlyArray<readonly [number, number]>>([
  [0, [[0x2000, 0x0e], [0x400, 0x09]]],
  [1, [[0x2000, 0x0f], [0x400, 0x09]]],
  [2, [[0x2000, 0x10], [0x400, 0x09]]],
  [3, [[0x400, 0x0c], [0x2000, 0x11], [0x200, 0x13]]],
  [4, [[0x400, 0x0c], [0x2000, 0x11], [0x200, 0x14]]],
  [5, [[0x100, 0x08], [0x400, 0x09], [0x2000, 0x12]]],
  [6, [[0x400, 0x15]]],
]);

/**
 * @mw2data effectTypes 0x0009f900
 * @fidelity exact
 */
export function readEffectTypes(exe: ExeImage): EffectType[] {
  return readArray<EffectType>(exe, 'EffectType', EFFECT_TABLE, EFFECT_COUNT);
}
