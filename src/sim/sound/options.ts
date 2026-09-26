/**
 * The main menu's Audio Ctrl sliders (MENU 4): Music (selector 2), Sound
 * Effects (0) and Voice (1), with 3 (cfg dword 0) and 4 (the speech bit)
 * served as well. get reads the live setting, preview changes it and plays
 * a sample, commit writes it to mw2snd.cfg's image (soundConfigBuffer) too,
 * revert takes it back from there. Opening the Music slider turns CD music
 * on and starts the mission's track, paused, so the volume can be heard as
 * soon as it is moved.
 *
 * The XMIDI sequence calls (xmidi_pause_all / _resume_all, sound_release_
 * sequences) are gated on musicXmidi, which no mission sets.
 */
import { unestablished } from '../../core/provenance.ts';
import { registerCode } from '../../engine/codePtr.ts';
import { imageI32 } from '../../engine/image.ts';
import { randomRange } from '../../core/random.ts';
import { sound, soundChannelStart } from './mixer.ts';
import { cdAudioReadyGet, cdPauseToggle, cdStop, cdVolumeApply, music, musicStartMissionTrack } from './music.ts';

const flags = (): number => sound.soundConfig[4]!;
const setFlags = (v: number) => {
  sound.soundConfig[4] = v | 0;
};

function xmidi(what: string): void {
  unestablished(`${what}: an XMIDI sequence is loaded, and the port has no sequencer`, what);
}

/** sound_pause's music half: the sequences and the CD paused, soundPaused set. */
function musicPauseOnce(): void {
  if (music.musicXmidi !== -1 && (flags() & 4) !== 0) xmidi('xmidi_pause_all');
  if (music.musicCdTrack !== -1 && (flags() & 8) !== 0) cdPauseToggle();
  music.soundPaused = 1;
}

/**
 * The Sound Effects slider's sample: SNDS 0xd2 at volume 100 scaled by
 * sfxVolumeScale, pan centre, priority 0x250, a random rate.
 *
 * @mw2 sound_preview_sfx 0x00040b10
 * @fidelity exact
 */
export function soundPreviewSfx(): void {
  const rate = imageI32(0x970d0 + randomRange(10) * 4, 11025);
  soundChannelStart(0, 0, 0xd2, null, 100, sound.soundConfig[1]!, 0x40, rate, -1, 0x250);
}

/**
 * The Voice slider's sample: SNDS 0x36 scaled by voiceVolumeScale with
 * speech on, else SNDS 0x54 at full scale.
 *
 * @mw2 sound_preview_voice 0x00042020
 * @fidelity exact
 */
export function soundPreviewVoice(): void {
  if ((flags() & 2) !== 0) soundChannelStart(0, 0, 0x36, null, 100, sound.soundConfig[2]!, 0x40, 0x2b11, -1, 0x250);
  else soundChannelStart(0, 0, 0x54, null, 100, 0x10000, 0x40, 0x2b11, -1, 0x250);
}

/**
 * menuControlGetFns[2]: 0 sfxVolumeScale, 1 voiceVolumeScale, 3 soundConfig,
 * 4 the speech bit; 2 turns CD music on, starts the mission's track and
 * pauses it (unless already paused), and returns cdVolumeScale.
 *
 * @mw2 sound_option_get 0x00043720
 * @fidelity exact
 */
export const soundOptionGet = registerCode('sound_option_get', 0x43720, (selector: number): number => {
  switch (selector) {
    case 0:
      return sound.soundConfig[1]!;
    case 1:
      return sound.soundConfig[2]!;
    case 2: {
      setFlags(flags() | 8);
      const v = sound.soundConfig[3]!;
      musicStartMissionTrack();
      if (music.soundPaused === 0) musicPauseOnce();
      return v;
    }
    case 3:
      return sound.soundConfig[0]!;
    case 4:
      return (flags() & 2) !== 0 ? 1 : 0;
    default:
      return 0;
  }
});

/**
 * menuControlPreviewFns[1]: any selector but 2 pauses the music first. 0
 * sets sfxVolumeScale and plays the effects sample on a change; 1 sets
 * voiceVolumeScale and the speech bit and plays the voice sample on a
 * change; 2 sets cdVolumeScale, resumes the music if paused and, on a
 * change, applies the CD volume; 3 sets soundConfig.
 *
 * @mw2 sound_option_preview 0x000437f0
 * @fidelity exact
 */
