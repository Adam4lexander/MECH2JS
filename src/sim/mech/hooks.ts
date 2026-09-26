/**
 * The per-mech hook drivers main calls: each walks mechTable and calls one
 * MechEntity.hooks slot. The registers carry the arguments (read from the
 * disassembly - the decompiled calls show none for slots 0 and 1):
 *
 *   slot 0  (entity, index)  EAX = mechTable[i], EDX = i - the create hooks
 *   slot 1  (loadout, index) EAX = entity->loadout, EDX = i
 *   slot 2  (loadout, index)
 *   slot 3  (loadout)        the player's mech only
 *   slot 4  (loadout)        the player's mech only
 *   slot 5  (loadout, index) called even when the loadout is null
 *
 * Slots 0..2 skip a mech with no loadout. The index is in EDX, which each
 * hook preserves (Watcom's callee-saved convention), so the loop counter is
 * what the hook sees.
 */
import { mechs } from './mechGlobals.ts';

/**
 * @mw2 mech_dispatch_hook0 0x000247c0
 * @fidelity exact
 */
export function mechDispatchHook0(): void {
  const m = mechs;
  for (let i = 0; i < m.mechCount; i++) {
    const e = m.mechTable[i]!;
    const h = e.hooks[0];
    if (h && e.loadout) h(e, i);
  }
}

/**
 * @mw2 mech_dispatch_hook1 0x00024810
 * @fidelity exact
 */
export function mechDispatchHook1(): void {
  const m = mechs;
  for (let i = 0; i < m.mechCount; i++) {
    const e = m.mechTable[i]!;
    const h = e.hooks[1];
    const l = e.loadout;
    if (h && l) h(l, i);
  }
}

/**
 * @mw2 mech_dispatch_hook2 0x00024860
 * @fidelity exact
 */
export function mechDispatchHook2(): void {
  const m = mechs;
  for (let i = 0; i < m.mechCount; i++) {
    const e = m.mechTable[i]!;
    const h = e.hooks[2];
    const l = e.loadout;
    if (h && l) h(l, i);
  }
}

/**
 * @mw2 mech_dispatch_hook3 0x000248b0
 * @fidelity exact
 */
export function mechDispatchHook3(): void {
  const e = mechs.mechTable[mechs.playerMechIndex];
  if (e && e.hooks[3] && e.loadout) e.hooks[3](e.loadout);
}

/**
 * @mw2 mech_dispatch_hook4 0x000248f0
 * @fidelity exact
 */
export function mechDispatchHook4(): void {
  const e = mechs.mechTable[mechs.playerMechIndex];
  if (e && e.hooks[4] && e.loadout) e.hooks[4](e.loadout);
}

/**
 * @mw2 mech_dispatch_hook5 0x00024930
 * @fidelity exact
 */
export function mechDispatchHook5(): void {
  const m = mechs;
  for (let i = 0; i < m.mechCount; i++) {
    const e = m.mechTable[i]!;
    const h = e.hooks[5];
    if (h) h(e.loadout, i);
  }
}
