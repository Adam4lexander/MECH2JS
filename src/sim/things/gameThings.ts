/**
 * gameThings: 254 (0xfe) GameThing records - buildings and other scenery the
 * mission gives hit points, a side and a name (GT chunks). Slots are handed
 * out by a bump allocator that is never reset for the life of the process.
 */
import { GameThing } from '../../generated/classes.gen.ts';
import { LABEL } from '../../generated/labels.gen.ts';
import { systemError } from '../../core/systemError.ts';
import { registerGlobals } from '../../engine/globals.ts';
import { imageI32 } from '../../engine/image.ts';

export const GAMETHING_COUNT = 0xfe;

export const things = registerGlobals(
  'gameThings',
  {
    gameThings: Array.from({ length: GAMETHING_COUNT }, () => new GameThing()),
    /** 0x961cc */
    gameThingCount: 0,
  },
  () => {
    things.gameThings = Array.from({ length: GAMETHING_COUNT }, () => new GameThing());
    things.gameThingCount = imageI32(LABEL.gameThingCount, 0);
  },
);

/**
 * @mw2 gamething_clear 0x00024970
 * @fidelity exact
 */
export function gamethingClear(i: number): void {
  const g = things.gameThings[i]!;
  g.flags = 0;
  g.seenByGroups = 0;
  g.geomIndex = -1;
  g.hitPoints = 0;
  g.affiliation = 0;
  g.name = '';
}

/**
 * @mw2 gamething_table_reset 0x000249b0
 * @fidelity exact
 */
export function gamethingTableReset(): void {
  for (let i = 0; i < GAMETHING_COUNT; i++) gamethingClear(i);
}

/**
 * Next slot, or -1 with system_error 0x2f (a warning) once 254 are used.
 *
 * @mw2 gamething_alloc 0x0004e570
 * @fidelity exact
 */
export function gamethingAlloc(): number {
  if (things.gameThingCount < GAMETHING_COUNT) return things.gameThingCount++;
  systemError(0x2f, 'Too many gamethings');
  return -1;
}
