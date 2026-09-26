/**
 * resource_load_ref: loading a resource named by a {short id; char name[]}
 * reference (MGDF, CPTF, HUDF and the animation chunks carry them).
 *
 * Its subject is the resource cache (engine/resources); it is here because
 * this cluster's files are sim/mech. res_load_anim, res_load_cockpit and
 * res_load_hdi call it too.
 */
import { unestablished } from '../../core/provenance.ts';
import type { StreamRef } from '../../data/bwd/stream.ts';
import { cacheLoadResource, idByName, projectResourceSize } from '../../engine/resources/cache.ts';
import { resLoadFile, screenshotSub04c4b0 } from './looseFiles.ts';

export interface LoadedRef {
  /** the resource or file bytes */
  data: Uint8Array;
  /** *outSize */
  size: number;
}

/**
 * Loads what a reference names: id -1 is first resolved by name (up to 12
 * characters) through TABL `table`; the resource is loaded from MW2.PRJ;
 * failing that, a loose file of the name's first 8 characters + ext is
 * tried and the id becomes -1. The resolved id (or -1) is written back into
 * ref.id, which callers test to know how to release the result.
 *
 * @mw2 resource_load_ref 0x00034560
 * @fidelity partial
 * @divergence no static-arena copy (arenaTag): the port's buffers need no arena, so the arenaTag path returns the bytes it loaded
 */
export function resourceLoadRef(ref: StreamRef, type: string, ext: string, table: number): LoadedRef | null {
  let id = ref.id;
  let data: Uint8Array | null = null;
  let size = 0;
  let nameKnown = false;
  let name = '';
  if (id === -1) {
    name = ref.name.slice(0, 12); // strncpy(local, ref->name, 12); local[12] = 0
    nameKnown = true;
    id = idByName(table, name);
  }
  if (id !== -1) {
    data = cacheLoadResource(id, type);
    size = projectResourceSize(type, id);
  }
  if (!data) {
    id = -1;
    if (!nameKnown) {
      // the C builds the loose name from a stack buffer only filled when the id was -1
      unestablished('resource_load_ref: loose-file fallback for a reference given by id uses an uninitialised name', 'resource_load_ref');
    } else {
      const loose = resLoadFile(screenshotSub04c4b0(name.slice(0, 8) + ext.slice(0, 4)));
      if (loose) {
        data = loose;
        size = loose.length;
      }
    }
  }
  ref.id = (id << 16) >> 16;
  return data ? { data, size } : null;
}
