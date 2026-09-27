/**
 * The two executables the port reproduces. Each is its own process in the
 * original - MECH2.EXE runs them in turn - so each has its own globals, its
 * own boot image and its own code address space, and the engine's registries
 * are keyed by which one a thing belongs to.
 *
 * @portOnly
 */

/** 'mw2' is MW2.EXE (the sim); 'mw2shell' is MW2SHELL.EXE (the front end). */
export type ExeTarget = 'mw2' | 'mw2shell';
