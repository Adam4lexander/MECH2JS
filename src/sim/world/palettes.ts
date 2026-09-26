/**
 * The palette slots, the palette fades and the DAC.
 *
 * paletteResourceIds maps 20 palette slots to PAL resources; the PALG chunk
 * fills them (slots 0..15 four at a time - the day cycle's day, dawn/dusk and
 * night groups start at 0, 4 and 8 - and 0x10..0x13 individually; 0x11 is
 * the ZAPPED flash palette in every PALG of MW2.PRJ). Everything that puts a
 * palette on screen goes through a slot.
 *
 * Colours are 6-bit (the PAL resources and the VGA DAC alike). An upload
 * (palette_set_entries) keeps the colours in paletteDac and writes them to
 * the DAC through the monitor brightness table (brightnessShown); a fade
 * (palette_start_fade) interpolates from the palette on screen to a slot's
 * over its frames, one palette_fade_state_step per frame, each an upload;
 * the two blocking fades (palette_fade_used_colours, at the start and end of
 * a mission) step the DAC itself.
 *
 * The port has no VGA DAC: `dac` stands for it - what the host shows - and
 * the blocking fades, which in the original hold the screen while they run,
 * leave their in-between DACs in `dacPlayback` for the host to show before
 * the game goes on.
 */
import { LABEL } from '../../generated/labels.gen.ts';
import { sdivShl } from '../../core/int/i64.ts';
import { unestablished } from '../../core/provenance.ts';
import { clock } from '../../engine/clock.ts';
import { registerGlobals } from '../../engine/globals.ts';
import { imageI32, imageI32s } from '../../engine/image.ts';
import { cacheLoadResource, cacheUnlock } from '../../engine/resources/cache.ts';
import type { VfxWindow } from '../../engine/vfx/vfx.ts';

/** paletteResourceIds' length - the 0x14 the init pass fills (label note). */
export const PALETTE_SLOT_COUNT = 20;

/** paletteFadeState (0x14fe0c): palette_fade_state_build's record. */
export interface PaletteFadeState {
  /** +0: the current colours (a malloc'd copy of the source), null once the fade is done */
  cur: Uint8Array | null;
  /** +4: dst - src per component, signed */
  delta: Int8Array | null;
  /** +8: the remainders, signed 16-bit */
  rem: Int16Array | null;
  /** +0xc */
  steps: number;
  /** +0x10 */
  step: number;
  /** +0x14, a byte */
  first: number;
  /** +0x15 */
  count: number;
}

/** A DAC the host shows for `waits` frames of a blocking fade. @portOnly */
export interface DacFrame {
  dac: Uint8Array;
  waits: number;
}

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
    /** 0x970b0: the slot the running fade started from, or -1 when it started from the in-between colours of a fade still running */
    paletteFadeReturnTo: imageI32(LABEL.paletteFadeReturnTo, 0),
    /** 0x970b4: when non-zero, a return leg of this many steps runs when the fade ends */
    paletteFadeReturnSteps: imageI32(LABEL.paletteFadeReturnSteps, 0),
    /** 0x970b8: frames left in the running fade; 0 means none */
    paletteFadeStepsLeft: imageI32(LABEL.paletteFadeStepsLeft, 0),
    /** 0x14fe0c */
    paletteFadeState: { cur: null, delta: null, rem: null, steps: 0, step: 0, first: 0, count: 0 } as PaletteFadeState,
    /** 0x970bc: nothing sets it (palette_cycle_step is dead) */
    paletteCycleActive: imageI32(LABEL.paletteCycleActive, 0),
    /** 0xa52d0: the palette last uploaded, before the brightness remap */
    paletteDac: new Uint8Array(0x300),
    /** 0xa02c1: palette_fade_used_colours' read-back of the DAC, stepped toward its target */
    paletteWorking: new Uint8Array(0x300),
    /** 0xa05c1 */
    paletteUsedIndices: new Uint8Array(0x100),
    /** 0xa06c1 */
    paletteFadeDelta: new Uint8Array(0x300),
    /** 0xa0fc1: seen flags, then step directions */
    paletteFadeScratch: new Uint8Array(0x300),
    /** 0xa12c1 */
    paletteFadeAccum: new Uint8Array(0x300),
    /** 0xa4ed0: 16 brightness tables of 64 (brightness_tables_build) */
    brightnessTables: new Uint8Array(16 * 64),
    /** 0x95780: the monitor brightness 0..15 (mw2snd.cfg +0x28) */
    brightness: imageI32(LABEL.brightness, 0),
    /** 0x95784: the table every upload goes through */
    brightnessShown: imageI32(0x95784, 0),
    /** @portOnly the VGA DAC: what is on screen */
    dac: new Uint8Array(0x300),
    /** @portOnly bumped at every DAC write, so the host knows to re-upload */
    dacVersion: 0,
    /** @portOnly the in-between DACs of a blocking fade, for the host to show in order */
    dacPlayback: [] as DacFrame[],
  };
}

