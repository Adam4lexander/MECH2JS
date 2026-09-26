/**
 * What system_error (0x4ad30) does with each SYSERR code. It switches on the
 * code through a jump table, and the switch is read from the instructions
 * rather than assumed: the bound from `cmp eax, imm8` at 0x4ad3d (codes
 * above it, unsigned, take `ja` to the silent return) and the table address
 * from `jmp dword ptr cs:[eax*4 + disp32]` at 0x4ad46. Every entry lands on
 * one of four paths (disassembly 0x4ad4e..0x4adcd):
 *
 *   0x4ad4e  warning  system_error_report with the '- warning' title, return
 *   0x4ad74  fatal    tears the game down (stream_seen_clear ...
 *                     realmode_selectors_free), then falls into the path below
 *   0x4ad97  fatalEarly  video shutdown only, system_error_report with the
 *                     '- fatal error' title, then exit with the code
 *   0x4adca  silent   return without reporting
 *
 * The text is not in the executable: system_error_report looks the code up
 * as "%02X" in MW2.INI [SystemError] (data/config/ini.ts systemErrorText).
 */
import type { ExeImage } from '../ExeImage.ts';

export const SYSTEM_ERROR_CMP = 0x4ad3d;
export const SYSTEM_ERROR_JMP = 0x4ad46;

export type SystemErrorSeverity = 'warning' | 'fatal' | 'fatalEarly' | 'silent';

/** The four jump targets inside system_error, and what each does. */
export const SYSTEM_ERROR_PATHS: ReadonlyMap<number, SystemErrorSeverity> = new Map([
  [0x4ad4e, 'warning'],
  [0x4ad74, 'fatal'],
  [0x4ad97, 'fatalEarly'],
  [0x4adca, 'silent'],
]);

export interface SystemErrorTable {
  /** the jump table's address, from the jmp's displacement (0x4abe0) */
  table: number;
  /** the highest code the table covers, from the cmp (0x53) */
  bound: number;
  /** severity per code 0..bound */
  severity: SystemErrorSeverity[];
}

/**
 * @mw2data systemErrorJumpTable 0x0004abe0
 * @fidelity exact
 */
export function readSystemErrorTable(exe: ExeImage): SystemErrorTable {
  if (exe.u8(SYSTEM_ERROR_CMP) !== 0x83 || exe.u8(SYSTEM_ERROR_CMP + 1) !== 0xf8) throw new Error('system_error: no cmp eax, imm8 at 0x4ad3d');
  if (exe.u32(SYSTEM_ERROR_JMP) !== 0x8524ff2e) throw new Error('system_error: no jmp cs:[eax*4 + disp32] at 0x4ad46');
  const bound = exe.u8(SYSTEM_ERROR_CMP + 2);
  const table = exe.u32(SYSTEM_ERROR_JMP + 4);
  const severity: SystemErrorSeverity[] = [];
  for (let code = 0; code <= bound; code++) {
    const target = exe.u32(table + code * 4);
    const s = SYSTEM_ERROR_PATHS.get(target);
    if (!s) throw new Error(`system_error: code 0x${code.toString(16)} jumps to 0x${target.toString(16)}, not one of the four paths`);
    severity.push(s);
  }
  return { table, bound, severity };
}

/** The severity of any code: above the bound (unsigned) is the silent return. @portOnly */
export function systemErrorSeverity(t: SystemErrorTable, code: number): SystemErrorSeverity {
  const c = code >>> 0;
  return c > t.bound ? 'silent' : t.severity[c]!;
}
