/**
 * The shell's (MW2SHELL.EXE) counterpart of tools/struct-overrides.ts: how
 * src/generated/shell/classes.gen.ts deviates from a mechanical reading of
 * mw2shell_types.h. Every entry is a representation choice, not a change of
 * meaning. Structs the shell shares with MW2.EXE use MW2's class, and with it
 * MW2's overrides.
 */

export const POINTER_TYPES: Record<string, string> = {};

/** Fields declared [1] in C whose real length is set at allocation. */
export const VARIABLE_ARRAYS = new Set<string>();

/** Port-only fields appended to a class: name -> [TS type, initialiser, doc]. */
export const EXTRA_FIELDS: Record<string, Array<[string, string, string, string]>> = {};

/** Consecutive int fields the C treats as one block (see struct-overrides.ts). */
export const BLOCKS: Record<string, Array<{ block: string; fields: string[] }>> = {};
