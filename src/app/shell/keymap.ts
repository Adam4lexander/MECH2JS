/**
 * The browser's keys as the shell's getch sees them: the keyboard
 * controller's set-1 scancode, through main's int 9 handler (keyboard_isr:
 * every 0xE0/0xE1-prefixed key and Ctrl are dropped - the grey cursor block,
 * keypad Enter and the right-hand Ctrl and Alt never reach the BIOS), then
 * the BIOS's translation into its buffer: ASCII for a character, 0 and the
 * scan code for a function, Alt or keypad-cursor key.
 *
 * @portOnly the PC keyboard and BIOS under the shell
 */
import { scancodesFor } from '../hostInput.ts';

/** The BIOS buffer entry for a key press, or null when nothing reaches it. */
export function biosKey(e: KeyboardEvent): { ascii: number; scan: number } | null {
  const seq = scancodesFor(e.code, true);
  if (!seq || seq.length === 0) return null;
  // keyboard_isr: E0 / E1 sequences and Ctrl (0x1d) never reach the BIOS
  if (seq[0] === 0xe0 || seq[0] === 0xe1 || seq[0] === 0x1d) return null;
  const scan = seq[0]!;
  // shift keys, Alt and the lock keys only change the BIOS's state
  if ([0x2a, 0x36, 0x38, 0x3a, 0x45, 0x46].includes(scan)) return null;
  if (e.altKey) return { ascii: 0, scan };
  if (scan >= 0x3b && scan <= 0x44) return { ascii: 0, scan }; // F1..F10
  if (scan === 0x57 || scan === 0x58) return null; // F11, F12: not in the old BIOS read getch uses
  if (e.code.startsWith('Numpad') && e.key.length !== 1) return { ascii: 0, scan }; // Num Lock off: cursor keys
  switch (scan) {
    case 0x01:
      return { ascii: 0x1b, scan };
    case 0x1c:
      return { ascii: 0x0d, scan };
    case 0x0e:
      return { ascii: 0x08, scan };
    case 0x0f:
      return { ascii: 0x09, scan };
  }
  if (e.key.length === 1) {
    const c = e.key.charCodeAt(0);
    if (c < 0x100) return { ascii: c, scan };
  }
  return null;
}
