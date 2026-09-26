/**
 * The per-tick hooks the gamepiece classes point at (MechEntity.hooks[1..5]).
 * They are registered here so gamepieceClasses() resolves every address in
 * the table; their bodies are Phase 2 (movement, AI, cockpit), except the
 * two that are genuinely empty in MW2.EXE.
 *
 * Slot arguments are the drivers' (sim/mech/hooks.ts): (loadout, index) for
 * slots 1, 2 and 5, (loadout) for 3 and 4.
 */
import type { MechLoadout } from '../../generated/classes.gen.ts';
import { registerCode } from '../../engine/codePtr.ts';
import { playerCockpitFrame, playerCockpitRelease } from '../cockpit/hud.ts';
import { mechs } from './mechGlobals.ts';
// hook slots 1, 2 and 3 of the standard class live with their bodies
import './mechTickAi.ts';
import './mechTickTerrain.ts';

/**
 * Hook 4 of the standard classes (the player's mech only): player_cockpit_frame
 * when the loadout is non-null.
 *
 * @mw2 mech_std_cockpit 0x00028660
 * @fidelity exact
 */
export const mechStdCockpit = registerCode('mech_std_cockpit', 0x28660, (l: MechLoadout | null): void => {
  if (l) playerCockpitFrame(l);
});

/**
 * Hook 5 of the standard classes, once after the mission loop: for the
 * player's mech, player_cockpit_release.
 *
 * @mw2 mech_std_cockpit_release 0x00028670
 * @fidelity exact
 */
export const mechStdCockpitRelease = registerCode('mech_std_cockpit_release', 0x28670, (l: MechLoadout | null, _index: number): void => {
  if (l && mechs.playerMechIndex === l.entity!.index) playerCockpitRelease();
});

/**
 * Hook 1 of class 3.
 *
 * @mw2 mech_alt_tick_terrain 0x0002ec80
 * @fidelity stub
 * @divergence Phase 2: does nothing
 */
export const mechAltTickTerrain = registerCode('mech_alt_tick_terrain', 0x2ec80, (_l: MechLoadout, _index: number): void => {});

/**
 * Hook 2 of class 3.
 *
 * @mw2 mech_alt_tick_ai 0x0002ed20
 * @fidelity stub
 * @divergence Phase 2: does nothing
 */
export const mechAltTickAi = registerCode('mech_alt_tick_ai', 0x2ed20, (_l: MechLoadout, _index: number): void => {});

/**
 * Hook 5 of class 3: push ebp / mov ebp, esp / test eax, eax / pop ebp / ret -
 * nothing.
 *
 * @mw2 mech_alt_hook5 0x0002ef20
 * @fidelity exact
 */
export const mechAltHook5 = registerCode('mech_alt_hook5', 0x2ef20, (_l: MechLoadout | null, _index: number): void => {});

/**
 * Hook 1 of the door class: steps the three position ramps while status is 2.
 *
 * @mw2 door_tick_move 0x000332f0
 * @fidelity stub
 * @divergence Phase 2: does nothing
 */
export const doorTickMove = registerCode('door_tick_move', 0x332f0, (_l: MechLoadout, _index: number): void => {});

/**
 * Hook 2 of the door class: thinks and aims the position ramps.
 *
 * @mw2 door_tick_ai 0x000333c0
 * @fidelity stub
 * @divergence Phase 2: does nothing
 */
export const doorTickAi = registerCode('door_tick_ai', 0x333c0, (_l: MechLoadout, _index: number): void => {});

/**
 * Hook 5 of the door class: the same seven empty bytes as mech_alt_hook5.
 *
 * @mw2 door_hook5_nop 0x00033620
 * @fidelity exact
 */
export const doorHook5Nop = registerCode('door_hook5_nop', 0x33620, (_l: MechLoadout | null, _index: number): void => {});
