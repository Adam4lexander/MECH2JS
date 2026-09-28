/**
 * MW2SND.CFG in the shell: the 0x3c-byte SoundConfig (soundConfig, 0x7d3d0)
 * the options panel reads, edits and writes back
 * (decompiled/mw2shell/src/screens/options.c). Nothing else in the shell
 * reads it: the three volume sliders and the detail rows change the file
 * only, for MW2.EXE (which loads it as soundConfigBuffer).
 */
import { SHELL_LABEL } from '../../generated/shell/labels.gen.ts';
import { dosFileLoad, dosFileWrite } from '../../engine/dosFiles.ts';
import { mem, structSize } from '../memory.ts';

/**
 * fopen("MW2SND.CFG", "rb") and a 0x3c-byte fread into soundConfig; a
 * missing file leaves the image's values. Nothing calls it - shell_menu's
 * COMBAT VARIABLES does the same read inline, and the port calls this for
 * that copy.
 *
 * @mw2shell sound_config_read 0x000255b0
 * @fidelity exact
 */
export function soundConfigRead(): void {
  const f = dosFileLoad('MW2SND.CFG');
  const n = structSize('SoundConfig');
  if (f) mem().view(SHELL_LABEL.soundConfig, n).set(f.subarray(0, n));
}

/**
 * fopen("MW2SND.CFG", "wb") and fwrite(&soundConfig, 0x3c, 1, f): what the
 * options panel does as it closes.
 *
 * @portOnly shell_menu's inline write (0x258e0, COMBAT VARIABLES); the function is claimed by shellMenu
 */
export function soundConfigWrite(): void {
  dosFileWrite('MW2SND.CFG', mem().view(SHELL_LABEL.soundConfig, structSize('SoundConfig')));
}
