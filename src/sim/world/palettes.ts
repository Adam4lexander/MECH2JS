/**
 * The palette slots and the palette fade's state.
 *
 * paletteResourceIds maps 20 palette slots to PAL resources; the PALG chunk
 * fills them (slots 0..15 four at a time - the day cycle's day, dawn/dusk and
 * night groups start at 0, 4 and 8 - and 0x10..0x13 individually; 0x11 is
 * the ZAPPED flash palette in every PALG of MW2.PRJ). Everything that puts a
 * palette on screen goes through a slot.
 *
 * This module is the state side only. The colour work - loading the two PAL
 * resources, building the interpolation table (clib_sub_063a70), stepping it
 * (clib_sub_063b50) and writing the VGA DAC (palette_set_entries) - belongs to
 * the renderer, which reads paletteCurrentSlot / paletteFadeTarget /
 * paletteFadeReturnTo / paletteFadeStepsLeft from here and the PAL bytes
 * through paletteSlotRgb().
 */
import { LABEL } from '../../generated/labels.gen.ts';
import { sdivShl } from '../../core/int/i64.ts';
import { divergence } from '../../core/provenance.ts';
import { clock } from '../../engine/clock.ts';
import { registerGlobals } from '../../engine/globals.ts';
import { imageI32, imageI32s } from '../../engine/image.ts';
import { cacheLoadResource, cacheUnlock } from '../../engine/resources/cache.ts';

/** paletteResourceIds' length - the 0x14 the init pass fills (label note). */
export const PALETTE_SLOT_COUNT = 20;

function bootPalettes() {
  return {
    /** 0x14fce0: the PAL resource id each slot shows */
    paletteResourceIds: Int32Array.from(imageI32s(LABEL.paletteResourceIds, PALETTE_SLOT_COUNT, new Array<number>(PALETTE_SLOT_COUNT).fill(0))),
    /** 0x9709c: the slot currently on screen; 0x10 in the image */
    paletteCurrentSlot: imageI32(LABEL.paletteCurrentSlot, 0x10),
    /** 0x970a0: set when a fade ends with no return leg; palette_apply_pending re-uploads paletteRestoreSlot */
    paletteRestorePending: imageI32(LABEL.paletteRestorePending, 0),
    /** 0x970a4: the slot effect palettes are numbered relative to (palette_fade_for_effect) */
    paletteBaseSlot: imageI32(LABEL.paletteBaseSlot, 0),
    /** 0x970a8: the slot palette_apply_pending re-uploads; 0x10 in the image */
    paletteRestoreSlot: imageI32(LABEL.paletteRestoreSlot, 0x10),
    /** 0x970ac: the slot the running fade is heading to */
    paletteFadeTarget: imageI32(LABEL.paletteFadeTarget, 0),
    /**
     * 0x970b0: the slot the running fade started from, or -1 when it started
     * from the in-between colours of a fade that was still running (the
     * renderer must then start from what is on screen)
     */
    paletteFadeReturnTo: imageI32(LABEL.paletteFadeReturnTo, 0),
    /** 0x970b4: when non-zero, a return leg of this many steps runs when the fade ends */
    paletteFadeReturnSteps: imageI32(LABEL.paletteFadeReturnSteps, 0),
    /** 0x970b8: frames left in the running fade; 0 means none */
    paletteFadeStepsLeft: imageI32(LABEL.paletteFadeStepsLeft, 0),
  };
}

export const palettes = registerGlobals('palettes', bootPalettes(), () => {
  Object.assign(palettes, bootPalettes());
});

/**
 * Points a palette slot at a PAL resource and returns the id it held. The
 * resource is loaded and unlocked at once, which only warms the cache (and
 * reports a missing resource).
 *
 * @mw2 palette_slot_set_resource 0x0003eaa0
 * @fidelity exact
 */
export function paletteSlotSetResource(resId: number, slot: number): number {
  const ids = palettes.paletteResourceIds;
  if (slot < 0 || slot >= PALETTE_SLOT_COUNT) {
    divergence('palette_slot_set_resource: a slot outside the 20-entry table writes past it in the original; ignored');
    return 0;
  }
  const old = ids[slot]!;
  ids[slot] = resId;
  cacheLoadResource(resId, 'PAL');
  cacheUnlock(resId, 'PAL');
  return old;
}

/**
 * Begins a fade from the screen's palette to `targetSlot` over `duration`
 * ticks. Mode 0 is a plain fade (and may restart one already running, from
 * its in-between colours); 1 is a there-and-back flash taking half the
 * duration each way; 2 jumps in one step and comes back over the duration.
 * A flash is refused while a fade is running. Returns 1 when it started.
 *
 * Steps: 0x14 when tickDelta is 0; otherwise ((duration << 16) / tickDelta)
 * >> 16 frames, at least 1 (a non-positive tickDelta gives 1).
 *
 * @mw2 palette_start_fade 0x0003e7d0
 * @fidelity partial
 * @divergence the state is exact; the colour interpolation table clib_sub_063a70 builds (paletteFadeState) is left to the renderer
 */
