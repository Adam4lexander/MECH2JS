/**
 * Registry of the game's global state.
 *
 * Every C global the port reproduces lives as a field of a state object in the
 * module of its subject (sceneGlobals, worldGlobals, ...), named as the
 * decompilation names it. Each such object registers here with a reset
 * function, which gives the editor a list of every table to inspect and gives
 * a mission load one call to return everything to its boot values.
 *
 * Groups belong to one executable (engine/exeTarget.ts). Starting MW2.EXE or
 * MW2SHELL.EXE resets only that executable's globals, as a fresh process would.
 *
 * @portOnly
 */
import type { ExeTarget } from './exeTarget.ts';

export interface GlobalGroup {
  /** display name: the subject, e.g. 'scene', 'mechs' */
  name: string;
  /** the executable these globals belong to */
  target: ExeTarget;
  /** the live state object; its fields are the C globals */
  state: object;
  /** restores the values the globals have when the executable starts */
  reset: () => void;
}

const groups = new Map<string, GlobalGroup>();

export function registerGlobals<T extends object>(name: string, state: T, reset: () => void, target: ExeTarget = 'mw2'): T {
  groups.set(`${target}:${name}`, { name, target, state, reset });
  return state;
}

/** The registered groups, of one executable or of both. */
export function globalGroups(target?: ExeTarget): GlobalGroup[] {
  return [...groups.values()].filter((g) => !target || g.target === target);
}

/** Resets every group of one executable to its boot values. */
export function resetAllGlobals(target: ExeTarget = 'mw2'): void {
  for (const g of groups.values()) if (g.target === target) g.reset();
}
