/**
 * The install directory as the original's fopen and file_load see it: files
 * addressed by DOS paths relative to the game directory ("input.map",
 * "giddi\keyboard.dll"), case-insensitively. The host reads them before a
 * load (app/gameData.ts, test/support) and hands them over as a map keyed by
 * the upper-cased path with '/' separators; nothing here touches a disk.
 *
 * @portOnly the C runtime's file access, over an in-memory copy of the install
 */
import { registerGlobals } from './globals.ts';

export const dosFiles = registerGlobals(
  'dosFiles',
  {
    files: new Map<string, Uint8Array>(),
  },
  () => {
    // the install does not change with a mission load; the map is kept
  },
);

/** @portOnly */
export function setDosFiles(files: Map<string, Uint8Array>): void {
  dosFiles.files = files;
}

/** @portOnly the key a DOS path is stored under */
export function dosPathKey(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').toUpperCase();
}

/**
 * The whole file, or null when it does not exist - what file_load returns
 * (a malloc'd copy, or 0).
 *
 * @portOnly the result of file_load / fopen+fread on the install
 */
export function dosFileLoad(path: string): Uint8Array | null {
  return dosFiles.files.get(dosPathKey(path)) ?? null;
}

/**
 * A text file opened for reading, line by line - fopen(name, "r") and the
 * fgets calls on it. Text mode drops the '\r' of each CRLF.
 *
 * @portOnly the C runtime's text stream
 */
export class DosTextFile {
  private pos = 0;
  constructor(private readonly bytes: Uint8Array) {}

  /** fgets(buf, n, f): up to n - 1 characters, keeping the '\n'; null at end of file */
  fgets(n: number): string | null {
    if (this.pos >= this.bytes.length) return null;
    let s = '';
    while (this.pos < this.bytes.length && s.length < n - 1) {
      const c = this.bytes[this.pos++]!;
      if (c === 0x0d) continue;
      s += String.fromCharCode(c);
      if (c === 0x0a) break;
    }
    return s;
  }
}

/** @portOnly fopen(path, "r"), or null */
export function dosFopen(path: string): DosTextFile | null {
  const b = dosFileLoad(path);
  return b ? new DosTextFile(b) : null;
}
