/**
 * The shell's own state that is neither in its data segment nor on disk:
 * the open MW2.PRJ (main's project_open) and the C runtime helpers the
 * shell's code leans on.
 *
 * @portOnly
 */
import type { ProjectFile } from '../data/prj/ProjectFile.ts';
import { registerGlobals } from '../engine/globals.ts';

export const shellProject = registerGlobals(
  'project',
  {
    /** MW2.PRJ as main opened it (mainProject, 0x7988c); set by the host before the shell starts */
    prj: null as ProjectFile | null,
  },
  () => {
    // the project is the host's input, as the install is; a restart keeps it
  },
  'mw2shell',
);

/** @portOnly the open project; fails before the host sets it */
export function project(): ProjectFile {
  if (!shellProject.prj) throw new Error('the shell has no MW2.PRJ (shellProject.prj)');
  return shellProject.prj;
}

/**
 * strnicmp(a, b, n): compares up to n characters, folding A-Z to lower case,
 * stopping at a NUL; the difference of the first unequal pair.
 *
 * @portOnly the Watcom runtime routine at 0x49e98 (byte-identical to MW2's 0x75dfc)
 */
export function strnicmp(a: string, b: string, n: number): number {
  for (let i = 0; i < n; i++) {
    let x = i < a.length ? a.charCodeAt(i) & 0xff : 0;
    let y = i < b.length ? b.charCodeAt(i) & 0xff : 0;
    if (x >= 0x41 && x <= 0x5a) x += 0x20;
    if (y >= 0x41 && y <= 0x5a) y += 0x20;
    if (x !== y) return x - y;
    if (y === 0) return 0;
  }
  return 0;
}
