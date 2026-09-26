/**
 * The gamepiece classes: nine GamepieceClass records of 0x20 bytes at
 * 0x96088. project_chunk_exec's GP branch (0x4e5d0) searches them for the
 * class number in GP chunk +0xa (`cmp ebx, [ecx + 0x96088]` at 0x4ee41, over
 * `< 9` records; system_error 0x30 and record 0 when none matches), hands
 * createLoadout to mech_spawn and copies hooks[] into MechEntity.hooks
 * ([3] and [4] for the player only). Record 0 is GP_NULL, all null.
 *
 * Code pointers are kept as raw original addresses; engine code resolves
 * them through its code registry.
 */
import type { ExeImage } from '../ExeImage.ts';
import { readArray } from '../../../engine/schema/read.ts';
import type { RawGamepieceClass } from '../../../generated/structs.gen.ts';

export const GAMEPIECE_CLASSES = 0x96088;
export const GAMEPIECE_CLASS_COUNT = 9;

export type GamepieceClass = RawGamepieceClass;

/**
 * @mw2data gamepieceClasses 0x00096088
 * @fidelity exact
 */
export function readGamepieceClasses(exe: ExeImage): GamepieceClass[] {
  return readArray<GamepieceClass>(exe, 'GamepieceClass', GAMEPIECE_CLASSES, GAMEPIECE_CLASS_COUNT);
}
