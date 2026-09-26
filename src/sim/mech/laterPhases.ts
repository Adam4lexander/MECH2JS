/**
 * What the mech tick hooks call that belongs to later phases - the AI
 * (Phase 5). Each is called from its place in the
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
