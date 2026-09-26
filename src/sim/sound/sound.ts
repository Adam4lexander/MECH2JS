/**
 * Sound calls the sim makes. The audio system is Phase 7: until then each
 * call reports once that it played nothing, so the sim's call sites stay in
 * place and in order.
 */
import { divergence } from '../../core/provenance.ts';

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
