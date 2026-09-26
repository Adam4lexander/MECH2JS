/**
 * The cockpit message line. Phase 4 (HUD) draws it; until then a posted
 * message goes to the log.
 */
import { log } from '../../core/log.ts';

/**
 * @mw2 message_post 0x00011020
 * @fidelity stub
 * @divergence Phase 4 (HUD): the text is logged, not shown
 */
export function messagePost(text: string, _priority: number, ticks: number): void {
  log('message', `${text} (${ticks} ticks)`);
}
