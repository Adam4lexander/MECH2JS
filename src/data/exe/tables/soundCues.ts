/**
 * The cockpit voice cues. sound_cue_play (0x42340) plays soundCues[cue] -
 * 12-byte {int soundId; char *text; int flag} records at 0x97a70 - and, when
 * its control argument is positive, soundCueVariants[control] (0x97a4c)
 * after it; -1 plays the cue alone and 0 plays nothing. soundId is a SNDS
 * resource id (the BETxx samples).
 *
 * Both labels are windows into ONE array of 12-byte records that starts at
 * 0x97950 (radioAddressees) and runs past 0x97c08 (damage_callout_play's
 * base, which is soundCues[34]); soundCueVariants is its three records just
 * before soundCues. sound_cue_play does not bound the index, so how many
 * records soundCues has is NOT established: SOUND_CUES_LISTED is the window
 * tools/dump_sound_triggers.py prints, not a count any code uses.
 */
import type { ExeImage } from '../ExeImage.ts';

export const SOUND_CUES = 0x97a70;
export const SOUND_CUE_VARIANTS = 0x97a4c;
export const SOUND_CUE_STRIDE = 12;
export const SOUND_CUE_VARIANT_COUNT = 3;
/** the listing's window; see the note above */
export const SOUND_CUES_LISTED = 64;

export interface SoundCue {
  soundId: number;
  text: string;
  flag: number;
}

function readCue(exe: ExeImage, addr: number): SoundCue {
  return { soundId: exe.i32(addr), text: exe.strPtr(addr + 4) ?? '', flag: exe.i32(addr + 8) };
}

/**
 * @mw2data soundCues 0x00097a70
 * @fidelity exact
 */
export function readSoundCues(exe: ExeImage, count = SOUND_CUES_LISTED): SoundCue[] {
  return Array.from({ length: count }, (_, i) => readCue(exe, SOUND_CUES + i * SOUND_CUE_STRIDE));
}

/**
 * Index 0 is never played (a control of 0 plays nothing).
 *
 * @mw2data soundCueVariants 0x00097a4c
 * @fidelity exact
 */
export function readSoundCueVariants(exe: ExeImage): SoundCue[] {
  return Array.from({ length: SOUND_CUE_VARIANT_COUNT }, (_, i) => readCue(exe, SOUND_CUE_VARIANTS + i * SOUND_CUE_STRIDE));
}
