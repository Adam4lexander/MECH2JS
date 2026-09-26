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
