/**
 * Sound calls the sim makes. The audio system is Phase 7: until then each
 * call reports once that it played nothing, so the sim's call sites stay in
 * place and in order.
 */
import { divergence } from '../../core/provenance.ts';
import { registerGlobals } from '../../engine/globals.ts';

/**
 * @mw2 sound_play 0x00040c50
 * @fidelity stub
 * @divergence Phase 7 (audio): nothing plays
 */
export function soundPlay(id: number, _volume: number, _pan: number, _priority: number, _arg5: number): void {
  divergence(`sound_play: no audio yet (sound 0x${id.toString(16)})`, 'sound_play');
}

/**
 * @mw2 sound_play_at 0x00040cf0
 * @fidelity stub
 * @divergence Phase 7 (audio): nothing plays
 */
export function soundPlayAt(_dx: number, _dy: number, _dz: number, id: number, _arg5: number): void {
  divergence(`sound_play_at: no audio yet (sound 0x${id.toString(16)})`, 'sound_play_at');
}

/**
 * @mw2 sound_cue_play 0x00042340
 * @fidelity stub
 * @divergence Phase 7 (audio): no voice cue plays
 */
export function soundCuePlay(cue: number, _variant: number): void {
  divergence(`sound_cue_play: no audio yet (cue 0x${cue.toString(16)})`, 'sound_cue_play');
}

/**
 * @mw2 sound_play_delayed 0x00040c90
 * @fidelity stub
 * @divergence Phase 7 (audio): nothing plays
 */
export function soundPlayDelayed(_a: number, _b: number, id: number, _volume: number, _pan: number, _arg6: number): void {
  divergence(`sound_play_delayed: no audio yet (sound 0x${id.toString(16)})`, 'sound_play_delayed');
}

/**
 * Queues damageCallouts[id] (0x97c08, 12-byte entries) on the voice
 * channel's sequence queue - the cockpit's "weapon destroyed" style lines.
 *
 * @mw2 damage_callout_play 0x00042390
 * @fidelity stub
 * @divergence Phase 7 (audio): sound_seq_queue_message is not ported; no callout plays
 */
export function damageCalloutPlay(id: number): void {
  divergence(`damage_callout_play: no audio yet (callout ${id})`, 'damage_callout_play');
}

/**
 * Queues lanceRadioMessages[message] (0x97974) addressed to
 * radioAddressees[addressee] (0x97950; -1 for none); messages -1 and 11 up
 * are ignored.
 *
 * @mw2 radio_lance_message 0x000422a0
 * @fidelity stub
 * @divergence Phase 7 (audio): sound_seq_queue_message is not ported; no radio message plays
 */
export function radioLanceMessage(message: number, _addressee: number): void {
  if (message === -1 || message >= 0xb) return;
  divergence(`radio_lance_message: no audio yet (message ${message})`, 'radio_lance_message');
}

/**
 * @mw2 engine_note_start 0x00041570
 * @fidelity stub
 * @divergence Phase 7 (audio): no engine note
 */
export function engineNoteStart(): void {
  divergence('engine_note_start: no audio yet', 'engine_note_start');
}

/**
 * @mw2 engine_note_update 0x000416b0
 * @fidelity stub
 * @divergence Phase 7 (audio): no engine note
 */
export function engineNoteUpdate(): void {
  divergence('engine_note_update: no audio yet', 'engine_note_update');
}

/**
 * @mw2 engine_note_stop 0x00041760
 * @fidelity stub
 * @divergence Phase 7 (audio): no engine note
 */
export function engineNoteStop(): void {
  divergence('engine_note_stop: no audio yet', 'engine_note_stop');
}

/**
 * @mw2 engine_note_mute 0x000417c0
 * @fidelity stub
 * @divergence Phase 7 (audio): no engine note
 */
export function engineNoteMute(): void {
  divergence('engine_note_mute: no audio yet', 'engine_note_mute');
}

/**
 * The voice channel's sequencer state: 0x97ddc, the message playing now
 * (null when none). The sequencer is Phase 7, so nothing ever plays.
 */
export const soundSeq = registerGlobals('soundSeq', { currentMessage: null as unknown }, () => {
  soundSeq.currentMessage = null;
});

/** The {sound id, text, sfl} block the mission-result announcers queue. @portOnly */
export interface SoundSeqMessage {
  sound: number;
  text: string;
  sfl: Uint8Array | null;
}

/**
 * Queues a {sound, text, sfl} block as sequence message 0x50
 * (sound_seq_queue_message) - the objective and mission result
 * announcements.
 *
 * @mw2 sound_seq_sub_0423d0 0x000423d0
 * @fidelity stub
 * @divergence Phase 7 (audio): sound_seq_queue_message is not ported; the announcement is logged, not played
 */
export function soundSeqSub0423d0(m: SoundSeqMessage): void {
  divergence(`sound_seq_sub_0423d0: no audio yet (sound ${m.sound}, "${m.text}")`, 'sound_seq_sub_0423d0');
}

/**
 * Called every frame by mission_results_update once the player's table is
 * decided, with 1.
 *
 * @mw2 sound_seq_sub_042080 0x00042080
 * @fidelity stub
 * @divergence Phase 7 (audio): the sequencer is not ported
 */
export function soundSeqSub042080(_arg: number): void {
  divergence('sound_seq_sub_042080: the sound sequencer is not ported yet', 'sound_seq_sub_042080');
}
