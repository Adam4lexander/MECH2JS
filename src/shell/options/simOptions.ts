/**
 * MW2DIF.CFG in the shell: the 8 rule bytes (SimOptions) the options panel
 * edits and the debriefing tests (decompiled/mw2shell/src/screens/options.c).
 */
import { SHELL_LABEL } from '../../generated/shell/labels.gen.ts';
import { dosFileLoad, dosFileWrite } from '../../engine/dosFiles.ts';
import { mem, structSize } from '../memory.ts';

/**
 * Reads MW2DIF.CFG's 8 bytes into simOptions; a missing file leaves them as
 * they are (the image's defaults: 0, 0, 1, 1, 1, 1 - full rules, MEDIUM).
 * fread(&simOptions, 8, 1, f): a shorter file's bytes still land, the rest
 * is left as it was.
 *
 * @mw2shell sim_options_read 0x000255f0
 * @fidelity exact
 */
export function simOptionsRead(): void {
  const f = dosFileLoad('MW2DIF.CFG');
  const n = structSize('SimOptions');
  if (f) mem().view(SHELL_LABEL.simOptions, n).set(f.subarray(0, n));
}

/**
 * fopen("MW2DIF.CFG", "wb") and fwrite(&simOptions, 8, 1, f): what the
 * options panel does as it closes.
 *
 * @portOnly shell_menu's inline write (0x258e0, COMBAT VARIABLES); the function is claimed by shellMenu
 */
export function simOptionsWrite(): void {
  dosFileWrite('MW2DIF.CFG', mem().view(SHELL_LABEL.simOptions, structSize('SimOptions')));
}