export const soundOptionPreview = registerCode('sound_option_preview', 0x437f0, (selector: number, value: number): void => {
  if (selector < 0 || selector >= 5) return;
  if (selector !== 2 && music.soundPaused === 0) musicPauseOnce();
  let after: (() => void) | null = null;
  switch (selector) {
    case 0: {
      const old = sound.soundConfig[1]!;
      sound.soundConfig[1] = value;
      if (old !== value) after = soundPreviewSfx;
      break;
    }
    case 1: {
      const old = sound.soundConfig[2]!;
      sound.soundConfig[2] = value;
      setFlags(value !== 0 ? flags() | 2 : flags() & ~2);
      if (old !== sound.soundConfig[2]) after = soundPreviewVoice;
      break;
    }
    case 2: {
      const old = sound.soundConfig[3]!;
      sound.soundConfig[3] = value;
      // 0x41550, the no-CD choice, is an empty function
      if (old !== value) after = cdAudioReadyGet() !== 0 ? () => void cdVolumeApply() : () => {};
      if (music.soundPaused !== 0) {
        if (music.musicXmidi !== -1 && (flags() & 4) !== 0) xmidi('xmidi_resume_all');
        if (music.musicCdTrack !== -1 && (flags() & 8) !== 0) cdPauseToggle();
        music.soundPaused = 0;
      }
      break;
    }
    case 3:
      sound.soundConfig[0] = value;
      break;
  }
  after?.();
});

/**
 * menuControlCommitFns[2]: the setting into its global and into mw2snd.cfg's
 * image; for 2, the image's music flags on (the music paused) or off (the
 * CD stopped); after 2 and 4, soundFlags reloaded from the image.
 *
 * @mw2 sound_option_commit 0x000439a0
 * @fidelity exact
 */
export const soundOptionCommit = registerCode('sound_option_commit', 0x439a0, (selector: number, value: number): void => {
  const b = sound.soundConfigBuffer!;
  switch (selector) {
    case 0:
      sound.soundConfig[1] = value;
      b[1] = value;
      return;
    case 1:
      sound.soundConfig[2] = value;
      b[2] = value;
      setFlags(value !== 0 ? flags() | 2 : flags() & ~2);
      return;
    case 2:
      sound.soundConfig[3] = value;
      b[3] = value;
      if (value !== 0) {
        b[4] = b[4]! | 0xc;
        if (music.soundPaused === 0) musicPauseOnce();
      } else {
        b[4] = b[4]! & ~0xc;
        if (music.musicCdTrack !== -1) cdStop();
        if (music.musicXmidi !== -1) xmidi('sound_release_sequences');
      }
      setFlags(b[4]!);
      return;
    case 3:
      sound.soundConfig[0] = value;
      b[0] = value;
      return;
    case 4:
      b[4] = value !== 0 ? b[4]! | 2 : b[4]! & ~2;
      setFlags(b[4]!);
      return;
  }
});

/**
 * menuControlRevertFns[1]: each setting back from mw2snd.cfg's image; the
 * music's volume re-applied and the music paused, or stopped at volume 0.
 *
 * @mw2 sound_option_revert 0x00043b10
 * @fidelity exact
 */
export const soundOptionRevert = registerCode('sound_option_revert', 0x43b10, (selector: number): void => {
  const b = sound.soundConfigBuffer!;
  switch (selector) {
    case 0:
      sound.soundConfig[1] = b[1]!;
      return;
    case 1:
      sound.soundConfig[2] = b[2]!;
      setFlags(b[2] !== 0 ? flags() | 2 : flags() & ~2);
      return;
    case 2:
      sound.soundConfig[3] = b[3]!;
      if (b[3] !== 0) {
        setFlags(flags() | 0xc);
        cdVolumeApply();
        if (music.soundPaused === 0) musicPauseOnce();
      } else {
        setFlags(flags() & ~0xc);
        if (music.musicCdTrack !== -1) cdStop();
        if (music.musicXmidi !== -1) xmidi('sound_release_sequences');
      }
      return;
    case 3:
      sound.soundConfig[0] = b[0]!;
      return;
    case 4:
      setFlags(b[4]!);
      return;
  }
});
