/**
 * Netplay. Out of scope for the port beyond what a single-player frame runs.
 */
import { unestablished } from '../../core/provenance.ts';
import { LABEL } from '../../generated/labels.gen.ts';
import { registerGlobals } from '../../engine/globals.ts';
import { imageI32 } from '../../engine/image.ts';

export const net = registerGlobals(
  'net',
  {
    /** 0x982d8: 1 while a network session runs */
    netSessionState: 0,
    /** 0x982dc: 0 single player; set in a network game (2 a client - see netplay_frame_exchange) */
    netRole: 0,
  },
  () => {
    net.netSessionState = imageI32(LABEL.netSessionState, 0);
    net.netRole = imageI32(LABEL.netRole, 0);
  },
);

/**
 * The per-frame network exchange. Outside a running session
 * (netSessionState != 1) it returns at once, which is every single-player
 * frame.
 *
 * @mw2 netplay_frame_exchange 0x00044720
 * @fidelity partial
 * @divergence netplay is out of scope: only the single-player early return is ported
 */
export function netplayFrameExchange(): number {
  if (net.netSessionState !== 1) return 1;
  unestablished('a network session is running, and netplay is not ported', 'netplay_frame_exchange');
  return 1;
}
