/**
 * The gamepiece classes with their code pointers resolved: the nine
 * GamepieceClass rows at 0x96088 (data/exe/tables/gamepieceClasses.ts) with
 * createLoadout and hooks[] turned from original addresses into the ported
 * functions registered for them.
 *
 * This module imports every module that registers a class's code, so a
 * caller of gamepieceClasses() gets every address resolved.
 */
import { readGamepieceClasses } from '../../data/exe/tables/gamepieceClasses.ts';
import type { ExeImage } from '../../data/exe/ExeImage.ts';
import { type CodeFn, resolveCode } from '../../engine/codePtr.ts';
import { bootImage } from '../../engine/image.ts';
import './loadout.ts';
import './create.ts';
import './tickHooks.ts';

export interface GamepieceClassLive {
  /** GamepieceClass.classId: 1 mech, 2 truck, 3 artillery, 4 tank, 5 helicopter, 6 wanderer, 7 door, 8 transport */
  classId: number;
  /** called by mech_spawn as (mechIndex, entity) */
  createLoadout: CodeFn | null;
  /** copied into MechEntity.hooks by the GP chunk ([3], [4] for the player only) */
  hooks: (CodeFn | null)[];
}

let cache: { exe: ExeImage; classes: GamepieceClassLive[] } | null = null;

/**
 * The class table of the booted image, index = table row (0 is GP_NULL).
 * An address with no registered function resolves to null, as an address of
 * 0 does.
 *
 * @portOnly resolves the @mw2data table gamepieceClasses (0x96088) through the code registry
 */
export function gamepieceClasses(): GamepieceClassLive[] {
  const exe = bootImage();
  if (!exe) throw new Error('gamepieceClasses: no boot image (setBootImage)');
  if (cache?.exe === exe) return cache.classes;
  const classes = readGamepieceClasses(exe).map((g) => ({
    classId: g.classId,
    createLoadout: resolveCode(g.createLoadout),
    hooks: g.hooks.map((h) => resolveCode(h)),
  }));
  cache = { exe, classes };
  return classes;
}
