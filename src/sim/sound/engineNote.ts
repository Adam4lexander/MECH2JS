/**
 * The MIDI side: the driver midi_open brings up, and the one thing the game
 * plays on it in a mission - THE ENGINE NOTE, a held D2 (key 38) on MIDI
 * bank 0 program 3 whose pitch bend follows the throttle. The XMIDI sequence
 * slots (0x150070) are reset here but nothing in a mission loads one: every
 * MUS resource's second number is 0, and the options menu that could is not
 * ported.
 *
 * What the note sounds like is NOT established: the instrument is the MIDI
 * driver's own program 3 (an FM bank on the SBPRO2.MDI the install's mdi.ini
 * names), and no timbre file ships. The port sends the same channel messages
 * to the host, whose synth is a stand-in.
 */
import { ailInstallMdiDriverFile, ailInstallTimbre, ailLockChannel, ailProtectTimbre, ailReleaseChannel, ailSendChannelVoiceMessage } from '../../engine/miles/ail.ts';
import { registerGlobals } from '../../engine/globals.ts';
import { imageI32, imageU8 } from '../../engine/image.ts';
import { mechs } from '../mech/mechGlobals.ts';
import { sfxVolumeScale } from './mixer.ts';

export const midi = registerGlobals(
  'midi',
  {
    /** 0x97100: the MDI driver, 0 without one */
    midiDriver: 0,
    /** 0x97108: midi_open succeeded */
    midiReady: 0,
    /** 0x97104: the sequences are released for good (midi_close) */
    sequencesClosed: 0,
    /** 0x970fc, a signed byte: the channel engine_note_start locked (0-based), -1 none */
    engineChannel: -1,
    /** 0x150070: the eight XMIDI sequence handles, -1 empty */
    sequenceHandles: new Int32Array(8).fill(-1),
  },
  () => {
    midi.midiDriver = imageI32(0x97100, 0);
    midi.midiReady = imageI32(0x97108, 0);
    midi.sequencesClosed = imageI32(0x97104, 0);
    midi.engineChannel = (imageU8(0x970fc, 0xff) << 24) >> 24;
    midi.sequenceHandles.fill(0);
  },
);

/**
 * sound_open_driver_ini(1): the MDI driver mdi.ini names.
 *
 * @mw2 sound_install_mdi_driver 0x00044030
 * @fidelity partial
 * @divergence no mdi.ini is read: the port's Miles layer has its one driver
 */
export function soundInstallMdiDriver(): number {
  return ailInstallMdiDriverFile();
}

/**
 * Opens the MIDI driver, resets the eight sequence slots and sets midiReady.
 * Returns 1, -1 when already open, -5 without a driver.
 *
 * @mw2 midi_open 0x00041260
 * @fidelity partial
 * @divergence sound_seq_sub_0414e0 (the sequences' volume, none of which exist yet) is not ported
 */
export function midiOpen(): number {
  if (midi.midiReady !== 0) return -1;
  midi.sequenceHandles.fill(-1);
  midi.midiDriver = soundInstallMdiDriver();
  if (midi.midiDriver === 0) return -5;
  midi.midiReady = 1;
  return 1;
}

/**
 * Releases the sequences for good and clears midiReady.
 *
 * @mw2 midi_close 0x00041440
 * @fidelity partial
 * @divergence sound_release_sequences has nothing to release (no sequence is ever loaded in a mission)
 */
export function midiClose(): void {
  if (midi.midiReady === 0) return;
  midi.sequencesClosed = 1;
  midi.midiReady = 0;
}

/**
 * While the player's mech powers up: installs and protects timbre bank 0
 * patch 3, locks a channel and sends B0 72 00, C0 03, E0 00 30, B0 0A 40,
 * B0 07 00, 90 26 7F - one held note, silent until engine_note_update.
 *
 * @mw2 engine_note_start 0x00041570
 * @fidelity exact
 */
export function engineNoteStart(): void {
  if (midi.midiDriver === 0 || 0 <= midi.engineChannel || midi.midiReady === 0) return;
  if (ailInstallTimbre(0, 3) === 0) return;
  ailProtectTimbre(0, 3);
  const locked = (ailLockChannel() << 24) >> 24;
  midi.engineChannel = locked;
  if (locked === 0) return;
  const c = (midi.engineChannel = (locked - 1) | 0);
  ailSendChannelVoiceMessage(0xb0 | c, 0x72, 0);
  ailSendChannelVoiceMessage(0xc0 | c, 3, 0);
  ailSendChannelVoiceMessage(0xe0 | c, 0, 0x30);
  ailSendChannelVoiceMessage(0xb0 | c, 0x0a, 0x40);
  ailSendChannelVoiceMessage(0xb0 | c, 0x07, 0);
  ailSendChannelVoiceMessage(0x90 | c, 0x26, 0x7f);
}

/**
 * Each frame the player's mech runs: pitch bend x = 0x2000 + 4 * throttle,
 * sent as LSB x & 0x7f and MSB (x & 0x3f00) >> 8 - which drops bit 7 and
 * halves the bend, so the note rises by half the bend range from neutral
 * (6144) toward full throttle (about 8188) - then volume CC7 =
 * round(sfxVolumeScale * 100) & 0xff.
 *
 * @mw2 engine_note_update 0x000416b0
 * @fidelity exact
 */
export function engineNoteUpdate(throttle: number): void {
  if (midi.midiDriver === 0 || midi.engineChannel < 0) return;
  if (mechs.mechTable[mechs.playerMechIndex]!.loadout!.status <= 1) return;
  const x = (Math.imul(throttle, 4) + 0x2000) | 0;
  ailSendChannelVoiceMessage(0xe0 | midi.engineChannel, x & 0x7f, (x & 0x3f00) >> 8);
  const p = BigInt(sfxVolumeScale()) * 100n;
  const vol = Number(BigInt.asIntN(32, (p >> 16n) + ((p >> 15n) & 1n))) & 0xff;
  ailSendChannelVoiceMessage(0xb0 | midi.engineChannel, 7, vol);
}

/**
 * Note off for key 38 and the channel released, every frame the player's
 * mech is neither powering up nor running.
 *
 * @mw2 engine_note_stop 0x00041760
 * @fidelity exact
 */
export function engineNoteStop(): void {
  if (midi.midiDriver === 0 || midi.engineChannel < 0) return;
  ailSendChannelVoiceMessage(0x80 | midi.engineChannel, 0x26, 0x7f);
  ailReleaseChannel(midi.engineChannel + 1);
  midi.engineChannel = -1;
}

/**
 * B0 07 00 - volume 0 on the engine channel; every frame outside the
 * cockpit view, so the engine is heard only from the cockpit.
 *
 * @mw2 engine_note_mute 0x000417c0
 * @fidelity exact
 */
export function engineNoteMute(): void {
  if (midi.midiDriver === 0 || midi.engineChannel < 0) return;
  ailSendChannelVoiceMessage(0xb0 | midi.engineChannel, 7, 0);
}