export const palettes = registerGlobals('palettes', bootPalettes(), () => {
  const version = palettes.dacVersion;
  Object.assign(palettes, bootPalettes());
  palettes.dacVersion = version + 1;
});

/** paletteDacWrite: entry i of the DAC. @portOnly the VFX driver's DAC poke */
function dacWrite(i: number, r: number, g: number, b: number): void {
  const d = palettes.dac;
  d[i * 3] = r & 0xff;
  d[i * 3 + 1] = g & 0xff;
  d[i * 3 + 2] = b & 0xff;
  palettes.dacVersion++;
}

/**
 * Uploads a run of colours: each kept in paletteDac and written to the DAC
 * through brightnessTables[brightnessShown].
 *
 * @mw2 palette_set_entries 0x00063860
 * @fidelity exact
 */
export function paletteSetEntries(rgb: Uint8Array, first: number, count: number): void {
  const p = palettes;
  const t = p.brightnessShown * 64;
  const end = (first + count) | 0;
  let s = 0;
  for (let i = first; i < end; i++, s += 3) {
    const r = rgb[s]!;
    const g = rgb[s + 1]!;
    const b = rgb[s + 2]!;
    p.paletteDac[i * 3] = r;
    p.paletteDac[i * 3 + 1] = g;
    p.paletteDac[i * 3 + 2] = b;
    dacWrite(i, p.brightnessTables[t + r] ?? 0, p.brightnessTables[t + g] ?? 0, p.brightnessTables[t + b] ?? 0);
  }
}

/**
 * The last upload (paletteDac) written to the DAC again through brightness
 * table `level`.
 *
 * @mw2 palette_apply_brightness 0x00014e70
 * @fidelity exact
 */
export function paletteApplyBrightness(level: number): void {
  const p = palettes;
  const t = level * 64;
  for (let i = 0; i < 0x100; i++) {
    dacWrite(i, p.brightnessTables[t + p.paletteDac[i * 3]!] ?? 0, p.brightnessTables[t + p.paletteDac[i * 3 + 1]!] ?? 0, p.brightnessTables[t + p.paletteDac[i * 3 + 2]!] ?? 0);
  }
}

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
    unestablished('palette_slot_set_resource: a slot outside the 20-entry table writes past it in the original; ignored', 'palette_slot_set_resource');
    return 0;
  }
  const old = ids[slot]!;
  ids[slot] = resId;
  cacheLoadResource(resId, 'PAL');
  cacheUnlock(resId, 'PAL');
  return old;
}

/**
 * A slot's palette uploaded whole; a slot holding no resource does nothing.
 *
 * @mw2 palette_apply_slot 0x0003e710
 * @fidelity exact
 */
export function paletteApplySlot(slot: number): void {
  const id = palettes.paletteResourceIds[slot] ?? 0;
  if (0 < id) {
    const rgb = cacheLoadResource(id, 'PAL');
    if (rgb) {
      paletteSetEntries(rgb, 0, 0x100);
      cacheUnlock(id, 'PAL');
    }
  }
}

/**
 * A fade's record: the current colours (a copy of src), dst - src per
 * component, zeroed remainders, the step count. Returns 1.
 *
 * @mw2 palette_fade_state_build 0x00063a70
 * @fidelity exact
 */
export function paletteFadeStateBuild(state: PaletteFadeState, src: Uint8Array, dst: Uint8Array, first: number, count: number, steps: number): number {
  const n = count * 3;
  const cur = new Uint8Array(0x300);
  const delta = new Int8Array(0x300);
  const rem = new Int16Array(0x300);
  let k = 0;
  for (let i = first * 3; i < n + first * 3; i++, k++) {
    cur[k] = src[i]!;
    delta[k] = ((dst[i]! - src[i]!) << 24) >> 24;
    rem[k] = 0;
  }
  state.cur = cur;
  state.delta = delta;
  state.rem = rem;
  state.step = 0;
  state.first = first & 0xff;
  state.steps = steps;
  state.count = count;
  return 1;
}

/**
 * One frame of a fade: each component's remainder takes its delta, the
 * colour moves by remainder / steps (truncated), the remainder keeps the
 * rest - after `steps` frames every colour has moved by its delta - and the
 * run is uploaded. The last step drops the colours.
 *
 * @mw2 palette_fade_state_step 0x00063b50
 * @fidelity exact
 */