export function paletteStartFade(targetSlot: number, duration: number, mode: number): number {
  const p = palettes;
  mode &= 0xff;
  let from: number; // edi: the slot the fade starts from, -1 for the fade's own in-between colours
  let src: Uint8Array | null;
  if (p.paletteFadeStepsLeft > 0 && mode === 0) {
    from = -1;
    src = new Uint8Array(0); // stands for paletteFadeState, the running fade's colours (never null while a fade runs)
  } else if (p.paletteFadeStepsLeft <= 0) {
    from = p.paletteCurrentSlot;
    src = cacheLoadResource(p.paletteResourceIds[from]!, 'PAL');
  } else {
    return 0;
  }
  if (!src) return 0;
  const dst = cacheLoadResource(p.paletteResourceIds[targetSlot]!, 'PAL');
  let started = 0;
  if (dst) {
    p.paletteFadeTarget = targetSlot;
    p.paletteFadeReturnTo = from;
    let steps: number;
    const dt = clock.tickDelta;
    if (dt === 0) {
      steps = 0x14;
    } else {
      let d = duration | 0;
      if (mode === 1) d >>= 1;
      const q = dt > 0 ? sdivShl(d, 16, dt) : 10;
      steps = q < 0x10000 ? 1 : q >> 16;
    }
    p.paletteFadeStepsLeft = mode === 2 ? 1 : steps;
    p.paletteFadeReturnSteps = mode === 1 || mode === 2 ? steps : 0;
    started = 1;
    cacheUnlock(p.paletteResourceIds[targetSlot]!, 'PAL');
  }
  if (from !== -1) cacheUnlock(p.paletteResourceIds[from]!, 'PAL');
  return started;
}

/**
 * Advances the running fade by one frame; when it ends, the target becomes
 * the current slot and either the return leg starts or the restore is
 * flagged.
 *
 * @mw2 palette_fade_step 0x0003e760
 * @fidelity partial
 * @divergence the colour step (clib_sub_063b50) and the 0x970bc-guarded clib_sub_0639b0 call are the renderer's
 */
export function paletteFadeStep(): void {
  const p = palettes;
  if (p.paletteFadeStepsLeft !== 0) {
    p.paletteFadeStepsLeft = (p.paletteFadeStepsLeft - 1) | 0;
    if (p.paletteFadeStepsLeft === 0) {
      p.paletteCurrentSlot = p.paletteFadeTarget;
      if (p.paletteFadeReturnSteps === 0) p.paletteRestorePending = 1;
      else paletteStartFade(p.paletteFadeReturnTo, p.paletteFadeReturnSteps, 0);
    }
  }
}

/**
 * Once a fade has finished, puts paletteRestoreSlot back on screen.
 *
 * @mw2 palette_apply_pending 0x0003e6d0
 * @fidelity partial
 * @divergence palette_apply_slot's DAC upload is the renderer's; the slot change is made here
 */
export function paletteApplyPending(): void {
  const p = palettes;
  if (p.paletteRestorePending !== 0 && p.paletteFadeStepsLeft < 1) {
    p.paletteRestorePending = 0;
    p.paletteCurrentSlot = p.paletteRestoreSlot;
  }
}

/**
 * Starts the screen fade an effect asks for: its palette is numbered from
 * paletteBaseSlot.
 *
 * @mw2 palette_fade_for_effect 0x0003e950
 * @fidelity exact
 */
export function paletteFadeForEffect(palette: number, duration: number, mode: number): void {
  paletteStartFade((palette + palettes.paletteBaseSlot) | 0, duration, mode);
}

/**
 * Fades to a slot and adopts it as both the base and the restore slot.
 *
 * @mw2 palette_fade_to_new_base 0x0003eae0
 * @fidelity exact
 */
export function paletteFadeToNewBase(slot: number, duration: number): void {
  paletteStartFade(slot, duration, 0);
  palettes.paletteBaseSlot = slot;
  palettes.paletteRestoreSlot = slot;
}

/**
 * @mw2 palette_fade_steps_left 0x0003ecd0
 * @fidelity exact
 */
export function paletteFadeStepsLeft(): number {
  return palettes.paletteFadeStepsLeft;
}

/**
 * The PAL resource a slot shows, as palette_apply_slot loads it (a slot
 * holding a non-positive id has none), for the renderer.
 *
 * @portOnly the load half of palette_apply_slot, without the DAC upload
 */
export function paletteSlotRgb(slot: number): Uint8Array | null {
  const id = palettes.paletteResourceIds[slot] ?? 0;
  return id > 0 ? cacheLoadResource(id, 'PAL') : null;
}
