/**
 * Starting the MW2SHELL.EXE "process": its image, its globals reset from it,
 * and the project main opens. What runs after (main's screens) is src/shell.
 *
 * @portOnly the process start the C runtime and main's first lines do
 */
import type { ExeImage } from '../data/exe/ExeImage.ts';
import type { ProjectFile } from '../data/prj/ProjectFile.ts';
import { resetAllGlobals } from '../engine/globals.ts';
import { setBootImage } from '../engine/image.ts';
import { shellProject } from './project.ts';
// the modules whose globals a start resets must be loaded
import './memory.ts';

export function startShellProcess(exe: ExeImage, prj: ProjectFile): void {
  setBootImage(exe, 'mw2shell');
  resetAllGlobals('mw2shell');
  shellProject.prj = prj;
}
