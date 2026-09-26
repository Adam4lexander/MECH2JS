/**
 * Monitor brightness: sixteen 64-entry tables (6-bit colour in, 6-bit out)
 * built at start-up, the level mw2snd.cfg keeps (+0x28, 8 in the shipped
 * file - the identity table), and the menu's Monitor Brightness slider.
 * Every palette upload goes through table brightnessShown on its way to the
 * DAC (palette_set_entries), so the level holds for every palette after it;
 * the slider's preview, commit and revert re-send the last upload through
 * the new table (palette_apply_brightness). The state is in palettes.ts.
 */
import { registerCode } from '../../engine/codePtr.ts';
import { sound } from '../sound/mixer.ts';
import { paletteApplyBrightness, palettes } from './palettes.ts';

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
    for (let i = 0; i < 64; i++) palettes.brightnessTables[l * 64 + i] = Math.trunc(Math.pow(i * c, e) * 63) & 0xff;
  }
}

/** main: brightness = brightnessShown = mw2snd.cfg +0x28. @portOnly the line of main (0x15a30) that loads it */
export function brightnessLoad(): void {
  const cfg = sound.soundConfigBuffer;
  palettes.brightness = cfg ? cfg[10]! : 0;
  palettes.brightnessShown = palettes.brightness;
}

/**
 * menuControlGetFns[16]: the slider's value, brightness * 0x1111 (15 is 1.0).
 *
 * @mw2 brightness_get 0x00019560
 * @fidelity exact
 */
export const brightnessGet = registerCode('brightness_get', 0x19560, (): number =>
  Number(BigInt.asIntN(32, (BigInt(palettes.brightness << 16) * 0x1111n) >> 16n)),
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
  if (l !== palettes.brightnessShown) {
    palettes.brightnessShown = l;
    paletteApplyBrightness(l);
  }
});

/**
 * @mw2 brightness_commit 0x000195d0
 * @fidelity exact
 */
export const brightnessCommit = registerCode('brightness_commit', 0x195d0, (_selector: number, value: number): void => {
  const l = level15(value);
  palettes.brightness = l;
  palettes.brightnessShown = l;
  if (sound.soundConfigBuffer) sound.soundConfigBuffer[10] = l;
  paletteApplyBrightness(l);
});

/**
 * @mw2 brightness_revert 0x00019600
 * @fidelity exact
 */
export const brightnessRevert = registerCode('brightness_revert', 0x19600, (): void => {
  palettes.brightnessShown = palettes.brightness;
  paletteApplyBrightness(palettes.brightnessShown);
});
