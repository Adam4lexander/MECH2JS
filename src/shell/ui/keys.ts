/**
 * The shell's keyboard: a 0x110-byte input object whose first dword is the
 * last key read - ASCII, or 0x8000 | the scan code for an extended key -
 * filled by input_poll_key through kbhit / getch
 * (decompiled/mw2shell/src/screens/shell_2a5e0_part1.c). The keys come from
 * the BIOS buffer, behind main's int 9 handler (keyboard_isr), which drops
 * the E0/E1-prefixed keys and Ctrl: the host's key mapping (app/shell)
 * reproduces that filter.
 */
import { getch, kbhit } from '../host/hardware.ts';

/** @portOnly the 0x110-byte input object */
export class KeyInput {
  /** +0x000 the key read */
  key = 0;
  /** +0x004 */
  field4 = 0;
  /** +0x008 */
  field8 = 0x100;
  /** +0x00c a string copied from 0x76a44 */
  text = '';
  /** +0x10c 1 when the last poll read a key */
  arrived = 0;
}

/**
 * Builds the input object and drains the keyboard.
 *
 * @mw2shell input_init 0x0002a5e0
 * @fidelity exact
 */
export function inputInit(k: KeyInput): KeyInput {
  k.key = 0;
  k.field4 = 0;
  k.field8 = 0x100;
  k.text = '';
  while (kbhit()) getch();
  k.key = 0;
  return k;
}

/**
 * Reads one key: 0 when none is waiting; else ASCII, or 0x8000 | the scan
 * code after a 0. Returns 3 for Esc, 1 for any other key, 0 for none.
 *
 * @mw2shell input_poll_key 0x0002a6f0
 * @fidelity exact
 */
export function inputPollKey(k: KeyInput): number {
  if (!kbhit()) {
    k.key = 0;
    k.arrived = 0;
    return 0;
  }
  k.key = 0;
  const c = getch();
  if (c === 0) {
    k.key |= 0x8000;
    k.key |= getch();
  } else k.key = c;
  k.arrived = 1;
  return k.key === 0x1b ? 3 : 1;
}