export function paletteFadeStateStep(state: PaletteFadeState): void {
  if (state.step >= state.steps) return;
  const cur = state.cur!;
  const n = state.count * 3;
  for (let i = 0; i < n; i++) {
    const r = ((state.rem![i]! + state.delta![i]!) << 16) >> 16;
    state.rem![i] = r;
    cur[state.first + i] = (cur[state.first + i]! + Math.trunc(r / state.steps)) & 0xff;
    state.rem![i] = r % state.steps;
  }
  paletteSetEntries(cur, state.first, state.count);
  state.step = (state.step + 1) | 0;
  if (state.steps <= state.step) {
    state.cur = null;
    state.delta = null;
    state.rem = null;
  }
}

/**
 * Begins a fade from the screen's palette to `targetSlot` over `duration`
 * ticks. Mode 0 is a plain fade (and may restart one already running, from
 * its in-between colours); 1 is a there-and-back flash taking half the
 * duration each way; 2 takes one step of the fade and comes back over the
 * duration. A flash is refused while a fade is running. Returns 1 when it
 * started.
 *
 * Steps: 0x14 when tickDelta is 0; otherwise ((duration << 16) / tickDelta)
 * >> 16 frames, at least 1 (a non-positive tickDelta gives 1).
 *
 * @mw2 palette_start_fade 0x0003e7d0
 * @fidelity exact
 */
export function paletteStartFade(targetSlot: number, duration: number, mode: number): number {
  const p = palettes;
  mode &= 0xff;
  let from: number; // edi: the slot the fade starts from, -1 for the fade's own in-between colours
  let src: Uint8Array | null;
  if (p.paletteFadeStepsLeft > 0 && mode === 0) {
    from = -1;
    src = p.paletteFadeState.cur;
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
    p.paletteFadeTarget = targetSlot;
    p.paletteFadeReturnTo = from;
    paletteFadeStateBuild(p.paletteFadeState, src, dst, 0, 0x100, steps);
    started = 1;
    cacheUnlock(p.paletteResourceIds[targetSlot]!, 'PAL');
  }
  // from -1: the old colours are freed (the new state holds its own copy)
  if (from !== -1) cacheUnlock(p.paletteResourceIds[from]!, 'PAL');
  return started;
}

/**
 * One frame of the running fade; when it ends, the target becomes the
 * current slot and either the return leg starts or the restore is flagged.
 * Then the colour cycle, which nothing turns on.
 *
 * @mw2 palette_fade_step 0x0003e760
 * @fidelity exact
 */
export function paletteFadeStep(): void {
  const p = palettes;
  if (p.paletteFadeStepsLeft !== 0) {
    paletteFadeStateStep(p.paletteFadeState);
    p.paletteFadeStepsLeft = (p.paletteFadeStepsLeft - 1) | 0;
    if (p.paletteFadeStepsLeft === 0) {
      p.paletteCurrentSlot = p.paletteFadeTarget;
      if (p.paletteFadeReturnSteps === 0) p.paletteRestorePending = 1;
      else paletteStartFade(p.paletteFadeReturnTo, p.paletteFadeReturnSteps, 0);
    }
  }
  if (p.paletteCycleActive !== 0) unestablished('palette_fade_step: paletteCycleActive is set, and palette_cycle_step is not ported', 'palette_fade_step');
}

/**
 * Once a fade has finished, uploads paletteRestoreSlot's palette exactly -
 * the fade leaves its last in-between step - and makes it current.
 *
 * @mw2 palette_apply_pending 0x0003e6d0
 * @fidelity exact
 */
