/**
 * Effect spawning - explosions, jet exhaust, debris. Phase 3; until then a
 * spawn reports once and nothing appears. The callers' random rolls still
 * happen, so the random stream stays the original's.
 */
import { divergence } from '../../core/provenance.ts';
import type { MechEntity } from '../../generated/classes.gen.ts';

/**
 * @mw2 effect_spawn_at 0x00050fa0
 * @fidelity stub
 * @divergence Phase 3 (effects)
 */
export function effectSpawnAt(id: number, _x: number, _y: number, _z: number, _x2: number, _y2: number, _z2: number): void {
  divergence(`effect_spawn_at: effects are not ported (effect 0x${id.toString(16)})`, 'effect_spawn_at');
}

/**
 * @mw2 effect_spawn_on_mount 0x00051000
 * @fidelity stub
 * @divergence Phase 3 (effects)
 */
export function effectSpawnOnMount(id: number, _entity: MechEntity): void {
  divergence(`effect_spawn_on_mount: effects are not ported (effect 0x${id.toString(16)})`, 'effect_spawn_on_mount');
}
