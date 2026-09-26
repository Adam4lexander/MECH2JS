/**
 * Steps of main's frame loop whose bodies belong to later phases. Each is
 * called in its place by mission/mainLoop.ts and reports once, through
 * divergence(), that it did nothing - so a run shows exactly which parts of
 * the original frame are missing. When a body is ported it moves to its
 * subject's module and its line here goes.
 */
import { divergence } from '../core/provenance.ts';

function notYet(name: string, phase: string): void {
  divergence(`${name} is not ported yet (${phase}); the step does nothing`, name);
}

/**
 * @mw2 mission_results_update 0x00016e80
 * @fidelity stub
 * @divergence Phase 6 (mission runtime)
 */
export function missionResultsUpdate(): void {
  notYet('mission_results_update', 'Phase 6');
}

/**
 * Refills the streaming sound buffers and, every 0x38e ticks, sounds the
 * missile-lock warning when an enemy has the player targeted.
 *
 * @mw2 sound_config_sub_043e50 0x00043e50
 * @fidelity stub
 * @divergence Phase 7 (audio)
 */
export function soundConfigSub043e50(): void {
  notYet('sound_config_sub_043e50', 'Phase 7');
}

/**
 * @mw2 sound_seq_sub_041dd0 0x00041dd0
 * @fidelity stub
 * @divergence Phase 7 (audio): the sound sequence queue does not advance
 */
export function soundSeqSub041dd0(): void {
  notYet('sound_seq_sub_041dd0', 'Phase 7');
}

/**
 * @mw2 sound_config_sub_043dd0 0x00043dd0
 * @fidelity stub
 * @divergence Phase 7 (audio): CD music is not restarted
 */
export function soundConfigSub043dd0(): void {
  notYet('sound_config_sub_043dd0', 'Phase 7');
}
