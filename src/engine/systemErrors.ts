/**
 * system_error: reports SYSERR codes the way MW2.EXE does. The severity of
 * each code comes from the executable's own jump table (warning: print and
 * carry on; FATAL: print and exit; silent), the text from MW2.INI
 * [SystemError]. A FATAL code throws SystemErrorFatal - the port's stand-in
 * for exiting the process - so the host can stop the mission and show it.
 */
import { SystemErrorFatal, setSystemErrorHandler } from '../core/systemError.ts';
import { warn } from '../core/log.ts';
import type { ExeImage } from '../data/exe/ExeImage.ts';
import { readSystemErrorTable, systemErrorSeverity } from '../data/exe/tables/systemErrors.ts';
import type { IniFile } from '../data/config/ini.ts';
import { systemErrorText } from '../data/config/ini.ts';

export interface ReportedError {
  code: number;
  severity: string;
  text: string;
  detail: string | undefined;
}

const listeners = new Set<(e: ReportedError) => void>();
export function onSystemError(fn: (e: ReportedError) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * @mw2 system_error 0x0004ad30
 * @fidelity partial
 * @divergence a FATAL code throws SystemErrorFatal instead of tearing the game down and exiting
 */
export function installSystemErrorHandler(exe: ExeImage, ini: IniFile | null): void {
  const table = readSystemErrorTable(exe);
  setSystemErrorHandler((code, detail) => {
    const severity = systemErrorSeverity(table, code);
    if (severity === 'silent') return;
    const text = ini ? systemErrorText(ini, code) : '';
    const e: ReportedError = { code, severity, text, detail };
    for (const l of listeners) l(e);
    const line = `SYSERR 0x${code.toString(16).padStart(2, '0')} ${text || '?'}${detail ? ` (${detail})` : ''}`;
    warn('system_error', `MW2.EXE - ${severity === 'warning' ? 'warning' : 'fatal error'}: ${line}`);
    if (severity !== 'warning') throw new SystemErrorFatal(code, line);
  });
}
