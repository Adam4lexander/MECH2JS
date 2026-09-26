/**
 * Registry of the game's global state.
 *
 * Every C global the port reproduces lives as a field of a state object in the
 * module of its subject (sceneGlobals, worldGlobals, ...), named as the
 * decompilation names it. Each such object registers here with a reset
 * function, which gives the editor a list of every table to inspect and gives
 * a mission load one call to return everything to its boot values.
 *
 * @portOnly
 */

export interface GlobalGroup {
  /** display name: the subject, e.g. 'scene', 'mechs' */
  name: string;
  /** the live state object; its fields are the C globals */
  state: object;
  /** restores the values the globals have when MW2.EXE starts */
  reset: () => void;
}

const groups = new Map<string, GlobalGroup>();

export function registerGlobals<T extends object>(name: string, state: T, reset: () => void): T {
  groups.set(name, { name, state, reset });
  return state;
}

export function globalGroups(): GlobalGroup[] {
  return [...groups.values()];
}

/** Resets every registered group to its boot values. */
export function resetAllGlobals(): void {
  for (const g of groups.values()) g.reset();
}
