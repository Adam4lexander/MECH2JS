/**
 * The cheat codes. They are stored XOR 0x1a; cheat_match walks a stored code
 * and the keystroke ring backwards comparing *key == (*code ^ 0x1a), so the
 * plain text never appears in the executable.
 *
 * The addresses are the 21 cheat_match arguments in cheat_handle_command
 * (0x45780), in its call order - never a scan of the data, which splices
 * neighbouring strings across their alignment padding ("tloflygirl").
 */
import type { ExeImage } from '../ExeImage.ts';

export const CHEAT_XOR = 0x1a;

/** cheat_handle_command's cheat_match arguments. */
export const CHEAT_CODE_ADDRESSES: readonly number[] = [
  0x917f8, 0x91828, 0x91854, 0x91888, 0x91894, 0x918b0, 0x918bc, 0x918d0, 0x9191c, 0x91950, 0x91958,
  0x91990, 0x9199c, 0x919bc, 0x919f4, 0x91a40, 0x91a60, 0x91aa4, 0x91ad8, 0x91af8, 0x91b18,
];

export interface CheatCode {
  address: number;
  /** the bytes as stored (Latin-1) */
  stored: string;
  /** what the player types: each byte XOR 0x1a */
  typed: string;
}

/**
 * @mw2data cheatCodes 0x000917f8
 * @fidelity exact
 */
export function readCheatCodes(exe: ExeImage): CheatCode[] {
  return CHEAT_CODE_ADDRESSES.map((address) => {
    const stored = exe.cstrAt(address);
    let typed = '';
    for (let i = 0; i < stored.length; i++) typed += String.fromCharCode(stored.charCodeAt(i) ^ CHEAT_XOR);
    return { address, stored, typed };
  });
}

/**
 * Whether the last keystrokes spell a stored code. `keys` holds the recent
 * keystrokes oldest first; its last element is the newest (the byte at
 * 0x152992 in the original, the end of the fourteen-key ring). An empty code
 * matches.
 *
 * @mw2 cheat_match 0x00045720
 * @fidelity exact
 * @divergence takes the ring as an array; the original reads the global buffer, and reads before its start for a code longer than it
 */
export function cheatMatch(stored: string, keys: ArrayLike<number>): boolean {
  let k = keys.length - 1;
  for (let i = stored.length - 1; i >= 0; i--, k--) {
    const key = k >= 0 ? keys[k]! : -1;
    if (key !== (stored.charCodeAt(i) ^ CHEAT_XOR)) return false;
  }
  return true;
}
