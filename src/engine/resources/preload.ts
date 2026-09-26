/**
 * Startup preloading, and the {id, name} reference loader the resource
 * loaders share.
 *
 * sim_preload_data runs once in main, straight after world_records_build_all:
 * it warms the cache with every weapon's fire sound, every effect's sound and
 * the eight fixed sounds, then loads the nine AI rule tables. With MW2.PRJ
 * held in memory the warming has nothing to do but report a missing resource;
 * the rule tables are real state (aiRuleTables), owned by the AI.
 */
import { LABEL } from '../../generated/labels.gen.ts';
import { divergence, unestablished } from '../../core/provenance.ts';
import type { StreamRef } from '../../data/bwd/stream.ts';
import { readEffectTypes } from '../../data/exe/tables/effects.ts';
import { readWeaponTypes } from '../../data/exe/tables/weaponTypes.ts';
import { bootImage, imageI32s } from '../image.ts';
import { cacheLoadResource, cacheUnlock, idByName, projectResourceSize } from './cache.ts';

/**
 * Loads the resource a {short id; char name[]} reference names, as
 * resource_load_ref (0x34560) does: id -1 resolves the first 12 characters of
 * the name through TABL `table` (resource_id_by_name); a resolved id loads
 * from MW2.PRJ; the resolved id - or -1 when nothing loaded - is written back
 * into the reference. `size` is project_resource_size's answer for a loaded
 * resource.
 *
 * Not reproduced: the loose-file fallback (name + ext read from disk when the
 * PRJ has nothing), the copy into the static arena (arenaTag) and the matching
 * free/unlock - the port's cache holds MW2.PRJ in memory.
 *
 * @portOnly resource_load_ref (0x34560) is shared with res_load_mgeo and is not claimed here; see the M1.7 report
 */
export function loadResourceRef(ref: StreamRef, type: string, ext: string, table: number): { data: Uint8Array | null; size: number } {
  let id = ref.id;
  let data: Uint8Array | null = null;
  let size = 0;
  if (id === -1) id = idByName(table, ref.name.slice(0, 0xc));
  if (id !== -1) {
    data = cacheLoadResource(id, type);
    size = projectResourceSize(type, id);
  }
  if (!data) {
    id = -1;
    divergence(`resource_load_ref: no loose-file fallback (${ref.name}${ext}) in the port`);
  }
  ref.id = id;
  return { data, size };
}

/**
 * Loads a resource into the cache and unlocks it at once, leaving it
 * evictable. The port's cache is the whole container, so this only reports a
 * missing resource.
 *
 * @mw2 cache_preload 0x0004a250
 * @fidelity exact
 */
export function cachePreload(id: number, type: string): void {
  cacheLoadResource(id, type);
  cacheUnlock(id, type);
}

/**
 * Preloads the SNDS fireSound of weapon types 0..29 (not 30, the nuke) and
 * the soundId of effect types 0..31, skipping ids <= 0.
 *
 * @mw2 weapons_preload_sounds 0x00052be0
 * @fidelity exact
 * @divergence reads the two tables from the boot image (the live tables are not ported yet); does nothing without one
 */
export function weaponsPreloadSounds(): void {
  const img = bootImage();
  if (!img) return;
  const weapons = readWeaponTypes(img);
  for (let i = 0; i < 0x1e; i++) if (weapons[i]!.fireSound > 0) cachePreload(weapons[i]!.fireSound, 'SNDS');
  const effects = readEffectTypes(img);
  for (let i = 0; i < 0x20; i++) if (effects[i]!.soundId > 0) cachePreload(effects[i]!.soundId, 'SNDS');
}

/**
 * Preloads the eight SNDS ids of preloadSoundIds (0x32448).
 *
 * @mw2 sound_preload_fixed 0x00032530
 * @fidelity exact
 */
export function soundPreloadFixed(): void {
  const ids = imageI32s(LABEL.preloadSoundIds, 8, []);
  for (const id of ids) cachePreload(id, 'SNDS');
}

/**
 * main's startup preload: weapons_preload_sounds, sound_preload_fixed, then
 * ai_rule_tables_load, whose result it returns.
 *
 * @mw2 sim_preload_data 0x0004a230
 * @fidelity exact
 */
export function simPreloadData(): number {
  weaponsPreloadSounds();
  soundPreloadFixed();
  return preloadLinks.aiRuleTablesLoad();
}

/**
 * The AI's loader, installed by sim/ai/rules.ts: the engine layer does not
 * import the sim.
 *
 * @portOnly
 */
export const preloadLinks = {
  aiRuleTablesLoad: (): number => {
    unestablished('sim_preload_data: ai_rule_tables_load is not installed', 'sim_preload_data');
    return 1;
  },
};
