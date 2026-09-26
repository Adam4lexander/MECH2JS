/**
 * What the mech tick hooks call that belongs to later phases - targeting
 * and the HUD's cycling (Phase 4), the AI (Phase 5). Each is called from its place in the
 * original's sequence and reports once that it did nothing, so a run shows
 * which parts of a mech's frame are still missing. A body that is ported
 * moves to its subject's module and its line here goes.
 */
import { divergence } from '../../core/provenance.ts';
import type { MechEntity } from '../../generated/classes.gen.ts';

function notYet(name: string, phase: string): void {
  divergence(`${name} is not ported yet (${phase}); the call does nothing`, name);
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
