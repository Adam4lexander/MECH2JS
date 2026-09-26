/**
 * The project id maps: translate the ids a mission stream uses for its
 * objects into what they became - a WorldObject (OBJ outside blocks), a
 * world record index (OBJ inside BLK, GT, TSK), a detail record index (OBJ
 * inside REPR). They exist only while a stream executes: sim_load_by_name
 * frees them straight after project_chunk_exec returns.
 *
 * Ids are "mangled" - offset by projectIdMangle, which MON/MOFF chunks step -
 * so each included stream has its own id space.
 */
import type { WorldObject } from '../../generated/classes.gen.ts';
import { divergence } from '../../core/provenance.ts';
import { registerGlobals } from '../../engine/globals.ts';

export const projectMaps = registerGlobals(
  'projectMaps',
  {
    projectObjectIds: [] as number[],
    projectObjects: [] as WorldObject[],
    projectObjectCapacity: 0,
    worldRecordMapIds: [] as number[],
    worldRecordMapValues: [] as number[],
    worldRecordMapCount: 0,
    worldRecordMapCapacity: 0,
    detailMapIds: [] as number[],
    detailMapValues: [] as number[],
    detailMapCount: 0,
    detailMapCapacity: 0,
    /** 0x9eb8c: added to every id a stream uses */
    projectIdMangle: 0,
  },
  () => projectMapsFree(),
);

/** Capacity the port gives each map (the original sizes them from the DTBL arena budget). */
const PORT_MAP_CAPACITY = 1 << 20;

/**
 * @mw2 project_maps_alloc 0x00035620
 * @fidelity partial
 * @divergence capacities are fixed and large; the original takes them from arena_budget_bytes (the DTBL totals the pre-pass sums)
 */
export function projectMapsAlloc(): boolean {
  projectMapsFree();
  divergence('project id maps sized to a fixed large capacity instead of the DTBL arena budget', 'project_maps_alloc');
  projectMaps.projectObjectCapacity = PORT_MAP_CAPACITY;
  projectMaps.worldRecordMapCapacity = PORT_MAP_CAPACITY;
  projectMaps.detailMapCapacity = PORT_MAP_CAPACITY;
  return true;
}

/**
 * @mw2 project_maps_free 0x00035760
 * @fidelity exact
 */
export function projectMapsFree(): void {
  const m = projectMaps;
  m.projectObjectIds = [];
  m.projectObjects = [];
  m.worldRecordMapIds = [];
  m.worldRecordMapValues = [];
  m.detailMapIds = [];
  m.detailMapValues = [];
  m.projectObjectCapacity = 0;
  m.detailMapCapacity = 0;
  m.worldRecordMapCapacity = 0;
  m.detailMapCount = 0;
  m.worldRecordMapCount = 0;
}

/**
 * @mw2 project_object_register 0x000356e0
 * @fidelity exact
 */
export function projectObjectRegister(id: number, obj: WorldObject): boolean {
  const m = projectMaps;
  if (m.projectObjects.length >= m.projectObjectCapacity) return false;
  m.projectObjectIds.push(id | 0);
  m.projectObjects.push(obj);
  return true;
}

/**
 * Newest first, so a re-used id finds its latest object.
 *
 * @mw2 project_object_find 0x00035720
 * @fidelity exact
 */
export function projectObjectFind(id: number): WorldObject | null {
  const m = projectMaps;
  for (let i = m.projectObjectIds.length - 1; i >= 0; i--) if (m.projectObjectIds[i] === id) return m.projectObjects[i]!;
  return null;
}

/**
 * Full scan, LAST match wins.
 *
 * @mw2 project_detail_find 0x00035820
 * @fidelity exact
 */
export function projectDetailFind(id: number): number {
  const m = projectMaps;
  let r = -1;
  for (let i = 0; i < m.detailMapCount; i++) if (m.detailMapIds[i] === id) r = m.detailMapValues[i]!;
  return r;
}

/**
 * @mw2 project_mangle_id 0x0004e110
 * @fidelity exact
 */
export function projectMangleId(id: number): number {
  return (id + projectMaps.projectIdMangle) | 0;
}

/**
 * @mw2 project_set_mangle 0x0004e120
 * @fidelity exact
 */
export function projectSetMangle(v: number): void {
  projectMaps.projectIdMangle = v | 0;
}
