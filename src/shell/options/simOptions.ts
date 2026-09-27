/**
 * MW2DIF.CFG in the shell: the 8 rule bytes (SimOptions) the options panel
 * edits and the debriefing tests (decompiled/mw2shell/src/screens/options.c).
 */
import { SHELL_LABEL } from '../../generated/shell/labels.gen.ts';
import { dosFileLoad } from '../../engine/dosFiles.ts';
import { mem, structSize } from '../memory.ts';

/**
 * Reads MW2DIF.CFG's 8 bytes into simOptions; a missing file leaves them as
 * they are (the image's defaults).
 *
 * @mw2shell sim_options_read 0x000255f0
 * @fidelity exact
 */
export function simOptionsRead(): void {
  const f = dosFileLoad('MW2DIF.CFG');
  const n = structSize('SimOptions');
  if (f && f.length >= n) mem().view(SHELL_LABEL.simOptions, n).set(f.subarray(0, n));
}
