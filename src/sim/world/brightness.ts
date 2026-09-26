/**
 * Monitor brightness: sixteen 64-entry tables (6-bit colour in, 6-bit out)
 * built at start-up, and the level mw2snd.cfg keeps (+0x28, 8 in the shipped
 * file). Only the menu's Monitor Brightness slider uses them: its preview,
 * commit and revert write the palette on screen to the DAC through a table.
 * Nothing else reads the level, so the next palette the game puts on screen
 * (a fade, a slot change) goes up without it.
 *
 * The port has no DAC: palette_apply_brightness records the level and the
 * slot it was applied over (dacBrightness), and the host shows that slot
 * remapped until the slot changes.
 */
import { registerCode } from '../../engine/codePtr.ts';
import { registerGlobals } from '../../engine/globals.ts';
import { imageI32 } from '../../engine/image.ts';
import { LABEL } from '../../generated/labels.gen.ts';
import { sound } from '../sound/mixer.ts';
import { palettes } from './palettes.ts';

export const brightnessState = registerGlobals(
  'brightness',
  {
    /** 0xa4ed0: 16 tables of 64 bytes */
    brightnessTables: new Uint8Array(16 * 64),
    /** 0x95780: the level, 0..15 */
    brightness: 0,
    /** 0x95784: the table palette_apply_brightness was last asked for */
    brightnessShown: 0,
    /** @portOnly the DAC's remap: the table and the slot it was applied over, or null */
    dacBrightness: null as { level: number; slot: number } | null,
  },
  () => {
    const b = brightnessState;
    b.brightnessTables = new Uint8Array(16 * 64);
    b.brightness = imageI32(LABEL.brightness, 0);
    b.brightnessShown = imageI32(0x95784, 0);
    b.dacBrightness = null;
  },
);

/**
 * table[level][i] = trunc(63 * pow(i * (1/63), 1 / (level * 0.0625 + 0.5))):
 * level 8 is the identity, lower levels darken, higher brighten. Computed in
 * doubles: the x87 works in 80 bits, but every entry whose value lies within
 * 1e-7 of an integer is an exact case (i = 63, or the integer exponents of
 * levels 0 and 8) where both land just above the integer, because the
 * double 1/63 (0x90064) is rounded up.
 *
 * @mw2 brightness_tables_build 0x00014d90
 * @fidelity exact
 */
export function brightnessTablesBuild(): void {
  const c = 0.015873015873015876;
  for (let l = 0; l < 16; l++) {
    const e = 1 / (l * 0.0625 + 0.5);
    for (let i = 0; i < 64; i++) brightnessState.brightnessTables[l * 64 + i] = Math.trunc(Math.pow(i * c, e) * 63) & 0xff;
  }
}

/** main: brightness = brightnessShown = mw2snd.cfg +0x28. @portOnly the line of main (0x15a30) that loads it */
export function brightnessLoad(): void {
  const cfg = sound.soundConfigBuffer;
  brightnessState.brightness = cfg ? cfg[10]! : 0;
  brightnessState.brightnessShown = brightnessState.brightness;
}

/**
 * The on-screen palette through brightness table `level` to the DAC.
 *
 * @mw2 palette_apply_brightness 0x00014e70
 * @fidelity partial
 * @divergence the port has no DAC: the level is recorded over the current slot for the host to apply (dacBrightness)
 */
export function paletteApplyBrightness(level: number): void {
  brightnessState.dacBrightness = { level, slot: palettes.paletteCurrentSlot };
}

/**
 * A 6-bit palette through the DAC's brightness remap, when one was applied
 * over the slot now showing; otherwise the palette as it is. @portOnly
 */
export function brightnessRemap(rgb: Uint8Array, slot: number): Uint8Array {
  const d = brightnessState.dacBrightness;
  if (!d || d.slot !== slot) return rgb;
  const t = brightnessState.brightnessTables.subarray(d.level * 64, d.level * 64 + 64);
  const out = new Uint8Array(rgb.length);
  for (let i = 0; i < rgb.length; i++) out[i] = t[rgb[i]! & 0x3f]!;
  return out;
}

/**
 * menuControlGetFns[16]: the slider's value, brightness * 0x1111 (15 is 1.0).
 *
 * @mw2 brightness_get 0x00019560
 * @fidelity exact
 */
export const brightnessGet = registerCode('brightness_get', 0x19560, (): number =>
  Number(BigInt.asIntN(32, (BigInt(brightnessState.brightness << 16) * 0x1111n) >> 16n)),
);

/** value * 15 in 16.16, rounded (imul, shrd, adc) */
function level15(value: number): number {
  const p = BigInt(value | 0) * 15n;
  return Number(BigInt.asIntN(32, (p >> 16n) + ((p >> 15n) & 1n)));
}

/**
 * @mw2 brightness_preview 0x000195a0
 * @fidelity exact
 */
export const brightnessPreview = registerCode('brightness_preview', 0x195a0, (_selector: number, value: number): void => {
  const l = level15(value);
  if (l !== brightnessState.brightnessShown) {
    brightnessState.brightnessShown = l;
    paletteApplyBrightness(l);
  }
});

/**
 * @mw2 brightness_commit 0x000195d0
 * @fidelity exact
 */
export const brightnessCommit = registerCode('brightness_commit', 0x195d0, (_selector: number, value: number): void => {
  const l = level15(value);
  brightnessState.brightness = l;
  brightnessState.brightnessShown = l;
  if (sound.soundConfigBuffer) sound.soundConfigBuffer[10] = l;
  paletteApplyBrightness(l);
});

/**
 * @mw2 brightness_revert 0x00019600
 * @fidelity exact
 */
export const brightnessRevert = registerCode('brightness_revert', 0x19600, (): void => {
  brightnessState.brightnessShown = brightnessState.brightness;
  paletteApplyBrightness(brightnessState.brightnessShown);
});
