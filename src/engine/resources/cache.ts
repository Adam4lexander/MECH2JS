/**
 * The resource cache over the main project file (MW2.PRJ).
 *
 * The original allocates a cache item per (type, id), reads the resource
 * into it, and locks/unlocks/purges under memory pressure. The port holds
 * the whole container in memory, so a load is a view into it and the
 * lock/unlock/release calls have nothing to do; they are kept at their call
 * sites as no-ops so the ported bodies read like the originals.
 */
import { ProjectFile, resourceIdByName } from '../../data/prj/ProjectFile.ts';
import { systemError } from '../../core/systemError.ts';
import { registerGlobals } from '../globals.ts';

export const resources = registerGlobals(
  'resources',
  {
    /** mainProject: the open MW2.PRJ */
    mainProject: null as ProjectFile | null,
  },
  () => {},
);

export function setMainProject(prj: ProjectFile): void {
  resources.mainProject = prj;
}

export function mainProject(): ProjectFile {
  if (!resources.mainProject) throw new Error('no project file open');
  return resources.mainProject;
}

/**
 * The payload of (type, id), or null with system_error for a missing one.
 *
 * @mw2 cache_load_resource 0x00033ba0
 * @fidelity partial
 * @divergence no cache items, purge list or memory accounting - a view into the in-memory container
 */
export function cacheLoadResource(id: number, type: string): Uint8Array | null {
  const prj = mainProject();
  if (prj.resourceSize(type, id) < 1) {
    systemError(0x20, `Non existant resource: type=${type} id=${id}`);
    return null;
  }
  return prj.readResource(type, id);
}

/**
 * @mw2 cache_unlock 0x00033b40
 * @fidelity stub
 * @divergence nothing is locked
 */
export function cacheUnlock(_id: number, _type: string): void {}

/**
 * @mw2 cache_release 0x00033e40
 * @fidelity stub
 * @divergence nothing is cached
 */
export function cacheRelease(_id: number, _type: string): void {}

/** project_resource_size against the main project (ported in data/prj/ProjectFile.ts). @portOnly */
export function projectResourceSize(type: string, id: number): number {
  return mainProject().resourceSize(type, id);
}

/** resource_id_by_name against the main project. @portOnly convenience */
export function idByName(table: number, name: string): number {
  return resourceIdByName(mainProject(), table, name);
}
