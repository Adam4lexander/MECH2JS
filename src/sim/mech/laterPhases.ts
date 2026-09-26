/**
 * What the mech tick hooks call that belongs to later phases - weapons,
 * damage and destruction (Phase 3), targeting and the HUD's cycling
 * (Phase 4), the AI (Phase 5). Each is called from its place in the
 * original's sequence and reports once that it did nothing, so a run shows
 * which parts of a mech's frame are still missing. A body that is ported
 * moves to its subject's module and its line here goes.
 */
import { divergence } from '../../core/provenance.ts';
import type { MechEntity, MechLoadout } from '../../generated/classes.gen.ts';

function notYet(name: string, phase: string): void {
  divergence(`${name} is not ported yet (${phase}); the call does nothing`, name);
}

/**
 * @mw2 mech_weapons_tick 0x00052080
 * @fidelity stub
 * @divergence Phase 3 (weapons): no weapon fires or recycles
 */
export function mechWeaponsTick(_l: MechLoadout): void {
  notYet('mech_weapons_tick', 'Phase 3');
}

/**
 * @mw2 mech_update_missile_lock 0x00052ea0
 * @fidelity stub
 * @divergence Phase 3 (weapons): no missile lock; it would also move stateTimer (see mech_heat_update's note)
 */
export function mechUpdateMissileLock(_l: MechLoadout): void {
  notYet('mech_update_missile_lock', 'Phase 3');
}

/**
 * @mw2 weapon_cycle_next 0x00052950
 * @fidelity stub
 * @divergence Phase 3 (weapons)
 */
export function weaponCycleNext(_l: MechLoadout): void {
  notYet('weapon_cycle_next', 'Phase 3');
}

/**
 * @mw2 weapon_cycle_group 0x00052c90
 * @fidelity stub
 * @divergence Phase 3 (weapons)
 */
export function weaponCycleGroup(): void {
  notYet('weapon_cycle_group', 'Phase 3');
}

/**
 * @mw2 weapon_jettison_ammo 0x00052b20
 * @fidelity stub
 * @divergence Phase 3 (weapons)
 */
export function weaponJettisonAmmo(_l: MechLoadout): void {
  notYet('weapon_jettison_ammo', 'Phase 3');
}

/**
 * @mw2 mech_damage_slot 0x00025960
 * @fidelity stub
 * @divergence Phase 3 (damage)
 */
export function mechDamageSlot(_l: MechLoadout, _location: number, _slot: number, _arg: number): void {
  notYet('mech_damage_slot', 'Phase 3');
}

/**
 * @mw2 mech_apply_damage 0x00026270
 * @fidelity stub
 * @divergence Phase 3 (damage): fall damage is not applied
 */
export function mechApplyDamage(_l: MechLoadout, _points: number, _location: number): void {
  notYet('mech_apply_damage', 'Phase 3');
}

/**
 * @mw2 mech_collision_damage 0x00020890
 * @fidelity stub
 * @divergence Phase 3 (damage): walking into a mech does no damage
 */
export function mechCollisionDamage(_l: MechLoadout, _other: MechLoadout | null): void {
  notYet('mech_collision_damage', 'Phase 3');
}

/**
 * @mw2 obstacle_collision_damage 0x00020a50
 * @fidelity stub
 * @divergence Phase 3 (damage): walking into scenery does no damage
 */
export function obstacleCollisionDamage(_l: MechLoadout, _object: unknown): void {
  notYet('obstacle_collision_damage', 'Phase 3');
}

/**
 * @mw2 mech_on_destroyed 0x00025340
 * @fidelity stub
 * @divergence Phase 3 (destruction)
 */
export function mechOnDestroyed(_l: MechLoadout): void {
  notYet('mech_on_destroyed', 'Phase 3');
}

/**
 * @mw2 mech_eject 0x000265f0
 * @fidelity stub
 * @divergence Phase 3 (destruction): self-destruct and ejection do nothing
 */
export function mechEject(_l: MechLoadout, _arg: number): void {
  notYet('mech_eject', 'Phase 3');
}

/**
 * @mw2 ai_cycle_navpoint 0x0002ac10
 * @fidelity stub
 * @divergence Phase 4 (navigation and targeting)
 */
export function aiCycleNavpoint(_e: MechEntity, _dir: number, _arg: number): void {
  notYet('ai_cycle_navpoint', 'Phase 4');
}

/**
 * @mw2 ai_cycle_target 0x00029e90
 * @fidelity stub
 * @divergence Phase 4 (targeting)
 */
export function aiCycleTarget(_e: MechEntity, _dir: number, _mask: number): void {
  notYet('ai_cycle_target', 'Phase 4');
}

/**
 * @mw2 ai_target_nearest_enemy 0x0002acf0
 * @fidelity stub
 * @divergence Phase 4 (targeting)
 */
export function aiTargetNearestEnemy(): void {
  notYet('ai_target_nearest_enemy', 'Phase 4');
}

/**
 * @mw2 ai_cycle_friendly 0x0002ac90
 * @fidelity stub
 * @divergence Phase 4 (targeting)
 */
export function aiCycleFriendly(_dir: number): void {
  notYet('ai_cycle_friendly', 'Phase 4');
}

/**
 * @mw2 ai_cycle_gamething 0x0002ac30
 * @fidelity stub
 * @divergence Phase 4 (targeting)
 */
export function aiCycleGamething(_dir: number): void {
  notYet('ai_cycle_gamething', 'Phase 4');
}

/**
 * @mw2 ai_cycle_gamepiece 0x0002ac60
 * @fidelity stub
 * @divergence Phase 4 (targeting)
 */
export function aiCycleGamepiece(_dir: number): void {
  notYet('ai_cycle_gamepiece', 'Phase 4');
}

/**
 * @mw2 player_target_reticle 0x0002aa40
 * @fidelity stub
 * @divergence Phase 4 (targeting)
 */
export function playerTargetReticle(): void {
  notYet('player_target_reticle', 'Phase 4');
}

/**
 * @mw2 ai_validate_current_target 0x0002a670
 * @fidelity stub
 * @divergence Phase 4 (targeting)
 */
export function aiValidateCurrentTarget(_e: MechEntity): void {
  notYet('ai_validate_current_target', 'Phase 4');
}

/**
 * @mw2 group_assign_objective_task 0x00024250
 * @fidelity stub
 * @divergence Phase 5 (AI)
 */
export function groupAssignObjectiveTask(_group: number): void {
  notYet('group_assign_objective_task', 'Phase 5');
}

/**
 * @mw2 ai_rules_run 0x000215f0
 * @fidelity stub
 * @divergence Phase 5 (AI): no rule fires, so the state handler runs
 */
export function aiRulesRun(_e: MechEntity): number {
  notYet('ai_rules_run', 'Phase 5');
  return 0;
}
