/**
 * system_error's call surface, available to every layer.
 *
 * The original switches on the code through a jump table (0x4abe0): about a
 * third of the codes are WARNINGS that print and return, most are FATAL and
 * exit, a few are silent (see listing/system_errors.txt). Which is which is
 * read from the executable by engine/systemErrors.ts, which installs the
 * handler; until then every code is reported as a warning.
 *
 * @portOnly dispatch hook; the ported function is engine/systemErrors.ts
 */

import { warn } from './log.ts';

export type SystemErrorHandler = (code: number, detail?: string) => void;

/** Thrown for a FATAL code - the original exits the process. */
export class SystemErrorFatal extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = 'SystemErrorFatal';
  }
}

let handler: SystemErrorHandler = (code, detail) => {
  warn('system_error', `0x${code.toString(16)}${detail ? ': ' + detail : ''}`);
};

export function setSystemErrorHandler(h: SystemErrorHandler): void {
  handler = h;
}

/** Report SYSERR `code`. Returns for warnings and silent codes; throws SystemErrorFatal for fatal ones. */
export function systemError(code: number, detail?: string): void {
  handler(code, detail);
}
