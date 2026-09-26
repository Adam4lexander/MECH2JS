/**
 * The game's text log: log_write prints a line to logStream when logEnabled
 * is set. The port sends the line to the log sink (channel 'mw2log').
 */
import { log } from '../core/log.ts';
import { LABEL } from '../generated/labels.gen.ts';
import { registerGlobals } from './globals.ts';
import { imageI32 } from './image.ts';

export const logGlobals = registerGlobals(
  'logWrite',
  {
    /** 0x9e8ec: gates log_write */
    logEnabled: 0,
  },
  () => {
    logGlobals.logEnabled = imageI32(LABEL.logEnabled, 0);
  },
);

/**
 * fprintf(logStream, "%s", text) when logging is on; returns 1 if written.
 *
 * @mw2 log_write 0x00049fa0
 * @fidelity partial
 * @divergence logStream (0x9e8f0, the FILE* log_open fills) is not modelled: the line goes to the log sink whenever logEnabled is set
 */
export function logWrite(text: string): number {
  if (logGlobals.logEnabled !== 0) {
    log('mw2log', text.replace(/\n$/, ''));
    return 1;
  }
  return 0;
}
