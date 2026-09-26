/**
 * The player commands: commandNames, 153 packed 5-byte {char *name; byte id}
 * records at 0x9dca4. input_load_gamekeys (0x484e0) reads GAMEKEY.MAP lines
 * '<COMMAND> <key>', finds the command here with stricmp over its 0x99
 * records and stores the id in the per-key byte table at 0x9dfa1; the id is
 * what command_execute and the other command handlers switch on. Several
 * names can share an id.
 */
import type { ExeImage } from '../ExeImage.ts';

export const COMMAND_NAMES = 0x9dca4;
export const COMMAND_COUNT = 0x99;
export const COMMAND_STRIDE = 5;

export interface CommandName {
  name: string;
  id: number;
}

/**
 * @mw2data commandNames 0x0009dca4
 * @fidelity exact
 */
export function readCommandNames(exe: ExeImage): CommandName[] {
  const out: CommandName[] = [];
  for (let i = 0; i < COMMAND_COUNT; i++) {
    const a = COMMAND_NAMES + i * COMMAND_STRIDE;
    out.push({ name: exe.strPtr(a) ?? '', id: exe.u8(a + 4) });
  }
  return out;
}
