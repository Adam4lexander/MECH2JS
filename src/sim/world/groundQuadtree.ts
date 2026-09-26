/**
 * Ground quadtrees: objectClass 5 meshes (terrain relief) get a quadtree of
 * their upward-facing polygons for ground-height and point queries. Ported
 * with collision in Phase 2; until then the build is a declared stub and the
 * object keeps bounds null (object_free_bounds' "nothing built" state).
 */
import type { WorldObject } from '../../generated/classes.gen.ts';
import { divergence } from '../../core/provenance.ts';

/**
 * @mw2 object_build_ground_quadtree 0x0001cf10
 * @fidelity stub
 */
export function objectBuildGroundQuadtree(_obj: WorldObject): void {
  divergence('ground quadtrees are not built yet (Phase 2: collision and ground height)', 'object_build_ground_quadtree');
}
