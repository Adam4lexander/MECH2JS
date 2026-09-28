/**
 * The CD's 'keating' directory: the training instructor's voice lines
 * (TRN1_01S.SFL ...; SFLX sound files, 51 of them, 2.6 MB). main scans it at
 * start-up into a small name set; a mission objective's announcement then
 * loads '<sound name>.sfl' from it when the name is there. The objectives of
 * the training missions name these (trn1_01S ...), which MW2.PRJ does not
 * hold, so without the directory the instructor says nothing.
 * decompiled/mw2/src/project/project_entry.c.
 *
 * The decompilation long read this as a development directory that never
 * ships; the letter in front of it is the CD drive's (cd_drive_index,
 * which boot_load_launch_anims uses for the CD too), and the directory is on
 * the CD.
 */
import { systemError } from '../core/systemError.ts';
import { registerGlobals } from '../engine/globals.ts';
import { cdDriveLetter, dosFileLoad, dosFindFiles } from '../engine/dosFiles.ts';

const ENTRIES_MAX = 200;

export const devDir = registerGlobals(
  'devDir',
  {
    /** devDirPath: 'D:keating' (the CD drive's letter, then 'keating'); 'keating' with no CD */
    devDirPath: '',
    /** devDirEntries / devDirBuckets: the names found there, case-insensitive (lower-cased keys) */
    entries: new Map<string, string>(),
  },
  () => {
    devDir.devDirPath = '';
    devDir.entries = new Map();
  },
);

/**
 * Looks a file name up in the scanned set, case-insensitively; adds it when
 * `add` is set (system_error 0x23 past 200 entries). Returns the entry's
 * name, or null on a miss that does not add.
 *
 * @mw2 project_add_entry 0x0001a850
 * @fidelity exact
 * @divergence the 101-bucket hash chains are a Map: the lookup's result is the same
 */
export function projectAddEntry(name: string, add: number): string | null {
  const key = name.toLowerCase();
  const found = devDir.entries.get(key);
  if (found !== undefined) return found;
  if (add === 0) return null;
  if (ENTRIES_MAX - 1 < devDir.entries.size) systemError(0x23, 'Too many project file entries');
  devDir.entries.set(key, name);
  return name;
}

/**
 * main's start-up: devDirPath = '<CD drive>:' + 'keating' ('%s%s', 0x902b0),
 * and every file found there registered with project_add_entry.
 *
 * @mw2 project_scan_dev_dir 0x0001a930
 * @fidelity exact
 * @divergence the directory is read through the host, which lists and fetches it off the CD ahead of the mission (dosFilePrefetchDir)
 */
export function projectScanDevDir(): void {
  const letter = cdDriveLetter();
  // 0x902a8 'keating'
  devDir.devDirPath = `${letter ? `${letter}:` : ''}keating`;
  for (const name of dosFindFiles(`${devDir.devDirPath}\\*.*`)) projectAddEntry(name, 1);
}

/**
 * Loads '<name>.sfl' (0x902b8 '.sfl') from devDirPath when the scan found it
 * there, else null. The mission-result announcements attach it to their
 * voice line, which plays it in place of a SNDS resource.
 *
 * @mw2 dev_dir_load_sfl 0x0001a9b0
 * @fidelity exact
 */
export function devDirLoadSfl(name: string): Uint8Array | null {
  const file = `${name}.sfl`;
  if (projectAddEntry(file, 0) === null) return null;
  return dosFileLoad(`${devDir.devDirPath}\\${file}`);
}