export function paletteApplyPending(): void {
  const p = palettes;
  if (p.paletteRestorePending !== 0 && p.paletteFadeStepsLeft < 1) {
    p.paletteRestorePending = 0;
    paletteApplySlot(p.paletteRestoreSlot);
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
 * The blocking fade: the colours the canvas shows, read back from the DAC,
 * stepped toward `target` together (Bresenham over the largest distance),
 * each pass written to the DAC and paced so the whole fade takes `duration`
 * waits. Only those colours move.
 *
 * @mw2 palette_fade_used_colours 0x00058e0d
 * @fidelity partial
 * @divergence the port's window holds only the 2D; wherever a pixel is not drawn the GPU's 3D view shows, so when any is undrawn every colour not seen in the drawn ones counts as used, in ascending order. The waits are the host's: each pass's DAC is kept in dacPlayback with the waits that follow it
 */
export function paletteFadeUsedColours(canvas: VfxWindow, target: Uint8Array, duration: number): void {
  const p = palettes;
  const seen = p.paletteFadeScratch;
  seen.fill(0, 0, 0x100);
  let last = -1;
  const use = (b: number) => {
    seen[b] = seen[b]! | 1;
    p.paletteUsedIndices[++last] = b;
    // paletteDacRead(b, &paletteWorking[b])
    p.paletteWorking[b * 3] = p.dac[b * 3]!;
    p.paletteWorking[b * 3 + 1] = p.dac[b * 3 + 1]!;
    p.paletteWorking[b * 3 + 2] = p.dac[b * 3 + 2]!;
  };
  const n = (canvas.yMax + 1) * (canvas.xMax + 1);
  let undrawn = false;
  for (let i = 0; i < n; i++) {
    if (canvas.drawn[i] === 0) {
      undrawn = true;
      continue;
    }
    const b = canvas.buffer[i]!;
    if (seen[b] === 0) use(b);
  }
  if (undrawn) for (let b = 0; b < 0x100; b++) if (seen[b] === 0) use(b);
  const s8 = (v: number) => (v << 24) >> 24;
  let maxd = 0;
  for (let u = last; u >= 0; u--) {
    let at = p.paletteUsedIndices[u]! * 3;
    for (let k = 0; k < 3; k++, at++) {
      let d = (p.paletteWorking[at]! - target[at]!) & 0xff;
      let dir = 0xff;
      if (s8(p.paletteWorking[at]!) < s8(target[at]!)) {
        dir = 1;
        d = -d & 0xff;
      }
      p.paletteFadeScratch[at] = dir;
      p.paletteFadeDelta[at] = d;
      if (s8(d) > s8(maxd)) maxd = d;
    }
  }
  // QUIRK: the prefill covers the first last (count - 1) bytes, not each colour's three
  p.paletteFadeAccum.fill(maxd >> 1, 0, Math.max(0, last));
  if (maxd === 0) return;
  const inc = Math.floor((duration >>> 0) * 0x10000 / maxd) >>> 0;
  let pace = 0x8000;
  for (let pass = maxd; pass !== 0; pass--) {
    for (let u = last; u >= 0; u--) {
      const idx = p.paletteUsedIndices[u]!;
      const b = idx * 3;
      for (let k = 2; k >= 0; k--) {
        let a = (p.paletteFadeAccum[b + k]! + p.paletteFadeDelta[b + k]!) & 0xff;
        if (s8(a) >= s8(maxd)) {
          a = (a - maxd) & 0xff;
          p.paletteWorking[b + k] = (p.paletteWorking[b + k]! + p.paletteFadeScratch[b + k]!) & 0xff;
        }
        p.paletteFadeAccum[b + k] = a;
      }
      dacWrite(idx, p.paletteWorking[b]!, p.paletteWorking[b + 1]!, p.paletteWorking[b + 2]!);
    }
    pace = (pace + inc) >>> 0;
    const waits = (pace >>> 16) << 16 >> 16;
    if (waits >= 1) {
      p.dacPlayback.push({ dac: p.dac.slice(), waits });
      pace = pace & 0xffff;
    }
  }
}

/**
 * main's last step before the frame loop (mode 0): the screen faded to PAL
 * 1 over 0x3c waits and PAL 1 uploaded, then slot 0x10 made the current and
 * the restore slot.
 *
 * @mw2 screen_fade_in 0x0003eb10
 * @fidelity partial
 * @divergence a non-zero mode (calibration_menu_run's dissolve) is not ported
 */
export function screenFadeIn(mode: number, canvas: VfxWindow): void {
  const p = palettes;
  // QUIRK (0x3eb34): the resource id is (slot 0x10's id != -1), so PAL 1
  const id = p.paletteResourceIds[0x10] !== -1 ? 1 : 0;
  if (id !== 0) {
    const rgb = cacheLoadResource(id, 'PAL');
    if (rgb) {
      if ((mode & 0xff) === 0) {
        paletteFadeUsedColours(canvas, rgb, 0x3c);
        cacheUnlock(id, 'PAL');
        paletteSetEntries(rgb, 0, 0x100);
      } else unestablished('screen_fade_in: the dissolve (a non-zero mode) is not ported', 'screen_fade_in');
    }
  }
  p.paletteCurrentSlot = 0x10;
  p.paletteRestoreSlot = 0x10;
}

/**
 * The PAL resource a slot shows, as palette_apply_slot loads it (a slot
 * holding a non-positive id has none), for the editor.
 *
 * @portOnly the load half of palette_apply_slot, without the DAC upload
 */
export function paletteSlotRgb(slot: number): Uint8Array | null {
  const id = palettes.paletteResourceIds[slot] ?? 0;
  return id > 0 ? cacheLoadResource(id, 'PAL') : null;
}
